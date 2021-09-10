import {promises as fsPromises} from 'fs';
import path from 'path';
import {DownloaderState} from "./state";
import {SendFunction, Streamer} from "../util/streamer";
import {downloadAll} from "../downloading/downloaders";
import DBSourceGroup from "../database/entities/db-source-group";
import {forGen} from "../util/generator-util";
import {isTest} from "./config";
import DBDownload, {DownloadSubscriber} from "../database/entities/db-download";
import {baseDownloadDir} from "./paths";
import {RMDStatus} from "../../shared/state-interfaces";
import {disposeRedditAPI} from "../reddit/snoo";
import {sendError} from "./notifications";


let streamer: Streamer<DownloaderState> |null;
let trackerTimer: any;

/**
 * Start scanning for new Posts, and also downloaing them.
 * Launches the process in a detatched Promise, and returns instantly so callers can reference the new state.
 * @param progressCallback
 */
export function scanAndDownload(progressCallback: SendFunction) {
    let state = getCurrentState();

    if (state.isRunning()) {
        throw Error('Unable to start a second scan before the first finishes.');
    }
    console.debug("Starting scan & download!")
    state.currentState = RMDStatus.RUNNING;
    state.shouldStop = false;

    streamer?.setSender(progressCallback);

    DownloadSubscriber.toggle(true);
    disposeRedditAPI();

    clearInterval(trackerTimer);
    trackerTimer = setInterval(() => {
        DBDownload.createQueryBuilder('dl')
            .leftJoinAndSelect('dl.url', 'url')
            .where("url.processed = :processed", {processed: false})
            .getCount()
            .then(res => {
                state.downloadsInQueue = res;
            })
    }, 3000);

    return Promise
        .all([
            scanAll(state).then(() => DownloadSubscriber.toggle(false)), // Scan all, then turn off the (blocking) subscriber.
            downloadAll(state)  // Concurrently download existing posts, and new posts from the Subscriber.
        ])
        .then(async () => removeEmptyDirectories(await baseDownloadDir()))
        .catch(err => {
            console.error(err);
            sendError(err);
        }).finally(() => {
            state.currentState = RMDStatus.FINISHED;
            state.currentSource = null;
            state.stop();
            state.downloadsInQueue = 0;
            clearInterval(trackerTimer);

            for (let i=0; i<state.activeDownloads.length; i++) {
                state.activeDownloads[i] = null;
            }
            console.log('== Scan & Download Finished ==');
        });
}

/**
 * Scan and save all Posts from all Source Groups.
 */
async function scanAll(state: DownloaderState) {
    const groups = await DBSourceGroup.find();  // TODO: Potentially allow 'specific source groups only'.
    let found = 0;

    state.finishedScanning = false;
    state.newPostsScanned = 0;

    for (const g of groups) {
        try {
            found = await forGen(g.getPostGenerator(state), async (ele, idx, stop) => {
                await ele.save();
                if (state.shouldStop) {
                    console.debug('Early exit from scan, due to state flag.')
                    return stop();
                }
                state.newPostsScanned++;

                if (isTest() && state.newPostsScanned % 10 === 0) {
                    console.debug(`Scanned ${state.newPostsScanned} posts so far...`)
                }
            });
        } catch (err) {
            console.error('Error scanning group:', err);
            sendError(err);
        }

        if (state.shouldStop) break;

        console.log(`Finished scanning group "${g.name}-${g.id}". Found ${found} new posts.`);
    }

    state.finishedScanning = true;
    state.currentSource = null;
}

export function getCurrentState() {
    if (!streamer) streamer = new Streamer(new DownloaderState());

    return streamer.state;
}


/**
 * Recursively removes empty directories from the given directory.
 *
 * If the directory itself is empty, it is also removed.
 *
 * Code taken from: https://gist.github.com/jakub-g/5903dc7e4028133704a4
 *
 * @param {string} directory Path to the directory to clean up
 */
async function removeEmptyDirectories(directory: string) {
    // lstat does not follow symlinks (in contrast to stat)
    const fileStats = await fsPromises.lstat(directory);
    if (!fileStats.isDirectory()) {
        return;
    }
    let fileNames = await fsPromises.readdir(directory);
    if (fileNames.length > 0) {
        const recursiveRemovalPromises = fileNames.map(
            (fileName) => removeEmptyDirectories(path.join(directory, fileName)),
        );
        await Promise.all(recursiveRemovalPromises);

        // re-evaluate fileNames; after deleting subdirectory
        // we may have parent directory empty now
        fileNames = await fsPromises.readdir(directory);
    }

    if (fileNames.length === 0) {
        if (isTest()) console.log('Removing empty directory: ', directory);
        await fsPromises.rmdir(directory);
    }
}
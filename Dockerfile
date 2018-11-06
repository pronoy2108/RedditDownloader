FROM python:3.7

WORKDIR ./rmd/

ADD classes ./classes
ADD tests ./tests
ADD web ./web
ADD docs ./docs
ADD main.py ./
ADD requirements.txt ./



RUN mkdir ./settings/

RUN pip install -r ./requirements.txt
RUN python -V

ENTRYPOINT [ "python", "-u", "./main.py", "--settings", "./settings/settings.json"]

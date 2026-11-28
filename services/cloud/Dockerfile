# FMS cloud services on Django (core API, ingest API, background worker).
# Build context: services/cloud
#   docker build -t fms-cloud services/cloud
# The role is chosen at run time with FMS_SERVICE=core|ingest|worker.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DJANGO_SETTINGS_MODULE=fms_cloud.settings

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY manage.py gunicorn.conf.py docker-entrypoint.sh ./
COPY fms_cloud ./fms_cloud

RUN groupadd --system --gid 10001 fms \
    && useradd --system --uid 10001 --gid fms --home-dir /app --no-create-home fms \
    && chmod +x docker-entrypoint.sh \
    && mkdir -p /app/exports /tmp/prometheus && chown -R fms:fms /app /tmp/prometheus
USER 10001

ENV FMS_SERVICE=core \
    PORT=8080 \
    WEB_CONCURRENCY=2 \
    GUNICORN_THREADS=32

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"METRICS_PORT\") if os.environ.get(\"FMS_SERVICE\")==\"worker\" else os.environ.get(\"PORT\",\"8080\")}/readyz', timeout=2)"

ENTRYPOINT ["./docker-entrypoint.sh"]

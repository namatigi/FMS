# Build context: services/analytics
#   docker build -t fms-analytics services/analytics
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY fms_analytics ./fms_analytics
COPY config ./config
COPY migrations ./migrations
COPY scripts ./scripts

RUN groupadd --system --gid 10001 fms \
    && useradd --system --uid 10001 --gid fms --home-dir /app --no-create-home fms \
    && chown -R fms:fms /app
USER 10001

ENV PORT=8090 \
    WEB_CONCURRENCY=2 \
    LOG_LEVEL=INFO \
    MODELS_CONFIG=/app/config/models.yaml \
    PRICING_CONFIG=/app/config/pricing_defaults.yaml \
    MODELS_PYTHONPATH=/models

EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8090\")}/healthz', timeout=2)"

# Workers: WEB_CONCURRENCY (each worker has its own forecast cache and DB pool).
CMD ["python", "-m", "fms_analytics"]

"""Prometheus metrics."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

HTTP_REQUESTS = Counter("analytics_http_requests_total", "HTTP requests", ["method", "route", "status"])
HTTP_LATENCY = Histogram(
    "analytics_http_request_duration_seconds", "HTTP request latency", ["method", "route"]
)
FORECAST_CACHE = Counter("analytics_forecast_cache_total", "Forecast cache lookups", ["result"])
FORECAST_FIT_SECONDS = Histogram("analytics_forecast_fit_seconds", "Forecast model fit time", ["model"])
MODEL_PREDICTIONS = Counter(
    "analytics_model_predictions_total", "Custom model predictions", ["model", "outcome"]
)
MODEL_LATENCY = Histogram(
    "analytics_model_prediction_seconds",
    "Custom model prediction latency",
    ["model"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)
MODELS_LOADED = Gauge("analytics_models_registered", "Registered custom models", ["model", "status"])

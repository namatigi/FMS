"""The worker serves no API; its health/metrics endpoints run inside `manage.py fms_worker`."""

from django.urls import include, path

from .common import health

urlpatterns = [path("", include(health.urlpatterns))]

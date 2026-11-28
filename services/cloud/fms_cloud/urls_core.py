from django.urls import include, path

from .common import health
from .core.api import api

handler404 = "fms_cloud.common.middleware.not_found_view"
handler500 = "fms_cloud.common.middleware.server_error_view"

urlpatterns = [
    path("", include(health.urlpatterns)),
    path("api/", api.urls),
]

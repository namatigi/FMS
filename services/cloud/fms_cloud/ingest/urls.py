"""ingest-api routes (port of services/ingest-api/src/app.ts)."""

from django.urls import path

from . import views

urlpatterns = [
    path("ingest/pts", views.pts_upload),
    path("ingest/v1/edge/batches", views.edge_batches),
]

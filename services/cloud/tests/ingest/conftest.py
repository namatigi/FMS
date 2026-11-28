"""ingest-api fixtures: a freshly configured ingest app per test (as helpers.ts setup() did per file)."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def ingest_app():
    """Rate limiting off, 60 s ref-data TTL, 120 s rollup debounce (helpers.ts loadConfig overrides)."""
    from fms_cloud.ingest import views

    app = views.configure(rate_limit_rps=0, cache_ttl_ms=60000, rollup_delay_s=120)
    yield app
    views.configure()


@pytest.fixture
def configure_ingest():
    """Rebuild the ingest app with other config overrides inside a test."""
    from fms_cloud.ingest import views

    return views.configure

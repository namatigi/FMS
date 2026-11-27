"""``python -m fms_analytics`` - run uvicorn (PORT, WEB_CONCURRENCY, LOG_LEVEL)."""

from __future__ import annotations

import asyncio
import os
import sys

import uvicorn


def main() -> None:
    workers = int(os.environ.get("WEB_CONCURRENCY", "1"))
    loop = "auto"
    if sys.platform == "win32":
        # psycopg async needs a selector loop; let asyncio.run use our policy.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        loop = "none"
    uvicorn.run(
        "fms_analytics.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8090")),
        workers=workers,
        loop=loop,
        log_config=None,
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"),
    )


if __name__ == "__main__":
    main()

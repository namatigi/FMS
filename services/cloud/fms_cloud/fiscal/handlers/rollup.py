"""`rollup`: recompute one station-day read model. payload: {station_id, business_date}"""

from __future__ import annotations

from fms_cloud.common.db import tx

from ..core import req
from .base import HandlerContext, JobHandler


def handle(ctx: HandlerContext) -> None:
    station_id = req.uuid(ctx.job.payload, "station_id")
    date = req.date(ctx.job.payload, "business_date")
    with tx(ctx.db.alias) as c:
        # fms.rollup_station_day references its tables unqualified and has no SET search_path
        # attribute (db/migrations/003_views.sql), so pin the search_path for this transaction.
        c.execute("SET LOCAL search_path = fms, public")
        c.query("SELECT fms.rollup_station_day($1::uuid, $2::date)", [station_id, date])
    ctx.log.debug("station-day rolled up", station_id=station_id, business_date=date)


rollup_handler = JobHandler(kind="rollup", handle=handle)

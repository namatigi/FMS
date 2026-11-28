"""Durable job queue over fms.jobs (services/fiscal-worker/src/queue.ts).

Claims use FOR UPDATE SKIP LOCKED so any number of worker replicas (and threads) can poll
concurrently without contention or double-processing.
"""

from __future__ import annotations

import datetime as dt
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass, fields
from typing import Any

from fms_cloud.common.db import Conn, primary

from .core import backoff_ms, error_message, is_retryable
from .jscompat import js_dumps


@dataclass
class Job:
    id: int
    kind: str
    payload: Any
    dedupe_key: str | None
    status: str  # queued | running | done | dead
    run_at: dt.datetime
    attempts: int
    max_attempts: int
    locked_by: str | None
    locked_at: dt.datetime | None
    last_error: str | None
    created_at: dt.datetime

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in row.items() if k in names})


@dataclass
class FailOutcome:
    outcome: str  # retry | dead | lost
    run_at: dt.datetime | None = None


class JobQueue:
    def __init__(
        self, db: Conn = primary, backoff_base_ms: float = 5_000, backoff_max_ms: float = 3_600_000, rand: Callable[[], float] | None = None
    ) -> None:
        self.db = db
        self.backoff_base_ms = backoff_base_ms
        self.backoff_max_ms = backoff_max_ms
        self.rand = rand or random.random

    def enqueue(
        self,
        kind: str,
        payload: Any,
        dedupe_key: str | None = None,
        run_at: dt.datetime | None = None,
        max_attempts: int | None = None,
        client: Conn | None = None,
    ) -> int | None:
        """Insert a job; returns its id, or None if a job with the same dedupe_key already exists."""
        rows = (client or self.db).query(
            """INSERT INTO fms.jobs (kind, payload, dedupe_key, run_at, max_attempts)
       VALUES ($1, $2::jsonb, $3, coalesce($4::timestamptz, now()), coalesce($5::int, 20))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id""",
            [kind, js_dumps(payload), dedupe_key, run_at, None if max_attempts is None else int(max_attempts)],
        )
        return rows[0]["id"] if rows else None

    def claim(self, kinds: Sequence[str], limit: int, worker_id: str) -> list[Job]:
        """Atomically lease up to `limit` ready jobs of the given kinds. Increments attempts."""
        if limit <= 0 or len(kinds) == 0:
            return []
        rows = self.db.query(
            """UPDATE fms.jobs j
          SET status = 'running', locked_by = $3, locked_at = now(), attempts = j.attempts + 1
        WHERE j.id IN (
              SELECT id FROM fms.jobs
               WHERE status = 'queued' AND run_at <= now() AND kind = ANY($1)
               ORDER BY run_at
               FOR UPDATE SKIP LOCKED
               LIMIT $2)
       RETURNING j.*""",
            [list(kinds), int(limit), worker_id],
        )
        return [Job.from_row(r) for r in rows]

    def complete(self, job: Job, worker_id: str) -> bool:
        """Mark a leased job done. Returns False if the lease was lost (recovered by another worker)."""
        n = self.db.execute(
            """UPDATE fms.jobs SET status = 'done', locked_by = NULL, locked_at = NULL, last_error = NULL
        WHERE id = $1 AND status = 'running' AND locked_by = $2""",
            [job.id, worker_id],
        )
        return n == 1

    def fail(self, job: Job, worker_id: str, err: BaseException) -> FailOutcome:
        """Record a failure: re-queue with exponential backoff + jitter, or dead-letter when the
        error is non-retryable or max_attempts is reached."""
        msg = error_message(err)[:4000]
        dead = not is_retryable(err) or job.attempts >= job.max_attempts
        if dead:
            n = self.db.execute(
                """UPDATE fms.jobs SET status = 'dead', locked_by = NULL, locked_at = NULL, last_error = $3
          WHERE id = $1 AND status = 'running' AND locked_by = $2""",
                [job.id, worker_id, msg],
            )
            return FailOutcome("dead") if n == 1 else FailOutcome("lost")
        delay = backoff_ms(job.attempts, self.backoff_base_ms, self.backoff_max_ms, self.rand)
        rows = self.db.query(
            """UPDATE fms.jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, last_error = $3,
              run_at = now() + make_interval(secs => $4::double precision / 1000)
        WHERE id = $1 AND status = 'running' AND locked_by = $2
        RETURNING run_at""",
            [job.id, worker_id, msg, delay],
        )
        return FailOutcome("retry", rows[0]["run_at"]) if rows else FailOutcome("lost")

    def recover_expired_leases(self, minutes: float) -> tuple[int, list[Job]]:
        """Lease timeout recovery: jobs stuck in 'running' longer than `minutes` are re-queued, or
        dead-lettered if they already used all attempts. Returns (requeued, dead jobs)."""
        rows = self.db.query(
            """UPDATE fms.jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              last_error = coalesce(last_error || ' | ', '') || 'lease expired (worker ' || coalesce(locked_by, '?') || ')',
              locked_by = NULL, locked_at = NULL, run_at = now()
        WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)
       RETURNING *""",
            [int(minutes)],
        )
        jobs = [Job.from_row(r) for r in rows]
        return sum(1 for j in jobs if j.status == "queued"), [j for j in jobs if j.status == "dead"]

    def depth(self) -> list[dict[str, Any]]:
        """Queue depth by kind/status (metrics)."""
        rows = self.db.query(
            "SELECT kind, status, count(*)::text AS count FROM fms.jobs WHERE status IN ('queued','running','dead') GROUP BY kind, status"
        )
        return [{"kind": r["kind"], "status": r["status"], "count": int(r["count"])} for r in rows]

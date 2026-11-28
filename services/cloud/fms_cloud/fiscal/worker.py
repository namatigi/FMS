"""Job runner (services/fiscal-worker/src/worker.ts).

Each replica polls fms.jobs with SKIP LOCKED claims, runs up to `concurrency` jobs in
parallel (threads), retries with backoff and dead-letters at max_attempts.

Threads: one poll-loop thread; a pool thread per in-flight job (claim bookkeeping, complete /
fail); the handler itself runs in a further pool thread so JOB_TIMEOUT_MS can be enforced like
the TypeScript Promise.race: on timeout the job is failed and its slot freed while the handler
keeps running in the background (a later complete() then reports the lease as lost).
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures import wait as wait_futures

from django.db import close_old_connections, connections

from .core import JobError, ThreadPool, error_message
from .handlers.base import HandlerContext, JobHandler, WorkerDeps
from .jscompat import js_str
from .queue import Job


class Worker:
    def __init__(self, deps: WorkerDeps, handlers: list[JobHandler]) -> None:
        self.deps = deps
        self.handlers: dict[str, JobHandler] = {}
        for h in handlers:
            if h.kind in deps.config.kinds:
                self.handlers[h.kind] = h
        self._inflight: set[Future] = set()
        self._inflight_lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._loop: threading.Thread | None = None
        self._last_lease_check = 0.0
        self._jobs = ThreadPool("fms-job")
        self._handler_pool = ThreadPool("fms-handler")
        # Last time the poll loop completed an iteration (liveness), epoch seconds.
        self.last_loop_at = time.time()

    @property
    def kinds(self) -> list[str]:
        return list(self.handlers.keys())

    @property
    def running(self) -> bool:
        return self._loop is not None and not self._stop.is_set()

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._loop:
            return
        self._stop = threading.Event()
        self.deps.log.info("worker started", kinds=self.kinds, concurrency=self.deps.config.concurrency)
        self._loop = threading.Thread(target=self._run_safe, name="fms-worker-loop", daemon=True)
        self._loop.start()

    def stop(self, grace_ms: float | None = None) -> None:
        """Stop claiming new jobs; wait for in-flight jobs up to grace_ms."""
        grace_ms = self.deps.config.shutdown_grace_ms if grace_ms is None else grace_ms
        self._stop.set()
        self._wake.set()
        if self._loop:
            self._loop.join()
        self._loop = None
        with self._inflight_lock:
            pending = set(self._inflight)
        if pending:
            self.deps.log.info("waiting for in-flight jobs", inflight=len(pending))
            _, not_done = wait_futures(pending, timeout=grace_ms / 1000)
            if not_done:
                self.deps.log.warning("grace period elapsed; leases will be recovered by other replicas", inflight=len(not_done))
        self.deps.log.info("worker stopped")

    def _run_safe(self) -> None:
        try:
            self._run()
        except BaseException as err:  # noqa: BLE001
            self.deps.log.fatal("worker loop crashed", err=error_message(err))
        finally:
            connections.close_all()

    def _sleep(self, ms: float) -> None:
        """Interruptible sleep (stop() or a finished job wakes it)."""
        self._wake.wait(max(0, ms) / 1000)
        self._wake.clear()

    def _run(self) -> None:
        cfg = self.deps.config
        log = self.deps.log
        while not self._stop.is_set():
            self.last_loop_at = time.time()
            try:
                close_old_connections()
                self._maybe_recover_leases()
                with self._inflight_lock:
                    free = int(cfg.concurrency) - len(self._inflight)
                if free <= 0:
                    self._sleep(cfg.poll_interval_ms)
                    continue
                jobs = self.deps.queue.claim(self.kinds, min(free, int(cfg.batch_size)), cfg.worker_id)
                for job in jobs:
                    self._track(self._jobs.submit(self._process, job))
                if not jobs:
                    self._stop.wait(cfg.poll_interval_ms / 1000)
            except Exception as err:  # noqa: BLE001
                log.error("poll failed", err=error_message(err))
                self._stop.wait(max(cfg.poll_interval_ms, 2000) / 1000)

    def _track(self, f: Future) -> None:
        with self._inflight_lock:
            self._inflight.add(f)

        def done(_f: Future) -> None:
            with self._inflight_lock:
                self._inflight.discard(_f)
            self._wake.set()

        f.add_done_callback(done)

    def _maybe_recover_leases(self, force: bool = False) -> None:
        now = time.time() * 1000
        if not force and now - self._last_lease_check < self.deps.config.lease_check_interval_ms:
            return
        self._last_lease_check = now
        requeued, dead = self.deps.queue.recover_expired_leases(self.deps.config.lease_timeout_minutes)
        if requeued:
            self.deps.metrics.lease_recoveries.labels(outcome="requeued").inc(requeued)
            self.deps.log.warning("recovered expired job leases", requeued=requeued)
        for job in dead:
            self.deps.metrics.lease_recoveries.labels(outcome="dead").inc()
            self._dead_letter(job, job.last_error or "lease expired")

    # ------------------------------------------------------------ tests / CLI

    def run_once(self, limit: int | None = None) -> int:
        """Claim and process one batch. Returns the number of jobs processed."""
        limit = int(self.deps.config.batch_size) if limit is None else limit
        self._maybe_recover_leases(True)
        jobs = self.deps.queue.claim(self.kinds, limit, self.deps.config.worker_id)
        futures = [self._jobs.submit(self._process, j) for j in jobs]
        for f in futures:
            f.result()
        return len(jobs)

    def drain(self, max_rounds: int = 50) -> int:
        """Process until no job is ready."""
        total = 0
        for _ in range(max_rounds):
            n = self.run_once()
            if n == 0:
                break
            total += n
        return total

    # ------------------------------------------------------------- processing

    def _ctx(self, job: Job) -> HandlerContext:
        d = self.deps
        return HandlerContext(
            db=d.db,
            queue=d.queue,
            config=d.config,
            metrics=d.metrics,
            fiscal_client_for=d.fiscal_client_for,
            notifiers=d.notifiers,
            storage=d.storage,
            receipt_archive=d.receipt_archive,
            http=d.http,
            log=d.log.child(job_id=job.id, kind=job.kind, attempt=job.attempts),
            job=job,
        )

    def _process(self, job: Job) -> None:
        metrics, queue, cfg = self.deps.metrics, self.deps.queue, self.deps.config
        handler = self.handlers.get(job.kind)
        ctx = self._ctx(job)
        end = metrics.start_timer(job.kind)
        metrics.jobs_inflight.labels(kind=job.kind).inc()
        try:
            try:
                if not handler:
                    raise JobError(f"no handler for kind {job.kind}", False)
                f = self._handler_pool.submit(handler.handle, ctx)
                try:
                    f.result(timeout=cfg.job_timeout_ms / 1000)
                except FutureTimeout:
                    raise TimeoutError(f"job timed out after {js_str(cfg.job_timeout_ms)} ms") from None
                ok = queue.complete(job, cfg.worker_id)
                metrics.jobs_processed.labels(kind=job.kind, outcome="done" if ok else "lost").inc()
                if not ok:
                    ctx.log.warning("job lease lost before completion")
                else:
                    ctx.log.debug("job done")
            except Exception as err:  # noqa: BLE001
                try:
                    r = queue.fail(job, cfg.worker_id, err)
                    metrics.jobs_processed.labels(kind=job.kind, outcome=r.outcome).inc()
                    if r.outcome == "retry":
                        ctx.log.warning("job failed, will retry", err=error_message(err), next_run_at=r.run_at)
                    elif r.outcome == "dead":
                        self._dead_letter(job, error_message(err))
                    else:
                        ctx.log.warning("job failed but lease was lost", err=error_message(err))
                except Exception as e:  # noqa: BLE001
                    ctx.log.error("failed to record job failure (lease will expire)", err=error_message(e), cause=error_message(err))
        finally:
            end()
            metrics.jobs_inflight.labels(kind=job.kind).dec()

    def _dead_letter(self, job: Job, error: str) -> None:
        ctx = self._ctx(job)
        ctx.log.error(
            "job dead-lettered",
            error=error,
            attempts=job.attempts,
            max_attempts=job.max_attempts,
            payload=job.payload,
            dedupe_key=job.dedupe_key,
        )
        handler = self.handlers.get(job.kind)
        if not handler or not handler.on_dead:
            return
        try:
            handler.on_dead(ctx, error)
        except Exception as err:  # noqa: BLE001
            ctx.log.error("dead-letter hook failed", err=error_message(err))

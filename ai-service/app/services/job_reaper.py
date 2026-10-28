"""Recover jobs whose worker died or that were never picked up.

A job still `processing` after its lease ran out has lost its worker. If it has attempts
left it is dispatched again (the claim takes it over because the lease expired); if not, it
is failed with JOB_LEASE_EXPIRED.

A job still `pending` and never started after JOB_PENDING_REDISPATCH_SECONDS was never
delivered. It is dispatched again, with growing gaps (the Nth re-dispatch waits N times the
threshold since creation), and failed with JOB_DISPATCH_FAILED after JOB_MAX_REDISPATCHES.
The claim means a duplicate dispatch can never run a job twice.

A job back in `pending` after a retryable failure (it has started, and has attempts left) is the
dispatcher's to retry. `lease_until` on it marks when the reaper takes over if nothing has claimed
it: the reaper dispatches it again then, and after JOB_MAX_REDISPATCHES fails it with its last
error.

On a failed job, `retryable` says whether starting the same work again may help, so a job lost
to a dead worker or a dispatch that never arrived is retryable: the student can start it again.

The reaper is the only owner of both cases; the frontend does not close stuck jobs itself.
"""
import asyncio
import json
import logging
from typing import Any, Dict

from app.config import settings
from app.db.connection import UTC_NOW, execute_query
from app.services.cloud_tasks import JOB_ENDPOINTS, enqueue_job

logger = logging.getLogger(__name__)


def dispatch_data(job_type: str, input_data: Any) -> Dict[str, Any]:
    """The `data` a job endpoint expects, rebuilt from the stored input."""
    if isinstance(input_data, str):
        input_data = json.loads(input_data)
    data = input_data if isinstance(input_data, dict) else {}
    if job_type == "grade_exam":
        # The submission holds the answers; the task body carries only its id.
        return {"submissionId": data.get("submissionId")}
    return data


async def _redispatch(rows) -> int:
    sent = 0
    for job in rows:
        if job["job_type"] not in JOB_ENDPOINTS:
            continue
        try:
            await enqueue_job(
                job["id"], job["job_type"], dispatch_data(job["job_type"], job["input_data"])
            )
            sent += 1
        except Exception as exc:
            logger.error("Could not re-dispatch job %s: %s", job["id"], exc)
    return sent


async def reap_expired_jobs() -> Dict[str, int]:
    """Fail exhausted jobs, and re-dispatch jobs that lost their worker or were never claimed."""
    failed = await execute_query(
        f"""
        UPDATE processing_jobs
        SET status = 'failed',
            error_code = 'JOB_LEASE_EXPIRED',
            error_message = 'The worker running this job stopped responding.',
            retryable = TRUE,
            completed_at = {UTC_NOW},
            lease_until = NULL
        WHERE status = 'processing'
          AND (lease_until IS NULL OR lease_until < {UTC_NOW})
          AND attempt_count >= max_attempts
        RETURNING id
        """
    )
    stale = await execute_query(
        f"""
        SELECT id, job_type, input_data
        FROM processing_jobs
        WHERE status = 'processing'
          AND (lease_until IS NULL OR lease_until < {UTC_NOW})
          AND attempt_count < max_attempts
        ORDER BY created_at
        LIMIT 100
        """
    )
    redispatched = await _redispatch(stale)

    # Never-claimed pending jobs. The Nth re-dispatch is due N * threshold after creation;
    # counting it in the same UPDATE hands each re-dispatch to exactly one reaper.
    threshold = settings.JOB_PENDING_REDISPATCH_SECONDS
    due = f"""
        status = 'pending'
        AND started_at IS NULL
        AND created_at < {UTC_NOW} - make_interval(secs => $1::float8 * (dispatch_count + 1))
    """
    undelivered = await execute_query(
        f"""
        UPDATE processing_jobs
        SET status = 'failed',
            error_code = 'JOB_DISPATCH_FAILED',
            error_message = 'The job could not be started: it was dispatched ' || dispatch_count
                || ' more times and nothing picked it up.',
            retryable = TRUE,
            completed_at = {UTC_NOW}
        WHERE {due} AND dispatch_count >= $2
        RETURNING id
        """,
        threshold,
        settings.JOB_MAX_REDISPATCHES,
    )
    pending = await execute_query(
        f"""
        UPDATE processing_jobs
        SET dispatch_count = dispatch_count + 1
        WHERE id IN (
            SELECT id FROM processing_jobs
            WHERE {due} AND dispatch_count < $2
            ORDER BY created_at
            LIMIT 100
        )
        RETURNING id, job_type, input_data
        """,
        threshold,
        settings.JOB_MAX_REDISPATCHES,
    )
    pending_redispatched = await _redispatch(pending)

    # Jobs back in pending for a retry that nothing claimed by their lease_until mark (the
    # dispatcher gave up or died). The error they keep is their last attempt's.
    retry_due = f"""
        status = 'pending'
        AND started_at IS NOT NULL
        AND (lease_until IS NULL OR lease_until < {UTC_NOW})
    """
    retry_failed = await execute_query(
        f"""
        UPDATE processing_jobs
        SET status = 'failed', completed_at = {UTC_NOW}, lease_until = NULL
        WHERE {retry_due} AND dispatch_count >= $1
        RETURNING id
        """,
        settings.JOB_MAX_REDISPATCHES,
    )
    retries = await execute_query(
        f"""
        UPDATE processing_jobs
        SET dispatch_count = dispatch_count + 1,
            lease_until = {UTC_NOW} + make_interval(secs => $1::float8)
        WHERE id IN (
            SELECT id FROM processing_jobs
            WHERE {retry_due} AND dispatch_count < $2
            ORDER BY created_at
            LIMIT 100
        )
        RETURNING id, job_type, input_data
        """,
        threshold,
        settings.JOB_MAX_REDISPATCHES,
    )
    retries_redispatched = await _redispatch(retries)

    counts = {
        "failed": len(failed),
        "redispatched": redispatched,
        "pending_failed": len(undelivered),
        "pending_redispatched": pending_redispatched,
        "retry_failed": len(retry_failed),
        "retry_redispatched": retries_redispatched,
    }
    if any(counts.values()):
        logger.warning("Job reaper: %s", counts)
    return counts


async def reaper_loop() -> None:
    """Run the reaper every JOB_REAPER_INTERVAL_SECONDS until cancelled."""
    interval = settings.JOB_REAPER_INTERVAL_SECONDS
    while True:
        await asyncio.sleep(interval)
        try:
            await reap_expired_jobs()
        except Exception:
            logger.exception("Job reaper run failed")

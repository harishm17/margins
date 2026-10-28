"""Run processing jobs: claim, lease, complete or fail, and record LLM usage.

Every job endpoint is wrapped in `@job_handler`. The wrapper

1. claims the job with one atomic UPDATE, so a finished job never re-runs and a running job
   is never run twice (a second delivery gets 200 {"status": "skipped"}),
2. keeps the lease alive while the handler works, so a crashed worker's job becomes
   claimable again once the lease runs out,
3. refuses LLM-backed jobs while the AI is known to be unavailable (app/services/ai_status.py)
   or the user is over the daily budget,
4. collects LLM usage while the handler runs and stores it on the job,
5. marks the job completed, or classifies the failure and answers 400 (permanent, do not
   retry) or 5xx (transient, retry).

A job made with `wait_for_ai` (exam grading: the answers are the student's work) does not fail
while the AI is unavailable or the user's allowance is used: it goes back to `pending` at the
stage `waiting_for_ai`, without using an attempt, and the reaper sends it again once the AI is
available (or the allowance has reset). See `_defer`.

A transient failure with attempts left puts the job back to `pending`, keeping the error as its
last one, so the dispatcher's retry (or the reaper) runs it again and the one-active-job-per-target
index still covers it. `failed` is final: no worker will run the job again. On a failed job,
`retryable` says whether starting the same work again (a new job) may help.

A handler is `async def handler(payload, job: JobContext) -> JobOutcome`.
"""
import asyncio
import functools
import inspect
import json
import logging
import math
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional, Type, TypeVar

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

from app.config import settings
from app.db.connection import UTC_NOW, execute_one
from app.models.jobs import JobPayload
from app.services import ai_status
from app.services.budget import over_budget_message, record_usage_event
from app.services.content_generator.context import NoSourceMaterialError
from app.services.document_processor.chunker import NoContentError
from app.services.document_processor.storage import StorageError
from app.services.llm.base import LLMError, LLMRateLimitError, LLMUnavailableError
from app.services.llm.usage import estimate_cost_usd, summarize_usage, track_llm_usage

logger = logging.getLogger(__name__)

InputT = TypeVar("InputT", bound=BaseModel)

# How long a claim lasts before another worker may take the job over. Handlers renew it
# every third of this, so it only needs to outlast a stalled heartbeat, not the whole job.
LEASE_SECONDS = {
    "validate_material": 120,
    "chunk_material": 300,
    "extract_topics": 300,
    "profile_exam": 300,
    "exam_relevance": 300,
    "generate_content": 300,
    "generate_exam": 600,
    "grade_exam": 300,
}


class PermanentJobError(Exception):
    """A failure a retry cannot fix. The job fails, not retryable, and the call answers 400."""

    code = "JOB_FAILED"

    def __init__(self, message: str, code: Optional[str] = None):
        super().__init__(message)
        if code:
            self.code = code


class DailyBudgetExceeded(PermanentJobError):
    code = "LLM_DAILY_BUDGET"


# The stage of a job that is waiting for the AI (or the allowance) instead of failing.
WAITING_FOR_AI = "waiting_for_ai"
# How soon the reaper may look at a job that is waiting for the AI again.
AI_WAIT_RECHECK_SECONDS = 30.0


def waits_for_ai(exc: Exception) -> bool:
    """Whether this failure means "the AI cannot run now" rather than "this job is broken"."""
    if isinstance(exc, DailyBudgetExceeded):
        return True
    return isinstance(exc, LLMError) and (
        exc.code in ai_status.PROVIDER_DOWN_CODES or exc.code in ai_status.TRANSIENT_CODES
    )


def _seconds_until_reset() -> float:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    return max(1.0, (ai_status.next_reset_utc(now) - now).total_seconds())


@dataclass
class JobOutcome:
    """What a handler hands back.

    `result` is stored as the job's result_data. `response` is merged into the HTTP body.
    `after` runs once the job is marked completed (follow-up jobs); its errors are logged and
    never fail the finished job.
    """

    result: Dict[str, Any] = field(default_factory=dict)
    response: Dict[str, Any] = field(default_factory=dict)
    after: Optional[Callable[[], Awaitable[None]]] = None


@dataclass
class JobContext:
    id: str
    job_type: str
    user_id: str
    project_id: Optional[str]
    attempt: int
    max_attempts: int
    lease_seconds: float

    async def set_stage(self, stage: str, progress: Optional[int] = None) -> None:
        """Record a real phase change (one round trip; call it only at a boundary)."""
        await execute_one(
            """
            UPDATE processing_jobs
            SET stage = $3, progress_percent = COALESCE($4, progress_percent)
            WHERE id = $1 AND status = 'processing' AND attempt_count = $2
            RETURNING id
            """,
            self.id,
            self.attempt,
            stage,
            progress,
        )


def parse_input(model: Type[InputT], data: Dict[str, Any]) -> InputT:
    """Validate a job's data; bad input is permanent."""
    try:
        return model(**data)
    except ValidationError as exc:
        raise PermanentJobError(f"Invalid job input: {exc}", "INVALID_INPUT") from exc


def classify_failure(exc: Exception, default_code: str) -> tuple[str, bool, int]:
    """(error_code, retryable, HTTP status) for a failed job.

    Permanent failures answer 400 so the dispatcher does not retry them; transient
    ones answer 5xx. A rate limit or an overloaded model answers 503 with a Retry-After
    header (see retry_after): both are expected to pass, and the dispatcher retries any 5xx.
    """
    if isinstance(exc, PermanentJobError):
        return exc.code, False, 400
    if isinstance(exc, (LLMRateLimitError, LLMUnavailableError)):
        return exc.code, True, 503
    if isinstance(exc, LLMError):
        return exc.code, exc.retryable, 500 if exc.retryable else 400
    if isinstance(exc, (NoSourceMaterialError, NoContentError)):
        return exc.code, False, 400
    if isinstance(exc, StorageError):
        return "STORAGE_UNAVAILABLE", True, 500
    if isinstance(exc, HTTPException) and exc.status_code < 500:
        return default_code, False, 400
    return default_code, True, 500


# How long the dispatcher is asked to wait before it retries, when the API did not say.
_DEFAULT_RETRY_AFTER_SECONDS = {LLMRateLimitError: 20, LLMUnavailableError: 10}


def retry_after(exc: Exception) -> Optional[int]:
    """Whole seconds for the Retry-After header of a transient LLM failure, else None."""
    for error_type, default in _DEFAULT_RETRY_AFTER_SECONDS.items():
        if isinstance(exc, error_type):
            return max(1, math.ceil(exc.retry_after or default))
    return None


async def claim_job(job_id: str, lease_seconds: float, stage: Optional[str]):
    """Take the job if nobody else has it. Returns the row, or None.

    Claimable: pending (new, or back for a retry); processing with an expired lease and
    attempts left (a job that used them all is failed by the reaper, never run again). A failed
    job is final and never claimed.
    """
    return await execute_one(
        f"""
        UPDATE processing_jobs
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, {UTC_NOW}),
            lease_until = {UTC_NOW} + make_interval(secs => $2),
            stage = COALESCE($3, stage),
            progress_percent = 10,
            error_code = NULL,
            error_message = NULL,
            completed_at = NULL
        WHERE id = $1
          AND (
            status = 'pending'
            OR (
                status = 'processing'
                AND attempt_count < max_attempts
                AND (lease_until IS NULL OR lease_until < {UTC_NOW})
            )
          )
        RETURNING id, job_type, user_id, project_id, attempt_count, max_attempts
        """,
        job_id,
        float(lease_seconds),
        stage,
    )


async def _skip_reason(job_id: str) -> str:
    row = await execute_one(
        """
        SELECT status, retryable, attempt_count, max_attempts
        FROM processing_jobs WHERE id = $1
        """,
        job_id,
    )
    if row is None:
        return "Job not found"
    if row["status"] == "completed":
        return "Job already completed"
    if row["status"] == "processing":
        if row["attempt_count"] >= row["max_attempts"]:
            return "Job used all its attempts"
        return "Job is already running"
    if row["status"] == "failed":
        return "Job failed"
    return f"Job is {row['status']}"


async def _heartbeat(job: JobContext) -> None:
    """Push the lease forward while the handler runs."""
    interval = max(job.lease_seconds / 3, 0.05)
    while True:
        await asyncio.sleep(interval)
        try:
            row = await execute_one(
                f"""
                UPDATE processing_jobs
                SET lease_until = {UTC_NOW} + make_interval(secs => $3)
                WHERE id = $1 AND status = 'processing' AND attempt_count = $2
                RETURNING id
                """,
                job.id,
                job.attempt,
                float(job.lease_seconds),
            )
        except Exception as exc:  # a database blip must not kill the handler
            logger.warning("Lease renewal failed for job %s: %s", job.id, exc)
            continue
        if row is None:
            logger.warning("Job %s lost its lease; another worker may have taken it", job.id)
            return


async def _enforce_ai_ready(job: JobContext) -> None:
    """Refuse before the handler runs: the AI is known to be down, or the user is over budget.
    The refusal is typed like the failure it stands for, so it is classified the same way."""
    unavailable = (await ai_status.get_status()).as_error()
    if unavailable is not None:
        raise unavailable
    message = await over_budget_message(job.user_id)
    if message:
        raise DailyBudgetExceeded(message)


def _usage_columns(usages) -> tuple[Dict[str, object], int, int, float]:
    summary = summarize_usage(usages)
    cost = sum(c for c in (estimate_cost_usd(u) for u in usages) if c is not None)
    return (
        summary,
        int(summary["input_tokens"]) + int(summary["cache_read_input_tokens"]) + int(summary["cache_creation_input_tokens"]),
        int(summary["output_tokens"]),
        round(cost, 6),
    )


async def _record_ledger(job: JobContext, summary, input_tokens: int, output_tokens: int, cost: float) -> None:
    """Add this attempt's spend to the budget ledger, whether or not the job still holds its claim:
    the model was called and billed either way."""
    await record_usage_event(
        user_id=job.user_id,
        project_id=job.project_id,
        source="job",
        source_id=job.id,
        models=",".join(summary["models"]),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )


async def _complete(job: JobContext, outcome: JobOutcome, usages) -> None:
    summary, input_tokens, output_tokens, cost = _usage_columns(usages)
    await _record_ledger(job, summary, input_tokens, output_tokens, cost)
    result = dict(outcome.result)
    if usages:
        result["usage"] = summary
    row = await execute_one(
        f"""
        UPDATE processing_jobs
        SET status = 'completed',
            error_code = NULL,
            error_message = NULL,
            retryable = TRUE,
            progress_percent = 100,
            result_data = $3,
            completed_at = {UTC_NOW},
            lease_until = NULL,
            llm_input_tokens = llm_input_tokens + $4,
            llm_output_tokens = llm_output_tokens + $5,
            llm_cost_usd = llm_cost_usd + $6
        WHERE id = $1 AND status = 'processing' AND attempt_count = $2
        RETURNING id
        """,
        job.id,
        job.attempt,
        json.dumps(result),
        input_tokens,
        output_tokens,
        cost,
    )
    if row is None:
        logger.warning("Job %s finished but no longer holds the claim; result not recorded", job.id)


async def _fail(
    job: JobContext,
    error_code: str,
    retryable: bool,
    message: str,
    usages,
    retry_in: Optional[float] = None,
) -> Optional[str]:
    """Record a failed attempt. A retryable one with attempts left goes back to `pending` (the
    error stays as the last one); otherwise the job is `failed`, for good. Returns the new status,
    or None when the job no longer holds the claim.

    A job back in `pending` gets `lease_until` set to when the reaper should send it again if
    nothing has claimed it by then: after the dispatcher's own wait (`retry_in`) plus the pending
    re-dispatch threshold, so the reaper never races a dispatcher that is still retrying.
    """
    summary, input_tokens, output_tokens, cost = _usage_columns(usages)
    await _record_ledger(job, summary, input_tokens, output_tokens, cost)
    redispatch_after = float(retry_in or 0) + settings.JOB_PENDING_REDISPATCH_SECONDS
    row = await execute_one(
        f"""
        UPDATE processing_jobs
        SET status = CASE WHEN $5 AND attempt_count < max_attempts THEN 'pending' ELSE 'failed' END,
            error_code = $3,
            error_message = $4,
            retryable = $5,
            completed_at = CASE WHEN $5 AND attempt_count < max_attempts THEN NULL ELSE {UTC_NOW} END,
            lease_until = CASE WHEN $5 AND attempt_count < max_attempts
                THEN {UTC_NOW} + make_interval(secs => $9) ELSE NULL END,
            llm_input_tokens = llm_input_tokens + $6,
            llm_output_tokens = llm_output_tokens + $7,
            llm_cost_usd = llm_cost_usd + $8
        WHERE id = $1 AND status = 'processing' AND attempt_count = $2
        RETURNING status
        """,
        job.id,
        job.attempt,
        error_code,
        message[:2000],
        retryable,
        input_tokens,
        output_tokens,
        cost,
        redispatch_after,
    )
    return row["status"] if row else None


async def _defer(job: JobContext, exc: Exception, usages) -> bool:
    """Put a job that is waiting for the AI back in pending, giving back the attempt it used.

    The error stays as its reason. `lease_until` is when the reaper may send it again: after the
    allowance resets for LLM_DAILY_BUDGET; otherwise soon, and the reaper sends it only once the
    AI status reads available. False (and nothing changes) when the job has already waited
    JOB_AI_WAIT_MAX_SECONDS: then it fails like any other job.
    """
    summary, input_tokens, output_tokens, cost = _usage_columns(usages)
    await _record_ledger(job, summary, input_tokens, output_tokens, cost)
    budget = isinstance(exc, DailyBudgetExceeded)
    wait = _seconds_until_reset() + 60 if budget else AI_WAIT_RECHECK_SECONDS
    code = exc.code if isinstance(exc, (LLMError, PermanentJobError)) else "LLM_UNAVAILABLE"
    row = await execute_one(
        f"""
        UPDATE processing_jobs
        SET status = 'pending',
            stage = '{WAITING_FOR_AI}',
            attempt_count = attempt_count - 1,
            error_code = $3,
            error_message = $4,
            retryable = TRUE,
            progress_percent = 0,
            completed_at = NULL,
            lease_until = {UTC_NOW} + make_interval(secs => $5),
            llm_input_tokens = llm_input_tokens + $6,
            llm_output_tokens = llm_output_tokens + $7,
            llm_cost_usd = llm_cost_usd + $8
        WHERE id = $1 AND status = 'processing' AND attempt_count = $2
          AND created_at > {UTC_NOW} - make_interval(secs => $9)
        RETURNING id
        """,
        job.id,
        job.attempt,
        code,
        str(exc)[:2000],
        float(wait),
        input_tokens,
        output_tokens,
        cost,
        float(settings.JOB_AI_WAIT_MAX_SECONDS),
    )
    return row is not None


Handler = Callable[[JobPayload, JobContext], Awaitable[JobOutcome]]


def job_handler(
    *,
    job_type: str,
    label: str,
    default_error_code: str,
    stage: Optional[str] = None,
    uses_llm: bool = False,
    lease_seconds: Optional[float] = None,
    wait_for_ai: bool = False,
):
    """Wrap a job handler with claim, lease, usage tracking and failure handling.

    `job_type` picks the default lease length. `label` names the job in error messages
    ("Content generation failed: ...").
    `uses_llm` makes the handler subject to the AI status and the per-user daily budget.
    `wait_for_ai` makes it wait (see `_defer`) instead of failing when the AI cannot run.
    """

    def decorator(handler: Handler):
        @functools.wraps(handler)
        async def wrapper(payload: JobPayload):
            lease = lease_seconds if lease_seconds is not None else LEASE_SECONDS[job_type]
            row = await claim_job(payload.jobId, lease, stage)
            if row is None:
                reason = await _skip_reason(payload.jobId)
                logger.info("Skipping %s job %s: %s", job_type, payload.jobId, reason)
                return {"status": "skipped", "jobId": payload.jobId, "reason": reason}

            job = JobContext(
                id=row["id"],
                job_type=row["job_type"],
                user_id=row["user_id"],
                project_id=row["project_id"],
                attempt=row["attempt_count"],
                max_attempts=row["max_attempts"],
                lease_seconds=lease,
            )
            logger.info("Starting %s job %s (attempt %d)", job_type, job.id, job.attempt)
            heartbeat = asyncio.create_task(_heartbeat(job))
            try:
                with track_llm_usage() as usages:
                    try:
                        if uses_llm:
                            await _enforce_ai_ready(job)
                        outcome = await handler(payload, job)
                    except Exception as exc:
                        if wait_for_ai and waits_for_ai(exc) and await _defer(job, exc, usages):
                            logger.warning("%s job %s is waiting for the AI: %s", label, job.id, exc)
                            # 200: nothing for the dispatcher to retry; the reaper sends it later.
                            return {"status": "deferred", "jobId": job.id, "reason": getattr(exc, "code", None)}
                        logger.error("%s job %s failed: %s", label, job.id, exc)
                        error_code, retryable, status_code = classify_failure(exc, default_error_code)
                        wait = retry_after(exc)
                        await _fail(job, error_code, retryable, str(exc), usages, retry_in=wait)
                        raise HTTPException(
                            status_code=status_code,
                            detail=f"{label} failed: {exc}",
                            headers={"Retry-After": str(wait)} if wait else None,
                        ) from exc
                    await _complete(job, outcome, usages)
            finally:
                heartbeat.cancel()

            if outcome.after is not None:
                try:
                    await outcome.after()
                except Exception:
                    logger.exception("Follow-up work after %s job %s failed", job_type, job.id)

            logger.info("Completed %s job %s", job_type, job.id)
            return {"status": "success", "jobId": job.id, **outcome.response}

        # FastAPI builds the request model from the signature; it must see only `payload`.
        wrapper.__signature__ = inspect.Signature(
            [inspect.Parameter("payload", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=JobPayload)]
        )
        return wrapper

    return decorator


async def create_job(
    *,
    user_id: str,
    project_id: Optional[str],
    job_type: str,
    stage: str,
    input_data: Dict[str, Any],
    target_key: Optional[str],
) -> tuple[str, bool]:
    """Insert a pending job. (job id, created).

    If a job for `target_key` is already pending or processing, nothing is inserted and that
    job's id comes back with created=False.
    """
    row = await execute_one(
        f"""
        INSERT INTO processing_jobs
        (id, user_id, project_id, job_type, status, stage, input_data, progress_percent,
         target_key, created_at)
        VALUES (gen_random_uuid()::text, $1, $2, $3, 'pending', $4, $5, 0, $6, {UTC_NOW})
        ON CONFLICT DO NOTHING
        RETURNING id
        """,
        user_id,
        project_id,
        job_type,
        stage,
        json.dumps(input_data),
        target_key,
    )
    if row is not None:
        return row["id"], True
    existing = await execute_one(
        """
        SELECT id FROM processing_jobs
        WHERE target_key = $1 AND status IN ('pending', 'processing')
        ORDER BY created_at DESC LIMIT 1
        """,
        target_key,
    )
    if existing is None:
        raise RuntimeError(f"Could not create {job_type} job for {target_key}")
    return existing["id"], False

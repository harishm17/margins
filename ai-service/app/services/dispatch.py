"""Dispatch jobs to this service's own job endpoints.

Each job is posted to AI_SERVICE_URL from a background asyncio task, with the internal token
header, retrying network errors and 5xx answers. A job that is never delivered is failed with
ENQUEUE_FAILED; one that is delivered but never claimed is picked up by the reaper
(app/services/job_reaper.py).

The job endpoints answer 400 for failures a retry cannot fix and 200 {"status": "skipped"}
for jobs that were already handled, so neither is retried here.
"""
import asyncio
import logging
from typing import Any, Dict, Optional, Set

import httpx

from app.api.internal_auth import internal_headers
from app.config import settings
from app.db.connection import UTC_NOW, execute_update

logger = logging.getLogger(__name__)

DIRECT_MAX_ATTEMPTS = 3
DIRECT_TIMEOUT_SECONDS = 600.0

_background_tasks: Set["asyncio.Task[None]"] = set()


async def mark_undelivered(job_id: str, message: str) -> None:
    """The service never answered: fail the job if no handler has touched it. A job that has
    started and is pending again is waiting for a retry, which the reaper owns."""
    try:
        await execute_update(
            f"""
            UPDATE processing_jobs
            SET status = 'failed',
                error_code = 'ENQUEUE_FAILED',
                error_message = $2,
                retryable = TRUE,
                completed_at = {UTC_NOW}
            WHERE id = $1 AND status = 'pending' AND started_at IS NULL
            """,
            job_id,
            message[:1000],
        )
    except Exception as exc:
        logger.error("Could not record the dispatch failure of job %s: %s", job_id, exc)


def retry_delay_seconds(attempt: int, retry_after_header: Optional[str]) -> float:
    """Wait before the next attempt: exponential backoff, or the Retry-After the service sent
    (a rate-limited job asks for longer) if that is longer. Capped at two minutes."""
    delay = 0.5 * 2 ** (attempt - 1)
    try:
        delay = max(delay, float(retry_after_header or 0))
    except ValueError:
        pass
    return min(delay, 120.0)


async def _post_with_retries(endpoint: str, payload: Dict[str, Any]) -> None:
    job_id = payload.get("jobId", "")
    last_error = ""
    retry_after_header: Optional[str] = None
    for attempt in range(1, DIRECT_MAX_ATTEMPTS + 1):
        retry_after_header = None
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{settings.AI_SERVICE_URL}{endpoint}",
                    json=payload,
                    headers=internal_headers(),
                    timeout=DIRECT_TIMEOUT_SECONDS,
                )
            if response.status_code < 500:
                if response.status_code >= 400:
                    logger.error(
                        "Job %s rejected by %s (%s): %s",
                        job_id, endpoint, response.status_code, response.text[:500],
                    )
                return
            last_error = f"{endpoint} answered {response.status_code}: {response.text[:500]}"
            retry_after_header = response.headers.get("retry-after")
        except httpx.HTTPError as exc:
            last_error = f"{endpoint} unreachable: {exc!r}"
        logger.warning("Dispatch of job %s failed (attempt %d): %s", job_id, attempt, last_error)
        if attempt < DIRECT_MAX_ATTEMPTS:
            await asyncio.sleep(retry_delay_seconds(attempt, retry_after_header))
    await mark_undelivered(job_id, last_error)


async def enqueue_task(endpoint: str, payload: Dict[str, Any]) -> str:
    """Hand a job to the job endpoint. Returns a task id.

    Returns at once; the post runs in the background.
    """
    task = asyncio.create_task(_post_with_retries(endpoint, payload))
    # The loop keeps only weak references to tasks.
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return f"direct-task-{payload.get('jobId', '')}"


async def wait_for_background_tasks() -> None:
    """Wait for direct dispatches in flight (tests, shutdown)."""
    while _background_tasks:
        await asyncio.gather(*list(_background_tasks), return_exceptions=True)


JOB_ENDPOINTS = {
    "validate_material": "/jobs/validate-material",
    "chunk_material": "/jobs/chunk-material",
    "extract_topics": "/jobs/extract-topics",
    "profile_exam": "/jobs/profile-exam",
    "exam_relevance": "/jobs/exam-relevance",
    "generate_content": "/jobs/generate-content",
    "generate_exam": "/jobs/generate-exam",
    "grade_exam": "/jobs/grade-exam",
}


async def enqueue_job(job_id: str, job_type: str, data: Dict[str, Any]) -> str:
    """Dispatch any job type by name."""
    return await enqueue_task(
        JOB_ENDPOINTS[job_type], {"jobId": job_id, "jobType": job_type, "data": data}
    )


async def enqueue_chunking_job(job_id: str, material_id: str) -> str:
    return await enqueue_job(job_id, "chunk_material", {"materialId": material_id})


async def enqueue_topic_extraction_job(job_id: str, project_id: str) -> str:
    return await enqueue_job(job_id, "extract_topics", {"projectId": project_id})


async def enqueue_exam_profile_job(job_id: str, material_id: str) -> str:
    return await enqueue_job(job_id, "profile_exam", {"materialId": material_id})


async def enqueue_exam_relevance_job(job_id: str, project_id: str) -> str:
    return await enqueue_job(job_id, "exam_relevance", {"projectId": project_id})

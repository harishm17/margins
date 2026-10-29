"""Queue a topic's missing study content one job at a time, and whole courses one topic at a time.

Content is generated on demand. Opening a topic with no notes starts one notes job; when it
finishes, the rest of the topic's types (worked examples, practice, quiz) are queued here, each
one only after the previous one has finished, so they are ready by the time the student gets to
them and no more than one job per topic is ever running. The chain lives on the server (in the
completion path of the generate-content job) so it keeps going when the student closes the tab.

A job carries the chain in its preferences:

- `prepare_rest`: when this job is done, queue the topic's next missing type with the same flag.
- `prepare_all` ("Prepare all topics now"): when the topic has nothing left to generate, go on to
  the next topic in course order that is missing something. At most one topic is in flight per
  project, because each job queues the next only after it has finished.

The chain stops at the first failure (the failed job is shown with its Try again button as usual),
and when the daily AI allowance is used up. The one exception is a topic that cannot be generated
at all (no source material, or the model refuses it): a `prepare_all` run skips it and goes on.
"""
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.db.connection import execute_one, execute_query
from app.services import ai_status
from app.services.budget import over_budget_message
from app.services.dispatch import enqueue_job, mark_undelivered
from app.services.job_runner import create_job

logger = logging.getLogger(__name__)

# The order a student meets them in, and so the order they are prepared in.
CONTENT_ORDER = ("section_notes", "solved_examples", "interactive_examples", "topic_quiz")
CHAIN_FLAGS = ("prepare_rest", "prepare_all")


def chain_preferences(preferences: Dict[str, Any]) -> Dict[str, Any]:
    """The flags a follow-up job inherits."""
    return {flag: True for flag in CHAIN_FLAGS if preferences.get(flag)}


def content_target(topic_id: str, content_type: str) -> str:
    """The job target key; the frontend builds the same one (generateContentTarget)."""
    return f"content:{topic_id}:{content_type}"


async def missing_content_types(topic_id: str) -> List[str]:
    """The topic's types with no stored content and no job in flight, in CONTENT_ORDER."""
    rows = await execute_query(
        """
        SELECT content_type FROM topic_content WHERE topic_id = $1
        UNION
        SELECT input_data->>'contentType'
        FROM processing_jobs
        WHERE job_type = 'generate_content'
          AND status IN ('pending', 'processing')
          AND input_data->>'topicId' = $1
        """,
        topic_id,
    )
    present = {row["content_type"] for row in rows}
    return [content_type for content_type in CONTENT_ORDER if content_type not in present]


@dataclass
class PlannedJob:
    """A generate-content job that has a row but has not been dispatched yet."""

    job_id: str
    data: Dict[str, Any]


async def _create_job(
    *, user_id: str, project_id: str, topic_id: str, content_type: str, preferences: Dict[str, Any]
) -> Optional[PlannedJob]:
    """Create one generate-content job. None when one is already active for the target."""
    data = {"topicId": topic_id, "contentType": content_type, "preferences": preferences}
    job_id, created = await create_job(
        user_id=user_id,
        project_id=project_id,
        job_type="generate_content",
        stage="generating",
        input_data=data,
        target_key=content_target(topic_id, content_type),
    )
    if not created:
        logger.info("Generation of %s for topic %s is already active (%s)", content_type, topic_id, job_id)
        return None
    return PlannedJob(job_id, data)


async def dispatch(planned: Optional[PlannedJob]) -> Optional[str]:
    """Send a planned job to the job endpoint. Returns its id, or None if nothing was sent."""
    if planned is None:
        return None
    try:
        await enqueue_job(planned.job_id, "generate_content", planned.data)
    except Exception as exc:
        logger.error("Could not dispatch generation job %s: %s", planned.job_id, exc)
        await mark_undelivered(planned.job_id, str(exc))
        return None
    logger.info(
        "Queued %s for topic %s (job %s)", planned.data["contentType"], planned.data["topicId"], planned.job_id
    )
    return planned.job_id


async def _next_topic_ids(project_id: str, after_topic_id: str) -> List[str]:
    """Confirmed topics that come after this one in course order."""
    rows = await execute_query(
        """
        SELECT id FROM topics
        WHERE project_id = $1 AND user_confirmed
        ORDER BY order_index, created_at, id
        """,
        project_id,
    )
    ids = [row["id"] for row in rows]
    return ids[ids.index(after_topic_id) + 1 :] if after_topic_id in ids else []


async def plan_next_job(
    *,
    user_id: str,
    project_id: Optional[str],
    topic_id: str,
    preferences: Dict[str, Any],
    skip_topic: bool = False,
) -> Optional[PlannedJob]:
    """Create the job that comes after a finished generate-content job, if there is one.

    The job row is created here, before the finished job is marked completed, so a page that
    sees the finish can already find the next job (the frontend follows it); `dispatch` sends it.
    `skip_topic` leaves the rest of this topic alone (it could not be generated) and moves on
    to the next topic when the run is `prepare_all`.
    """
    flags = chain_preferences(preferences)
    if not flags or not project_id:
        return None
    if await over_budget_message(user_id):
        logger.info("Stopping the generation chain for project %s: the daily allowance is used up", project_id)
        return None
    if not (await ai_status.get_status()).available:
        # The student starts the rest again once the AI is back; a queued job would only fail.
        logger.info("Stopping the generation chain for project %s: the AI is unavailable", project_id)
        return None

    if not skip_topic:
        missing = await missing_content_types(topic_id)
        if missing:
            return await _create_job(
                user_id=user_id, project_id=project_id, topic_id=topic_id,
                content_type=missing[0], preferences=flags,
            )
    if not flags.get("prepare_all"):
        return None

    for next_topic_id in await _next_topic_ids(project_id, topic_id):
        missing = await missing_content_types(next_topic_id)
        if missing:
            return await _create_job(
                user_id=user_id, project_id=project_id, topic_id=next_topic_id,
                content_type=missing[0], preferences=flags,
            )
    return None


async def continue_chain(**kwargs: Any) -> Optional[str]:
    """plan_next_job and dispatch in one step. Returns the new job's id, if any."""
    return await dispatch(await plan_next_job(**kwargs))


async def content_exists(topic_id: str, content_type: str) -> bool:
    """Whether the topic already has this type, so generating it again is a regeneration."""
    row = await execute_one(
        """
        SELECT EXISTS (
            SELECT 1 FROM topic_content WHERE topic_id = $1 AND content_type = $2
        ) OR EXISTS (
            SELECT 1 FROM topic_quizzes WHERE topic_id = $1 AND $2 = 'topic_quiz'
        ) AS present
        """,
        topic_id,
        content_type,
    )
    return bool(row and row["present"])

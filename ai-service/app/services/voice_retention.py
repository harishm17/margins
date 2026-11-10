"""Voice transcripts are kept for VOICE_RETENTION_DAYS (180) and then deleted; evidence events stay (spec 19.9).

What a student said out loud is kept in four places, and each is emptied once its session or attempt is older than the
limit:
  - voice_drill_sessions.history: the conversation with the coach, with the student's words;
  - voice_drill_sessions.coach_state: the last few things said (`said`), the guided-reading prediction, and the words kept
    per idea in teach-back (`teach.concepts.*.said`);
  - voice_drill_attempts.user_answer: the spoken answer to a quiz question;
  - recall_attempts (mode `voice`): the spoken explanation, and the quotes the grader took from it.
The session rows, the attempts and their scores, and the evidence events (which hold scores, never text) stay, so the
learner model and the history of a session do not change.

The job runs on a timer in the AI service, like the job reaper (`voice_retention_loop`, started in app/main.py), and can be
run by hand with POST /voice/retention. It is safe to run twice: a row already emptied is not touched again.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict

from app.errors import describe_exception
from app.config import settings
from app.db.connection import UTC_NOW, execute_query
from app.services import ops

logger = logging.getLogger(__name__)

# The coach state without any of the student's words. A missing key stays missing.
_SCRUBBED_COACH_STATE = """
    CASE WHEN coach_state IS NULL OR jsonb_typeof(coach_state) <> 'object' THEN coach_state ELSE
        (
            CASE WHEN jsonb_typeof(coach_state->'teach'->'concepts') = 'object' THEN
                jsonb_set(
                    coach_state - 'said',
                    '{teach,concepts}',
                    (SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object'
                                                                   THEN jsonb_set(e.value, '{said}', '[]'::jsonb)
                                                                   ELSE e.value END), '{}'::jsonb)
                     FROM jsonb_each(coach_state->'teach'->'concepts') AS e)
                )
            ELSE coach_state - 'said' END
        )
    END
"""

# Not yet scrubbed: there is something to remove.
_HAS_WORDS = """
    (
        history IS NOT NULL
        OR (jsonb_typeof(coach_state) = 'object' AND (
                coach_state ? 'said'
                OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(coach_state->'teach'->'concepts') = 'object'
                                                          THEN coach_state->'teach'->'concepts' ELSE '{}'::jsonb END) AS e
                           WHERE jsonb_typeof(e.value) = 'object' AND jsonb_array_length(COALESCE(e.value->'said', '[]'::jsonb)) > 0)
                OR coalesce(coach_state->'guided'->>'prediction', '') <> ''
        ))
    )
"""


async def purge_voice_transcripts(days: int | None = None) -> Dict[str, int]:
    """Empty the transcripts older than `days` (VOICE_RETENTION_DAYS when not given). Returns how many rows of each kind."""
    days = settings.VOICE_RETENTION_DAYS if days is None else days
    if days <= 0:
        return {"sessions": 0, "attempts": 0, "recall_attempts": 0}
    cutoff = f"{UTC_NOW} - make_interval(days => $1::int)"

    sessions = await execute_query(
        f"""
        UPDATE voice_drill_sessions
        SET history = NULL,
            coach_state = (
                CASE WHEN jsonb_typeof(coach_state->'guided') = 'object'
                     THEN jsonb_set({_SCRUBBED_COACH_STATE}, '{{guided,prediction}}', '""'::jsonb)
                     ELSE {_SCRUBBED_COACH_STATE} END
            )
        WHERE COALESCE(last_seen_at, ended_at, created_at) < {cutoff}
          AND {_HAS_WORDS}
        RETURNING id
        """,
        days,
    )
    attempts = await execute_query(
        f"""
        UPDATE voice_drill_attempts
        SET user_answer = ''
        WHERE user_answer <> '' AND created_at < {cutoff}
        RETURNING id
        """,
        days,
    )
    recalls = await execute_query(
        f"""
        UPDATE recall_attempts
        SET answer_text = '',
            result = CASE WHEN jsonb_typeof(result->'claims') = 'array'
                          THEN jsonb_set(result, '{{claims}}',
                                         (SELECT COALESCE(jsonb_agg(c - 'student_quote' - 'misconception'), '[]'::jsonb)
                                          FROM jsonb_array_elements(result->'claims') AS c))
                          ELSE result END
        WHERE mode = 'voice' AND answer_text <> '' AND created_at < {cutoff}
        RETURNING id
        """,
        days,
    )
    counts = {"sessions": len(sessions), "attempts": len(attempts), "recall_attempts": len(recalls)}
    if any(counts.values()):
        logger.info("Voice transcripts older than %s days deleted: %s", days, counts)
    return counts


async def voice_retention_loop() -> None:
    """Run the purge every VOICE_RETENTION_INTERVAL_SECONDS until cancelled, the first time a minute after start."""
    await asyncio.sleep(60)
    while True:
        try:
            await purge_voice_transcripts()
            await ops.set_state("voice_retention_last_run", datetime.now(timezone.utc).isoformat())
        except Exception as exc:
            logger.exception("Voice transcript purge failed")
            await ops.note("voice_retention_failed", describe_exception(exc))
        await asyncio.sleep(settings.VOICE_RETENTION_INTERVAL_SECONDS)

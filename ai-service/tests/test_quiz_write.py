"""A generated quiz is stored in one transaction, once per job attempt (jobs._save_generated_content)."""
import pytest

from app.api.routes import jobs
from app.services.job_runner import JobContext
from tests.db_helpers import seed_project, seed_topic, seed_user

QUESTIONS = [{"question": "What is a mean?"}]


def context(job_id: str, user_id: str, attempt: int) -> JobContext:
    return JobContext(id=job_id, job_type="generate_content", user_id=user_id, project_id=None,
                      attempt=attempt, max_attempts=3, lease_seconds=60)


async def sets(db, topic_id):
    return await db.fetchval("SELECT count(*) FROM topic_quizzes WHERE topic_id = $1", topic_id)


async def test_a_crash_between_the_steps_writes_nothing_and_a_retry_writes_one_set(db, monkeypatch):
    user_id = await seed_user(db)
    topic_id = await seed_topic(db, await seed_project(db, user_id))
    topic = {"id": topic_id}
    job = context("job-1", user_id, attempt=1)

    # The set is inserted, then the content upsert fails: the set must not survive.
    good_sql = jobs._SAVE_CONTENT_SQL
    monkeypatch.setattr(jobs, "_SAVE_CONTENT_SQL", "SELECT not_a_column FROM topic_content")
    with pytest.raises(Exception):
        await jobs._save_generated_content(job, topic, "topic_quiz", QUESTIONS, {}, False)
    assert await sets(db, topic_id) == 0
    assert await db.fetchval("SELECT count(*) FROM topic_content WHERE topic_id = $1", topic_id) == 0

    monkeypatch.setattr(jobs, "_SAVE_CONTENT_SQL", good_sql)
    metadata: dict = {}
    await jobs._save_generated_content(job, topic, "topic_quiz", QUESTIONS, metadata, False)
    assert await sets(db, topic_id) == 1

    # The same attempt run again (a redelivered job) finds its set instead of adding a second one.
    again: dict = {}
    await jobs._save_generated_content(job, topic, "topic_quiz", QUESTIONS, again, False)
    assert await sets(db, topic_id) == 1 and again["quiz_set_id"] == metadata["quiz_set_id"]

    # A later attempt is a new quiz set.
    await jobs._save_generated_content(context("job-1", user_id, attempt=2), topic, "topic_quiz", QUESTIONS, {}, False)
    assert await sets(db, topic_id) == 2

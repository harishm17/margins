"""dropped_unsupported reaches the stored metadata and the job result of the generating jobs."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.api.routes import jobs
from app.models.jobs import JobPayload
from tests.context_stub import stub_topic_context
from tests.db_helpers import get_job, seed_job, seed_project, seed_topic, seed_user
from tests.test_support_check import use
from tests.test_support_check_generators import EXAM_CHUNKS, EXAM_TOPICS, ExamProvider


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    topic_id = await seed_topic(db, project_id)
    return SimpleNamespace(user_id=user_id, project_id=project_id, topic_id=topic_id)


async def test_quiz_job_reports_dropped_unsupported(db, world):
    job_id = await seed_job(db, world.user_id, project_id=world.project_id)
    payload = JobPayload(
        jobId=job_id, jobType="generate_content",
        data={"topicId": world.topic_id, "contentType": "topic_quiz", "preferences": {"question_count": 3}},
    )
    with stub_topic_context(EXAM_CHUNKS), use(ExamProvider()):
        result = await jobs.generate_content_job(payload)

    assert result["status"] == "success"
    metadata = json.loads((await get_job(db, job_id))["result_data"])["metadata"]
    assert metadata["dropped_unsupported"] == 1
    stored = await db.fetchval("SELECT questions FROM topic_quizzes WHERE topic_id = $1", world.topic_id)
    assert len(json.loads(stored)) == 2


async def test_exam_job_reports_dropped_unsupported(db, world):
    job_id = await seed_job(db, world.user_id, project_id=world.project_id)
    payload = JobPayload(
        jobId=job_id, jobType="generate_exam",
        data={"projectId": world.project_id, "topicIds": ["t1", "t2"],
              "config": {"total_questions": 6, "question_type_distribution": {"multiple_choice": 100}}},
    )
    with patch("app.services.exam_generator.execute_query", return_value=EXAM_TOPICS), \
            stub_topic_context(EXAM_CHUNKS), use(ExamProvider()):
        result = await jobs.generate_exam_job(payload)

    assert result["status"] == "success"
    assert json.loads((await get_job(db, job_id))["result_data"])["dropped_unsupported"] == 2

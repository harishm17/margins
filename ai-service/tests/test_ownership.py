"""One user cannot reach another user's rows through any route or job (SEC-L1).

User A owns a course with a topic, unit, file, exam, submissions, a recall attempt and a voice session. User B calls every
route that takes ids, and runs every job type, with A's ids. Every call must come back as "not found" and change nothing.
A route or job type that is not in the tables below fails the enumeration tests, so a new one cannot ship unchecked.
"""
import httpx
import pytest

from app.api.routes.jobs import router as jobs_router
from app.main import app
from app.services.ownership import NotOwnedError, assert_owns
from tests.test_grading_waits import SHORT
from tests.test_tutor_practice import request as practice_request
from tests.test_tutor_reader import request as reader_request
from tests.db_helpers import get_job, new_id, seed_job, seed_material, seed_project, seed_topic, seed_user, seed_voice_session

pytestmark = [pytest.mark.asyncio, pytest.mark.real_ownership]

# Request-body fields that name a row. A route whose body has one of these, and is not in ROUTES, fails the enumeration.
ID_FIELDS = {"project_id", "topic_id", "session_id", "attempt_id", "thread_id", "material_id", "unit_id"}


class World:
    pass


@pytest.fixture
async def world(db):
    w = World()
    w.a = await seed_user(db)
    w.b = await seed_user(db)
    w.project = await seed_project(db, w.a)
    w.topic = await seed_topic(db, w.project)
    w.unit = new_id()
    await db.execute("INSERT INTO units (id, project_id, title, order_index) VALUES ($1, $2, 'U', 0)", w.unit, w.project)
    w.material = await seed_material(db, w.project)
    w.session = await seed_voice_session(db, w.a, w.project, topic_id=w.topic)
    w.exam = new_id()
    await db.execute(
        "INSERT INTO sample_exams (id, project_id, name, questions, duration_minutes, difficulty_level) "
        "VALUES ($1, $2, 'E', '[]', 30, 'medium')",
        w.exam, w.project,
    )
    w.exam_submission = new_id()
    await db.execute(
        "INSERT INTO exam_submissions (id, sample_exam_id, user_id, answers) VALUES ($1, $2, $3, '{}')",
        w.exam_submission, w.exam, w.a,
    )
    w.quiz_submission = new_id()
    await db.execute(
        "INSERT INTO quiz_submissions (id, user_id, topic_id, answers, questions, answers_hash) "
        "VALUES ($1, $2, $3, '{}', '[]', 'h')",
        w.quiz_submission, w.a, w.topic,
    )
    w.attempt = new_id()
    await db.execute(
        "INSERT INTO recall_attempts (id, user_id, topic_id, kind, prompt_text, answer_text, mode, result) "
        "VALUES ($1, $2, $3, 'topic', 'p', 'a', 'free', '{}')",
        w.attempt, w.a, w.topic,
    )
    return w


async def call(path, body):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(path, json=body)


def routes(w):
    """path -> a body that is user B asking about user A's rows."""
    base = {"user_id": w.b, "project_id": w.project}
    return {
        "/tutor/practice": {**practice_request().model_dump(mode="json"), **base},
        "/tutor/reader": {**reader_request().model_dump(mode="json"), **base},
        "/grade/quiz": {**base, "questions": [SHORT], "answers": {"0": "x"}},
        "/grade/recall": {**base, "prompt": "p", "answer": "a", "claims": [{"id": "k", "text": "t"}]},
        "/voice/generate-drill": {**base, "topic_id": w.topic, "notes": "n", "count": 3},
        "/voice/turn": {**base, "session_id": w.session, "system": "s", "messages": [{"role": "user", "content": "hi"}]},
        "/chat/answer": {**base, "topic_id": w.topic, "question": "q", "history": []},
    }


def jobs(w):
    """(path, job type, payload data) with A's ids, to be run as a job of user B."""
    return [
        ("/jobs/validate-material", "validate_material", {"materialId": w.material}),
        ("/jobs/chunk-material", "chunk_material", {"materialId": w.material}),
        ("/jobs/profile-exam", "profile_exam", {"materialId": w.material}),
        ("/jobs/exam-relevance", "exam_relevance", {"projectId": w.project}),
        ("/jobs/extract-topics", "extract_topics", {"projectId": w.project}),
        ("/jobs/generate-content", "generate_content", {"topicId": w.topic, "contentType": "notes"}),
        ("/jobs/extract-concepts", "extract_concepts", {"topicId": w.topic}),
        ("/jobs/link-concepts", "link_concepts", {"unitId": w.unit}),
        ("/jobs/generate-review-items", "generate_review_items", {"topicId": w.topic, "requests": []}),
        ("/jobs/gap-explainer", "gap_explainer", {"attemptId": w.attempt}),
        ("/jobs/generate-exam", "generate_exam", {"projectId": w.project, "topicIds": [w.topic], "config": {}}),
        ("/jobs/grade-exam", "grade_exam", {"submissionId": w.exam_submission}),
        ("/jobs/grade-quiz", "grade_quiz", {"submissionId": w.quiz_submission}),
    ]


async def test_every_route_that_takes_ids_is_in_the_table(world):
    schemas = app.openapi()["components"]["schemas"]
    found = set()
    for path, item in app.openapi()["paths"].items():
        post = item.get("post")
        ref = (((post or {}).get("requestBody") or {}).get("content", {}).get("application/json", {}).get("schema", {}) or {}).get("$ref")
        if not ref or path.startswith("/jobs/"):
            continue
        properties = schemas[ref.rsplit("/", 1)[1]].get("properties", {})
        if ID_FIELDS & set(properties):
            found.add(path)
    assert found == set(routes(world)), f"routes with ids, and the table: {sorted(found ^ set(routes(world)))}"


async def test_every_job_route_is_in_the_table(world):
    in_router = {r.path for r in jobs_router.routes if r.path.startswith("/jobs/") and r.path != "/jobs/reap"}
    assert in_router == {path for path, _, _ in jobs(world)}


@pytest.mark.parametrize("path", [
    "/tutor/practice", "/tutor/reader", "/grade/quiz", "/grade/recall", "/voice/generate-drill", "/voice/turn", "/chat/answer",
])
async def test_a_route_answers_not_found_to_another_users_ids(db, world, monkeypatch, path):
    from app.config import settings

    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    before = await db.fetchval("SELECT count(*) FROM llm_usage_events")

    response = await call(path, routes(world)[path])

    assert response.status_code == 404, response.text
    assert await db.fetchval("SELECT count(*) FROM llm_usage_events") == before


@pytest.mark.parametrize("index", range(13))
async def test_a_job_of_another_user_fails_for_good_and_touches_nothing(db, world, index):
    path, job_type, data = jobs(world)[index]
    job_id = await seed_job(db, world.b, job_type, input_data=data)
    topics_before = await db.fetchval("SELECT count(*) FROM topics")
    concepts_before = await db.fetchval("SELECT count(*) FROM concepts")

    response = await call(path, {"jobId": job_id, "jobType": job_type, "data": data})

    job = await get_job(db, job_id)
    assert response.status_code == 400, response.text
    assert job["status"] == "failed" and job["retryable"] is False
    assert job["error_code"] in {"NOT_FOUND", "MATERIAL_NOT_FOUND", "SUBMISSION_NOT_FOUND", "QUIZ_SUBMISSION_NOT_FOUND"}
    assert await db.fetchval("SELECT count(*) FROM topics") == topics_before
    assert await db.fetchval("SELECT count(*) FROM concepts") == concepts_before


async def test_assert_owns_checks_the_pair_and_each_kind(db, world):
    await assert_owns(world.a, project_id=world.project, topic_id=world.topic, session_id=world.session, attempt_id=world.attempt)
    await assert_owns(world.a, submission_id=world.exam_submission)
    await assert_owns(world.a, submission_id=world.quiz_submission, exam_id=world.exam, unit_id=world.unit, material_id=world.material)
    other_project = await seed_project(db, world.a)
    for ids in (
        {"project_id": world.project},
        {"topic_id": world.topic},
        {"session_id": world.session},
        {"attempt_id": world.attempt},
        {"submission_id": world.quiz_submission},
        {"material_id": world.material},
        {"project_id": other_project, "topic_id": world.topic},  # the topic is the user's but not in that course
    ):
        user = world.a if "project_id" in ids and "topic_id" in ids else world.b
        with pytest.raises(NotOwnedError):
            await assert_owns(user, **ids)
    with pytest.raises(NotOwnedError):
        await assert_owns(world.a)  # nothing to check is not a pass
    with pytest.raises(NotOwnedError):
        await assert_owns(world.a, topic_id="no-such-id")

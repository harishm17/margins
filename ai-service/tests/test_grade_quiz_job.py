"""A topic quiz stored while the AI was unavailable: the grade_quiz job waits like exam grading, stores a
complete grading once, and never stores a score with an ungraded answer in it."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services import job_reaper
from app.services.llm.base import LLMCreditError
from tests.db_helpers import get_job, new_id, seed_job, seed_project, seed_topic, seed_user

QUESTIONS = [
    {"question_type": "multiple_choice", "question_text": "Pick", "points": 1, "options": ["A", "B"], "correct_answer": "B"},
    {"question_type": "short_answer", "question_text": "Why?", "points": 2, "sample_answer": "x", "key_points": ["x"]},
]


@pytest.fixture
async def stored(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    topic_id = await seed_topic(db, project_id)
    submission_id = new_id()
    await db.execute(
        "INSERT INTO quiz_submissions (id, user_id, topic_id, answers, questions) VALUES ($1, $2, $3, $4, $5)",
        submission_id, user_id, topic_id, json.dumps({"0": "B", "1": "text"}), json.dumps(QUESTIONS),
    )
    return SimpleNamespace(user_id=user_id, project_id=project_id, id=submission_id)


def payload(job_id, submission_id):
    return JobPayload(jobId=job_id, jobType="grade_quiz", data={"submissionId": submission_id})


async def new_job(db, stored, **columns):
    return await seed_job(db, stored.user_id, "grade_quiz", project_id=stored.project_id,
                          input_data={"submissionId": stored.id}, **columns)


def grader(monkeypatch, behaviour):
    class Grader:
        calls = 0

        async def grade_submission(self, submission_id, questions, answers):
            Grader.calls += 1
            return behaviour()

    monkeypatch.setattr(jobs, "ExamGrader", Grader)
    return Grader


def graded(needs_review=False):
    return {
        "overall_score": 33.33, "earned_points": 1, "total_points": 3,
        "graded_questions": [
            {"question_index": 0, "points_possible": 1, "points_earned": 1, "needs_review": False},
            {"question_index": 1, "points_possible": 2, "points_earned": 0, "needs_review": needs_review},
        ],
    }


async def test_the_grading_is_stored_on_the_submission(db, stored, monkeypatch):
    grader(monkeypatch, graded)
    job_id = await new_job(db, stored)

    result = await jobs.grade_quiz_job(payload(job_id, stored.id))

    assert result["overallScore"] == 33.33
    row = await db.fetchrow("SELECT status, ai_grading, graded_at, applied_at FROM quiz_submissions WHERE id = $1", stored.id)
    assert row["status"] == "graded" and row["graded_at"] is not None
    assert json.loads(row["ai_grading"])["overall_score"] == 33.33
    # Applying it to mastery is the web app's job, once.
    assert row["applied_at"] is None
    # No attempt, signal or schedule from the job itself.
    assert await db.fetchval("SELECT count(*) FROM quiz_attempts") == 0
    assert await db.fetchval("SELECT count(*) FROM learning_signals") == 0


async def test_while_the_ai_is_out_the_job_waits_and_then_catches_up(db, stored, monkeypatch):
    state = {"down": True}

    def behaviour():
        if state["down"]:
            raise LLMCreditError("credit balance is too low")
        return graded()

    grader(monkeypatch, behaviour)
    job_id = await new_job(db, stored)
    body = payload(job_id, stored.id)

    assert (await jobs.grade_quiz_job(body))["status"] == "deferred"
    job = await get_job(db, job_id)
    assert (job["status"], job["stage"], job["attempt_count"]) == ("pending", "waiting_for_ai", 0)
    assert (await db.fetchval("SELECT status FROM quiz_submissions WHERE id = $1", stored.id)) == "pending"

    state["down"] = False
    assert (await jobs.grade_quiz_job(body))["status"] == "success"
    assert (await get_job(db, job_id))["status"] == "completed"
    assert (await db.fetchval("SELECT status FROM quiz_submissions WHERE id = $1", stored.id)) == "graded"


async def test_a_second_delivery_does_not_grade_again(db, stored, monkeypatch):
    calls = grader(monkeypatch, graded)
    first = await new_job(db, stored)
    await jobs.grade_quiz_job(payload(first, stored.id))
    # A retry started another job for the same submission after the resume had already graded it.
    second = await new_job(db, stored)

    result = await jobs.grade_quiz_job(payload(second, stored.id))

    assert result["status"] == "success" and calls.calls == 1
    assert (await get_job(db, second))["status"] == "completed"


async def test_a_score_with_an_ungraded_answer_is_never_stored(db, stored, monkeypatch):
    grader(monkeypatch, lambda: graded(needs_review=True))
    job_id = await new_job(db, stored)

    with pytest.raises(HTTPException):
        await jobs.grade_quiz_job(payload(job_id, stored.id))

    assert (await db.fetchval("SELECT status FROM quiz_submissions WHERE id = $1", stored.id)) == "pending"
    assert await db.fetchval("SELECT ai_grading FROM quiz_submissions WHERE id = $1", stored.id) is None
    job = await get_job(db, job_id)
    # Back for a retry with the default code, not failed for good.
    assert job["status"] == "pending" and job["error_code"] == "QUIZ_GRADING_FAILED"


async def test_after_seven_days_the_job_fails_with_its_reason_and_the_answers_stay(db, stored, monkeypatch):
    def down():
        raise LLMCreditError("credit")

    grader(monkeypatch, down)
    job_id = await new_job(db, stored, created_at="SQL:(NOW() AT TIME ZONE 'UTC') - interval '8 days'")

    with pytest.raises(HTTPException):
        await jobs.grade_quiz_job(payload(job_id, stored.id))

    job = await get_job(db, job_id)
    assert (job["status"], job["error_code"]) == ("failed", "LLM_CREDIT_EXHAUSTED")
    # Still stored, so "Grade again" can start a new job.
    assert await db.fetchval("SELECT answers FROM quiz_submissions WHERE id = $1", stored.id) is not None


async def test_a_submission_deleted_with_the_account_is_a_permanent_failure(db, stored, monkeypatch):
    grader(monkeypatch, graded)
    job_id = await new_job(db, stored)
    await db.execute("DELETE FROM quiz_submissions WHERE id = $1", stored.id)

    with pytest.raises(HTTPException) as raised:
        await jobs.grade_quiz_job(payload(job_id, stored.id))

    assert raised.value.status_code == 400
    assert (await get_job(db, job_id))["error_code"] == "QUIZ_SUBMISSION_NOT_FOUND"


async def test_deleting_the_account_removes_the_stored_quiz(db, stored):
    await db.execute("DELETE FROM users WHERE id = $1", stored.user_id)
    assert await db.fetchval("SELECT count(*) FROM quiz_submissions") == 0


def test_the_reaper_sends_a_waiting_quiz_with_its_submission_id():
    data = job_reaper.dispatch_data("grade_quiz", {"submissionId": "s1", "topicId": "t"})
    assert data == {"submissionId": "s1"}


async def test_a_malformed_stored_question_is_refused_like_the_immediate_path_refuses_it(db, stored, monkeypatch):
    calls = grader(monkeypatch, graded)
    bad = [{"question_type": "essay", "question_text": "?"}]
    await db.execute("UPDATE quiz_submissions SET questions = $1 WHERE id = $2", json.dumps(bad), stored.id)
    job_id = await new_job(db, stored)

    with pytest.raises(HTTPException) as raised:
        await jobs.grade_quiz_job(payload(job_id, stored.id))

    assert raised.value.status_code == 400 and calls.calls == 0
    assert (await get_job(db, job_id))["error_code"] == "INVALID_INPUT"


async def test_the_stored_questions_are_normalised_like_the_immediate_path(db, stored, monkeypatch):
    seen = {}

    class Grader:
        async def grade_submission(self, submission_id, questions, answers):
            seen["questions"] = questions
            return graded()

    monkeypatch.setattr(jobs, "ExamGrader", Grader)
    odd = [dict(QUESTIONS[0], points="not a number")]
    await db.execute("UPDATE quiz_submissions SET questions = $1 WHERE id = $2", json.dumps(odd), stored.id)

    await jobs.grade_quiz_job(payload(await new_job(db, stored), stored.id))

    # GradableQuestion falls back to 1 point for an unusable value, as POST /grade/quiz does.
    assert seen["questions"][0]["points"] == 1


async def test_only_one_waiting_submission_per_answers(db, stored):
    import asyncpg

    row = await db.fetchrow("SELECT topic_id FROM quiz_submissions WHERE id = $1", stored.id)
    await db.execute("UPDATE quiz_submissions SET answers_hash = 'h' WHERE id = $1", stored.id)

    async def add(status="pending", set_id=None, hash_="h"):
        await db.execute(
            "INSERT INTO quiz_submissions (id, user_id, topic_id, quiz_set_id, answers, questions, status, answers_hash) "
            "VALUES ($1, $2, $3, $4, '{}', '[]', $5, $6)",
            new_id(), stored.user_id, row["topic_id"], set_id, status, hash_,
        )

    # The same answers to the same (here: no) set while waiting: refused by the index.
    with pytest.raises(asyncpg.UniqueViolationError):
        await add()
    # Other answers, another set, or one already graded are fine.
    await add(hash_="other")
    await add(set_id="set-2")
    await add(status="graded")

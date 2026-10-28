"""The generate-content, extract-topics and grade-exam handlers against the test Postgres."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.models.jobs import JobPayload
from tests.db_helpers import (
    get_job,
    new_id,
    seed_job,
    seed_material,
    seed_project,
    seed_topic,
    seed_user,
)


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    topic_id = await seed_topic(db, project_id)
    return SimpleNamespace(user_id=user_id, project_id=project_id, topic_id=topic_id)


def content_payload(job_id, topic_id, content_type, **preferences):
    return JobPayload(
        jobId=job_id,
        jobType="generate_content",
        data={"topicId": topic_id, "contentType": content_type, "preferences": preferences},
    )


class FakeExamples:
    """Stands in for the model-backed generator; each call returns one new example."""

    calls = 0

    async def generate_examples(self, **kwargs):
        FakeExamples.calls += 1
        return {
            "examples": [{"title": f"Example {FakeExamples.calls}"}],
            "example_type": "solved",
            "difficulty_level": "medium",
        }


@pytest.fixture(autouse=True)
def fake_examples(monkeypatch):
    FakeExamples.calls = 0
    monkeypatch.setattr(jobs, "ExamplesGenerator", FakeExamples)


class TestGenerateContent:
    async def run(self, db, world, **preferences):
        job_id = await seed_job(db, world.user_id, project_id=world.project_id)
        return await jobs.generate_content_job(
            content_payload(job_id, world.topic_id, "solved_examples", **preferences)
        )

    async def stored(self, db, world):
        row = await db.fetchrow(
            "SELECT content_data, metadata FROM topic_content WHERE topic_id = $1", world.topic_id
        )
        return json.loads(row["content_data"]), json.loads(row["metadata"])

    async def test_content_is_saved_and_the_job_completed(self, db, world):
        result = await self.run(db, world)

        assert result["status"] == "success"
        content, metadata = await self.stored(db, world)
        assert len(content) == 1
        assert metadata["count"] == 1

    async def test_regeneration_replaces_the_content(self, db, world):
        await self.run(db, world)
        await self.run(db, world)

        content, metadata = await self.stored(db, world)
        assert [item["title"] for item in content] == ["Example 2"]
        assert metadata["count"] == 1

    async def test_append_adds_to_the_existing_examples(self, db, world):
        await self.run(db, world)
        result = await self.run(db, world, append=True)

        content, metadata = await self.stored(db, world)
        assert [item["title"] for item in content] == ["Example 1", "Example 2"]
        assert metadata["count"] == 2
        job = await get_job(db, result["jobId"])
        assert json.loads(job["result_data"])["metadata"]["count"] == 2

    async def test_concurrent_appends_lose_nothing(self, db, world):
        # No row exists yet, so the first writers race to create it as well.
        results = await asyncio.gather(*[self.run(db, world, append=True) for _ in range(10)])

        assert all(r["status"] == "success" for r in results)
        content, metadata = await self.stored(db, world)
        assert len(content) == 10
        assert len({item["title"] for item in content}) == 10
        assert metadata["count"] == 10

    async def test_concurrent_appends_to_existing_content_lose_nothing(self, db, world):
        await self.run(db, world)

        await asyncio.gather(*[self.run(db, world, append=True) for _ in range(10)])

        content, _ = await self.stored(db, world)
        assert len(content) == 11

    async def test_unknown_content_type_is_a_permanent_failure(self, db, world):
        from fastapi import HTTPException

        job_id = await seed_job(db, world.user_id, project_id=world.project_id)

        with pytest.raises(HTTPException) as raised:
            await jobs.generate_content_job(content_payload(job_id, world.topic_id, "podcast"))

        assert raised.value.status_code == 400
        assert (await get_job(db, job_id))["retryable"] is False

    async def test_a_completed_generation_job_does_not_run_again(self, db, world):
        first = await self.run(db, world)

        again = await jobs.generate_content_job(
            content_payload(first["jobId"], world.topic_id, "solved_examples", append=True)
        )

        assert again["status"] == "skipped"
        content, _ = await self.stored(db, world)
        assert len(content) == 1


class TestGradeExam:
    @pytest.fixture
    async def submission(self, db, world, monkeypatch):
        questions = [
            {"topic_id": world.topic_id, "type": "multiple_choice"},
            {"topic_id": world.topic_id, "type": "short_answer"},
        ]
        exam_id = new_id()
        await db.execute(
            "INSERT INTO sample_exams (id, project_id, name, questions, duration_minutes, difficulty_level) "
            "VALUES ($1, $2, 'E', $3, 30, 'medium')",
            exam_id, world.project_id, json.dumps(questions),
        )
        submission_id = new_id()
        await db.execute(
            "INSERT INTO exam_submissions (id, sample_exam_id, user_id, answers) VALUES ($1, $2, $3, $4)",
            submission_id, exam_id, world.user_id, json.dumps({"0": "A", "1": "text"}),
        )
        seen = {}

        class FakeGrader:
            async def grade_submission(self, submission_id, questions, answers):
                seen["questions"] = questions
                seen["answers"] = answers
                return {
                    "overall_score": 50,
                    "earned_points": 1,
                    "total_points": 2,
                    "graded_questions": [
                        {"question_index": 0, "points_possible": 1, "points_earned": 1},
                        {"question_index": 1, "points_possible": 1, "points_earned": 0},
                    ],
                }

        monkeypatch.setattr(jobs, "ExamGrader", FakeGrader)
        return SimpleNamespace(id=submission_id, seen=seen)

    async def grade(self, db, world, submission):
        job_id = await seed_job(
            db, world.user_id, "grade_exam", project_id=world.project_id,
            input_data={"submissionId": submission.id},
        )
        # The task body carries only the submission id.
        return await jobs.grade_exam_job(
            JobPayload(jobId=job_id, jobType="grade_exam", data={"submissionId": submission.id})
        )

    async def test_the_questions_and_answers_are_loaded_from_the_database(self, db, world, submission):
        result = await self.grade(db, world, submission)

        assert result["overallScore"] == 50
        assert len(submission.seen["questions"]) == 2
        assert submission.seen["answers"] == {"0": "A", "1": "text"}
        graded = await db.fetchrow("SELECT ai_grading, graded_at FROM exam_submissions WHERE id = $1", submission.id)
        assert json.loads(graded["ai_grading"])["overall_score"] == 50
        assert graded["graded_at"] is not None

    async def test_an_attempt_in_progress_is_not_graded(self, db, world, submission):
        await db.execute("UPDATE exam_submissions SET status = 'in_progress' WHERE id = $1", submission.id)

        with pytest.raises(HTTPException) as excinfo:
            await self.grade(db, world, submission)

        assert excinfo.value.status_code == 400
        assert "questions" not in submission.seen
        assert await db.fetchval("SELECT ai_grading FROM exam_submissions WHERE id = $1", submission.id) is None

    async def test_while_the_ai_is_out_of_credit_grading_waits_and_then_catches_up(
        self, db, world, submission, monkeypatch
    ):
        from app.services.llm.base import LLMCreditError

        state = {"down": True}
        working = jobs.ExamGrader

        class Grader:
            async def grade_submission(self, *args, **kwargs):
                if state["down"]:
                    raise LLMCreditError("credit balance is too low")
                return await working().grade_submission(*args, **kwargs)

        monkeypatch.setattr(jobs, "ExamGrader", Grader)
        job_id = await seed_job(
            db, world.user_id, "grade_exam", project_id=world.project_id,
            input_data={"submissionId": submission.id},
        )
        payload = JobPayload(jobId=job_id, jobType="grade_exam", data={"submissionId": submission.id})

        result = await jobs.grade_exam_job(payload)

        # Not failed and no score stored: the job waits, and no attempt was used.
        assert result["status"] == "deferred"
        job = await get_job(db, job_id)
        assert (job["status"], job["stage"], job["attempt_count"]) == ("pending", "waiting_for_ai", 0)
        assert job["error_code"] == "LLM_CREDIT_EXHAUSTED"
        assert await db.fetchval("SELECT ai_grading FROM exam_submissions WHERE id = $1", submission.id) is None

        # Many more tries during the outage still use no attempts.
        for _ in range(5):
            assert (await jobs.grade_exam_job(payload))["status"] == "deferred"
        assert (await get_job(db, job_id))["attempt_count"] == 0

        state["down"] = False
        assert (await jobs.grade_exam_job(payload))["status"] == "success"
        assert (await get_job(db, job_id))["status"] == "completed"
        graded = await db.fetchval("SELECT ai_grading FROM exam_submissions WHERE id = $1", submission.id)
        assert json.loads(graded)["overall_score"] == 50

    async def test_regrading_replaces_the_learning_signals(self, db, world, submission):
        await self.grade(db, world, submission)
        await self.grade(db, world, submission)

        rows = await db.fetch("SELECT score FROM learning_signals WHERE source = 'exam' ORDER BY score")
        assert [r["score"] for r in rows] == [0.0, 1.0]

    async def test_regrading_one_submission_leaves_other_submissions_signals(self, db, world, submission):
        await db.execute(
            "INSERT INTO learning_signals (id, user_id, project_id, source, score, metadata) "
            "VALUES ($1, $2, $3, 'exam', 0.3, $4)",
            new_id(), world.user_id, world.project_id, json.dumps({"submission_id": "other"}),
        )

        await self.grade(db, world, submission)
        await self.grade(db, world, submission)

        assert await db.fetchval("SELECT count(*) FROM learning_signals") == 3

    async def test_missing_submission_is_a_permanent_failure(self, db, world):
        from fastapi import HTTPException

        job_id = await seed_job(db, world.user_id, "grade_exam", project_id=world.project_id)

        with pytest.raises(HTTPException) as raised:
            await jobs.grade_exam_job(
                JobPayload(jobId=job_id, jobType="grade_exam", data={"submissionId": "nope"})
            )

        assert raised.value.status_code == 400
        assert (await get_job(db, job_id))["error_code"] == "SUBMISSION_NOT_FOUND"

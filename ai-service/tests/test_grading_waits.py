"""Student work is never scored 0 because the AI was down: the grader stops instead of guessing,
the grading job waits for the AI without using its attempts, and the reaper sends it again once the
AI is available (or the allowance has reset)."""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException

from app.config import settings
from app.main import app
from app.models.jobs import JobPayload
from app.services import ai_status, job_reaper
from app.services.exam_grader import ExamGrader
from app.services.job_runner import DailyBudgetExceeded, JobOutcome, job_handler
from app.services.llm.base import LLMCreditError, LLMRefusalError, LLMUnavailableError
from tests.db_helpers import get_job, seed_job, seed_usage, seed_user

SHORT = {"question_type": "short_answer", "question_text": "Why cache?", "points": 2,
         "sample_answer": "Speed.", "key_points": ["speed"]}
MCQ = {"question_type": "multiple_choice", "question_text": "Pick", "points": 1,
       "options": ["A", "B"], "correct_answer": "B"}


def grader_with(error=None, reply=None):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(side_effect=error) if error else AsyncMock(return_value=reply)
    with patch("app.services.exam_grader.LLMFactory.get_provider", return_value=llm):
        return ExamGrader()


class TestGrader:
    @pytest.mark.parametrize("error", [LLMCreditError("credit"), LLMUnavailableError("overloaded")])
    async def test_an_unreachable_model_fails_the_grading_instead_of_scoring_zero(self, error):
        grader = grader_with(error=error)
        with pytest.raises(type(error)):
            await grader.grade_submission("s", [MCQ, SHORT, SHORT], {"0": "B", "1": "x", "2": "y"})

    async def test_a_refusal_is_still_flagged_for_review(self):
        grader = grader_with(error=LLMRefusalError("no"))
        result = await grader.grade_submission("s", [MCQ, SHORT], {"0": "B", "1": "x"})
        assert result["graded_questions"][1]["needs_review"] is True
        assert result["graded_questions"][0]["is_correct"] is True


async def call(method, path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


async def test_quiz_grading_is_refused_with_the_reason_when_the_model_is_unreachable():
    llm = MagicMock()
    llm.generate_structured = AsyncMock(side_effect=LLMCreditError("credit"))
    with patch("app.services.exam_grader.LLMFactory.get_provider", return_value=llm):
        response = await call("POST", "/grade/quiz", json={"questions": [SHORT], "answers": {"0": "x"}})
    # The web app keeps the answers and stores nothing (no 0 score).
    assert response.status_code == 502
    assert response.json()["error_code"] == "LLM_CREDIT_EXHAUSTED"


def waiting_handler(body):
    @job_handler(job_type="grade_exam", label="Grading", default_error_code="EXAM_GRADING_FAILED",
                 uses_llm=True, wait_for_ai=True)
    async def handler(payload, job):
        return await body(payload, job)

    return handler


def payload(job_id):
    return JobPayload(jobId=job_id, jobType="grade_exam", data={"submissionId": "s1"})


@pytest.fixture
def anthropic(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "")


class TestWaiting:
    async def test_a_known_outage_defers_without_running_the_handler(self, db, anthropic):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id, "grade_exam")
        await ai_status._mark_unavailable("LLM_CREDIT_EXHAUSTED", "test")
        ran = []

        async def body(payload, job):
            ran.append(job.id)
            return JobOutcome()

        result = await waiting_handler(body)(payload(job_id))

        assert result["status"] == "deferred" and ran == []
        job = await get_job(db, job_id)
        assert (job["status"], job["stage"], job["attempt_count"]) == ("pending", "waiting_for_ai", 0)

    async def test_over_the_allowance_it_waits_until_the_reset(self, db, anthropic, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.0)
        user_id = await seed_user(db)
        await seed_usage(db, user_id, 2.0)
        job_id = await seed_job(db, user_id, "grade_exam")

        async def body(payload, job):
            return JobOutcome()

        assert (await waiting_handler(body)(payload(job_id)))["status"] == "deferred"
        job = await get_job(db, job_id)
        assert job["error_code"] == "LLM_DAILY_BUDGET"
        now = datetime.now(UTC).replace(tzinfo=None)
        midnight = datetime(now.year, now.month, now.day) + timedelta(days=1)
        assert job["lease_until"] >= midnight

    async def test_a_job_that_has_waited_too_long_fails_with_its_reason(self, db, anthropic):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id, "grade_exam",
                                created_at="SQL:(NOW() AT TIME ZONE 'UTC') - interval '8 days'")

        async def body(payload, job):
            raise LLMCreditError("credit")

        with pytest.raises(HTTPException):
            await waiting_handler(body)(payload(job_id))
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"]) == ("failed", "LLM_CREDIT_EXHAUSTED")

    async def test_other_failures_still_fail(self, db, anthropic):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id, "grade_exam")

        async def body(payload, job):
            raise LLMRefusalError("no")

        with pytest.raises(HTTPException):
            await waiting_handler(body)(payload(job_id))
        assert (await get_job(db, job_id))["status"] == "failed"


class TestReaperSendsWaitingJobs:
    @pytest.fixture
    def dispatched(self, monkeypatch):
        sent = []

        async def enqueue(job_id, job_type, data):
            sent.append(job_id)

        monkeypatch.setattr(job_reaper, "enqueue_job", enqueue)
        return sent

    PAST = "SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 minute'"
    FUTURE = "SQL:(NOW() AT TIME ZONE 'UTC') + interval '5 hours'"

    async def waiting(self, db, user_id, **columns):
        columns.setdefault("error_code", "LLM_CREDIT_EXHAUSTED")
        columns.setdefault("lease_until", self.PAST)
        return await seed_job(db, user_id, "grade_exam", status="pending", stage="waiting_for_ai",
                              started_at=self.PAST, input_data={"submissionId": "s1"}, **columns)

    async def test_not_sent_while_the_ai_is_down_and_never_failed_by_the_redispatch_limit(
        self, db, anthropic, dispatched
    ):
        user_id = await seed_user(db)
        job_id = await self.waiting(db, user_id, dispatch_count=99)
        await ai_status._mark_unavailable("LLM_CREDIT_EXHAUSTED", "test")

        counts = await job_reaper.reap_expired_jobs()

        assert dispatched == [] and counts["waiting_redispatched"] == 0
        job = await get_job(db, job_id)
        assert (job["status"], job["stage"]) == ("pending", "waiting_for_ai")

    async def test_sent_once_the_ai_is_available_again(self, db, anthropic, dispatched):
        user_id = await seed_user(db)
        job_id = await self.waiting(db, user_id)
        await ai_status._mark_unavailable("LLM_CREDIT_EXHAUSTED", "test")
        await ai_status.record_success()

        counts = await job_reaper.reap_expired_jobs()

        assert dispatched == [job_id] and counts["waiting_redispatched"] == 1
        # Not sent again by the very next sweep.
        await job_reaper.reap_expired_jobs()
        assert dispatched == [job_id]

    async def test_an_expired_outage_record_lets_one_real_attempt_through(self, db, anthropic, dispatched):
        user_id = await seed_user(db)
        job_id = await self.waiting(db, user_id)
        await ai_status._mark_unavailable("LLM_CREDIT_EXHAUSTED", "test")
        old = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=settings.AI_STATUS_TTL_S + 5)
        await db.execute("UPDATE ai_status SET checked_at = $1", old)

        await job_reaper.reap_expired_jobs()

        assert dispatched == [job_id]

    @pytest.mark.parametrize("reason", ["LLM_NOT_CONFIGURED", "LLM_CREDIT_EXHAUSTED", "LLM_DAILY_BUDGET"])
    async def test_a_job_past_the_wait_limit_fails_with_its_reason_even_while_the_ai_stays_down(
        self, db, monkeypatch, dispatched, reason
    ):
        # With no key the AI never comes back, so no handler runs to notice the limit.
        monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
        user_id = await seed_user(db)
        overdue = await self.waiting(
            db, user_id, error_code=reason, lease_until=self.FUTURE,
            created_at="SQL:(NOW() AT TIME ZONE 'UTC') - interval '8 days'",
        )
        recent = await self.waiting(db, user_id, error_code=reason, lease_until=self.FUTURE)

        counts = await job_reaper.reap_expired_jobs()

        assert counts["waiting_expired"] == 1
        job = await get_job(db, overdue)
        assert (job["status"], job["error_code"], job["lease_until"]) == ("failed", reason, None)
        assert job["completed_at"] is not None
        assert (await get_job(db, recent))["status"] == "pending"
        assert dispatched == []

    async def test_waiting_for_the_allowance_is_sent_after_the_reset_only(self, db, anthropic, dispatched):
        user_id = await seed_user(db)
        later = await self.waiting(db, user_id, error_code="LLM_DAILY_BUDGET", lease_until=self.FUTURE)
        reset = await self.waiting(db, user_id, error_code="LLM_DAILY_BUDGET")

        await job_reaper.reap_expired_jobs()

        assert dispatched == [reset]
        assert later not in dispatched


def test_budget_refusal_waits():
    from app.services.job_runner import waits_for_ai

    assert waits_for_ai(DailyBudgetExceeded("over"))
    assert waits_for_ai(LLMCreditError("x"))
    assert not waits_for_ai(LLMRefusalError("x"))
    assert not waits_for_ai(SimpleNamespace())

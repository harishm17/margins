"""Claiming, leases, failure handling, usage, budget and reaping of processing jobs.

These run against the test Postgres (see conftest.py): the behaviour is in the SQL.
"""
import asyncio
import json
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from fastapi import HTTPException

from app.config import settings
from app.db import connection
from app.models.jobs import JobPayload
from app.services import job_reaper
from app.services.job_runner import (
    DailyBudgetExceeded,
    JobOutcome,
    PermanentJobError,
    claim_job,
    create_job,
    job_handler,
)
from app.services.llm.base import LLMAuthError, LLMRateLimitError, LLMUsage
from app.services.llm.usage import record_usage
from app.services.budget import spent_today_usd
from tests.db_helpers import get_job, seed_job, seed_project, seed_usage, seed_user


def payload(job_id: str) -> JobPayload:
    return JobPayload(jobId=job_id, jobType="generate_content", data={})


def make_handler(body, **options):
    """A job endpoint with the real decorator around `body(payload, job)`."""
    options.setdefault("job_type", "generate_content")
    options.setdefault("label", "Test job")
    options.setdefault("default_error_code", "TEST_FAILED")

    @job_handler(**options)
    async def handler(payload, job):
        return await body(payload, job)

    return handler


async def ok(payload, job):
    return JobOutcome(result={"done": True}, response={"extra": 1})


@pytest.fixture
async def user_id(db):
    return await seed_user(db)


class TestClaim:
    async def test_pending_job_is_claimed_and_run(self, db, user_id):
        job_id = await seed_job(db, user_id)

        result = await make_handler(ok)(payload(job_id))

        assert result == {"status": "success", "jobId": job_id, "extra": 1}
        job = await get_job(db, job_id)
        assert job["status"] == "completed"
        assert job["attempt_count"] == 1
        assert job["lease_until"] is None
        assert json.loads(job["result_data"]) == {"done": True}

    async def test_completed_job_is_skipped_and_not_run_again(self, db, user_id):
        job_id = await seed_job(db, user_id)
        calls = []

        async def body(payload, job):
            calls.append(job.attempt)
            return JobOutcome()

        handler = make_handler(body)
        await handler(payload(job_id))
        again = await handler(payload(job_id))

        assert again["status"] == "skipped"
        assert "completed" in again["reason"]
        assert calls == [1]
        assert (await get_job(db, job_id))["attempt_count"] == 1

    async def test_unknown_job_is_skipped(self, db):
        result = await make_handler(ok)(payload("no-such-job"))

        assert result["status"] == "skipped"
        assert result["reason"] == "Job not found"

    async def test_two_simultaneous_claims_have_one_winner(self, db, user_id):
        job_id = await seed_job(db, user_id)

        claims = await asyncio.gather(*[claim_job(job_id, 60, None) for _ in range(8)])

        assert len([c for c in claims if c is not None]) == 1
        assert (await get_job(db, job_id))["attempt_count"] == 1

    async def test_two_simultaneous_deliveries_run_the_job_once(self, db, user_id):
        job_id = await seed_job(db, user_id)
        runs = []

        async def slow(payload, job):
            runs.append(job.attempt)
            await asyncio.sleep(0.3)
            return JobOutcome()

        handler = make_handler(slow)
        results = await asyncio.gather(handler(payload(job_id)), handler(payload(job_id)))

        assert sorted(r["status"] for r in results) == ["skipped", "success"]
        assert [r["reason"] for r in results if r["status"] == "skipped"] == ["Job is already running"]
        assert runs == [1]

    async def test_job_with_a_live_lease_is_not_taken_over(self, db, user_id):
        job_id = await seed_job(
            db, user_id, status="processing", attempt_count=1,
            lease_until="SQL:(NOW() AT TIME ZONE 'UTC') + interval '5 minutes'",
        )

        assert await claim_job(job_id, 60, None) is None

    async def test_job_with_an_expired_lease_is_reclaimed(self, db, user_id):
        job_id = await seed_job(
            db, user_id, status="processing", attempt_count=1,
            lease_until="SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 minute'",
        )

        result = await make_handler(ok)(payload(job_id))

        assert result["status"] == "success"
        job = await get_job(db, job_id)
        assert (job["status"], job["attempt_count"]) == ("completed", 2)

    async def test_job_with_an_expired_lease_and_no_attempts_left_is_not_claimed(self, db, user_id):
        job_id = await seed_job(
            db, user_id, status="processing", attempt_count=3,
            lease_until="SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 minute'",
        )
        calls = []

        async def body(payload, job):
            calls.append(job.attempt)
            return JobOutcome()

        result = await make_handler(body)(payload(job_id))

        assert result == {"status": "skipped", "jobId": job_id, "reason": "Job used all its attempts"}
        assert calls == []
        job = await get_job(db, job_id)
        assert (job["status"], job["attempt_count"]) == ("processing", 3)

    async def test_a_job_waiting_for_its_retry_is_claimed(self, db, user_id):
        job_id = await seed_job(db, user_id, status="pending", retryable=True, attempt_count=2,
                                error_code="LLM_UNAVAILABLE", started_at=datetime(2026, 1, 1))

        row = await claim_job(job_id, 60, None)

        assert row is not None and row["attempt_count"] == 3
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"]) == ("processing", None)

    async def test_a_failed_job_is_final_even_when_retryable(self, db, user_id):
        # `failed` means no worker runs the job again; retryable only says a new job may help.
        for retryable in (True, False):
            job_id = await seed_job(db, user_id, status="failed", retryable=retryable, attempt_count=1)

            result = await make_handler(ok)(payload(job_id))

            assert result["status"] == "skipped"
            assert result["reason"] == "Job failed"
            assert (await get_job(db, job_id))["attempt_count"] == 1

    async def test_started_at_is_kept_across_attempts(self, db, user_id):
        job_id = await seed_job(db, user_id, status="pending", retryable=True, attempt_count=1,
                                started_at=datetime(2026, 1, 1))

        await claim_job(job_id, 60, None)

        assert (await get_job(db, job_id))["started_at"] == datetime(2026, 1, 1)

    async def test_the_lease_is_renewed_while_the_handler_runs(self, db, user_id):
        job_id = await seed_job(db, user_id)
        seen = {}

        async def body(payload, job):
            seen["first"] = (await get_job(db, job_id))["lease_until"]
            await asyncio.sleep(0.6)
            seen["later"] = (await get_job(db, job_id))["lease_until"]
            return JobOutcome()

        await make_handler(body, lease_seconds=0.6)(payload(job_id))

        assert seen["later"] > seen["first"]


class TestFailureHandling:
    @pytest.mark.parametrize(
        "error,status_code,code,retryable",
        [
            (PermanentJobError("bad input", "INVALID_INPUT"), 400, "INVALID_INPUT", False),
            (LLMAuthError("no key"), 400, "LLM_AUTH_FAILED", False),
            (LLMRateLimitError("slow down"), 503, "LLM_RATE_LIMITED", True),
            (HTTPException(status_code=404, detail="Topic not found"), 400, "TEST_FAILED", False),
            (RuntimeError("database went away"), 500, "TEST_FAILED", True),
        ],
    )
    async def test_failures_are_classified_and_answered(
        self, db, user_id, error, status_code, code, retryable
    ):
        job_id = await seed_job(db, user_id)

        async def body(payload, job):
            raise error

        with pytest.raises(HTTPException) as raised:
            await make_handler(body)(payload(job_id))

        assert raised.value.status_code == status_code
        assert raised.value.detail.startswith("Test job failed: ")
        job = await get_job(db, job_id)
        assert (job["error_code"], job["retryable"]) == (code, retryable)
        if retryable:
            # Attempts left: back in pending for the dispatcher's retry, still the target's
            # active job, with a mark for the reaper should that retry never come.
            assert job["status"] == "pending"
            assert job["completed_at"] is None
            assert job["lease_until"] is not None
        else:
            assert job["status"] == "failed"
            assert job["lease_until"] is None
            assert job["completed_at"] is not None

    async def test_the_last_attempt_fails_for_good_and_says_a_new_try_may_help(self, db, user_id):
        job_id = await seed_job(db, user_id, status="pending", retryable=True, attempt_count=2,
                                started_at=datetime(2026, 1, 1))

        async def body(payload, job):
            raise RuntimeError("still broken")

        with pytest.raises(HTTPException) as raised:
            await make_handler(body)(payload(job_id))

        assert raised.value.status_code == 500
        job = await get_job(db, job_id)
        assert (job["status"], job["attempt_count"], job["retryable"]) == ("failed", 3, True)
        assert job["error_code"] == "TEST_FAILED" and job["completed_at"] is not None

    async def test_a_retry_keeps_one_active_job_for_its_target(self, db, user_id):
        target = "content:t1:section_notes"
        job_id = await seed_job(db, user_id, target_key=target)

        async def body(payload, job):
            raise LLMRateLimitError("slow down")

        with pytest.raises(HTTPException):
            await make_handler(body)(payload(job_id))

        # A second request for the same work gets the job that is waiting for its retry.
        again, created = await create_job(user_id=user_id, project_id=None, job_type="generate_content",
                                          stage="generating", input_data={}, target_key=target)
        assert (again, created) == (job_id, False)

    async def test_a_handler_that_lost_its_claim_does_not_overwrite_the_new_owner(self, db, user_id):
        job_id = await seed_job(db, user_id)

        async def body(payload, job):
            # Another worker takes the job over (lease expired) and finishes it first.
            await db.execute(
                "UPDATE processing_jobs SET attempt_count = 2, status = 'completed', "
                "result_data = '{\"winner\": true}' WHERE id = $1",
                job_id,
            )
            return JobOutcome(result={"winner": False})

        await make_handler(body)(payload(job_id))

        assert json.loads((await get_job(db, job_id))["result_data"]) == {"winner": True}

    async def test_follow_up_work_runs_after_completion_and_cannot_fail_the_job(self, db, user_id):
        job_id = await seed_job(db, user_id)
        seen = []

        async def after():
            seen.append((await get_job(db, job_id))["status"])
            raise RuntimeError("enqueue failed")

        async def body(payload, job):
            return JobOutcome(after=after)

        result = await make_handler(body)(payload(job_id))

        assert result["status"] == "success"
        assert seen == ["completed"]
        assert (await get_job(db, job_id))["status"] == "completed"


def usage(model="claude-haiku-5-5", input_tokens=1000, output_tokens=500, **extra):
    return LLMUsage(model=model, input_tokens=input_tokens, output_tokens=output_tokens, **extra)


class TestUsage:
    async def test_usage_is_stored_in_the_columns_and_the_result(self, db, user_id):
        job_id = await seed_job(db, user_id)

        async def body(payload, job):
            record_usage(usage(input_tokens=1_000_000, output_tokens=100_000, cache_read_input_tokens=500))
            record_usage(usage(input_tokens=200, output_tokens=100))
            return JobOutcome(result={"done": True})

        await make_handler(body)(payload(job_id))

        job = await get_job(db, job_id)
        assert job["llm_input_tokens"] == 1_000_700
        assert job["llm_output_tokens"] == 100_100
        # haiku: $0.10 per million input, $0.50 per million output
        assert float(job["llm_cost_usd"]) == pytest.approx(0.1 + 0.05 + 0.00005 + 0.00002 + 0.00005, abs=1e-4)
        stored = json.loads(job["result_data"])
        assert stored["usage"]["calls"] == 2
        assert stored["usage"]["output_tokens"] == 100_100

    async def test_a_failed_attempt_still_records_what_it_spent_and_attempts_add_up(self, db, user_id):
        job_id = await seed_job(db, user_id)
        attempts = []

        async def body(payload, job):
            attempts.append(job.attempt)
            record_usage(usage(input_tokens=2_000_000, output_tokens=0))
            if job.attempt == 1:
                raise LLMRateLimitError("slow down")
            return JobOutcome()

        handler = make_handler(body)
        with pytest.raises(HTTPException):
            await handler(payload(job_id))
        assert float((await get_job(db, job_id))["llm_cost_usd"]) == pytest.approx(0.2)

        await handler(payload(job_id))

        job = await get_job(db, job_id)
        assert attempts == [1, 2]
        assert job["llm_input_tokens"] == 4_000_000
        assert float(job["llm_cost_usd"]) == pytest.approx(0.4)

    async def test_each_attempt_adds_a_ledger_row_that_outlives_the_job(self, db, user_id):
        project_id = await seed_project(db, user_id)
        job_id = await seed_job(db, user_id, project_id=project_id)

        async def body(payload, job):
            record_usage(usage(input_tokens=2_000_000, output_tokens=0))
            if job.attempt == 1:
                raise LLMRateLimitError("slow down")
            return JobOutcome()

        handler = make_handler(body)
        with pytest.raises(HTTPException):
            await handler(payload(job_id))
        await handler(payload(job_id))

        rows = await db.fetch("SELECT * FROM llm_usage_events WHERE user_id = $1", user_id)
        assert len(rows) == 2
        assert {(r["source"], r["source_id"], r["project_id"], r["models"]) for r in rows} == {
            ("job", job_id, project_id, "claude-haiku-5-5")
        }
        assert sum(float(r["cost_usd"]) for r in rows) == pytest.approx(0.4)

        # Deleting the project deletes the job (cascade), not what it cost.
        await db.execute("DELETE FROM projects WHERE id = $1", project_id)
        assert await db.fetchval("SELECT count(*) FROM processing_jobs WHERE id = $1", job_id) == 0
        assert await spent_today_usd(user_id) == pytest.approx(0.4)

    async def test_a_job_without_llm_calls_records_zero(self, db, user_id):
        job_id = await seed_job(db, user_id)

        await make_handler(ok)(payload(job_id))

        job = await get_job(db, job_id)
        assert (job["llm_input_tokens"], job["llm_output_tokens"]) == (0, 0)
        assert float(job["llm_cost_usd"]) == 0
        assert "usage" not in json.loads(job["result_data"])
        assert await db.fetchval("SELECT count(*) FROM llm_usage_events") == 0


class TestDailyBudget:
    @pytest.fixture(autouse=True)
    def budget(self, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.00)

    async def run_llm_job(self, db, user_id):
        job_id = await seed_job(db, user_id)
        calls = []

        async def body(payload, job):
            calls.append(job.id)
            return JobOutcome()

        return job_id, calls, make_handler(body, uses_llm=True)

    async def test_job_is_refused_permanently_when_the_user_is_over_budget(self, db, user_id):
        await seed_usage(db, user_id, 1.25)
        job_id, calls, handler = await self.run_llm_job(db, user_id)

        with pytest.raises(HTTPException) as raised:
            await handler(payload(job_id))

        assert raised.value.status_code == 400
        assert "Daily AI usage limit" in raised.value.detail
        assert calls == []
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"], job["retryable"]) == (
            "failed", "LLM_DAILY_BUDGET", False,
        )
        assert "$1.25 of $1.00" in job["error_message"]

    async def test_job_under_budget_runs(self, db, user_id):
        await seed_usage(db, user_id, 0.40)
        job_id, calls, handler = await self.run_llm_job(db, user_id)

        assert (await handler(payload(job_id)))["status"] == "success"
        assert calls == [job_id]

    async def test_other_users_and_earlier_days_do_not_count(self, db, user_id):
        other = await seed_user(db)
        await seed_usage(db, other, 5)
        await seed_usage(db, user_id, 5, created_at="SQL:(NOW() AT TIME ZONE 'UTC') - interval '2 days'")
        job_id, calls, handler = await self.run_llm_job(db, user_id)

        assert (await handler(payload(job_id)))["status"] == "success"

    async def test_zero_turns_the_budget_off(self, db, user_id, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 0)
        monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 0)
        await seed_usage(db, user_id, 500)
        job_id, calls, handler = await self.run_llm_job(db, user_id)

        assert (await handler(payload(job_id)))["status"] == "success"

    async def test_jobs_that_do_not_call_the_model_ignore_the_budget(self, db, user_id):
        await seed_usage(db, user_id, 5)
        job_id = await seed_job(db, user_id)

        assert (await make_handler(ok, uses_llm=False)(payload(job_id)))["status"] == "success"

    async def test_the_budget_error_is_permanent(self):
        from app.services.job_runner import classify_failure

        assert classify_failure(DailyBudgetExceeded("x"), "D") == ("LLM_DAILY_BUDGET", False, 400)


class TestUtcTimestamps:
    async def test_the_pool_runs_in_utc(self, db):
        assert await db.fetchval("SHOW timezone") == "UTC"

    async def test_utc_now_is_utc_even_when_the_session_is_not(self, test_database_url):
        conn = await asyncpg.connect(test_database_url, server_settings={"timezone": "America/Chicago"})
        try:
            stamp = await conn.fetchval(f"SELECT {connection.UTC_NOW}")
            bare = await conn.fetchval("SELECT NOW()::timestamp")
        finally:
            await conn.close()

        expected = datetime.now(UTC).replace(tzinfo=None)
        assert abs(stamp - expected) < timedelta(seconds=30)
        # What the service used to write: local time, hours away from UTC.
        assert abs(bare - expected) > timedelta(hours=4)

    async def test_job_timestamps_are_utc(self, db, user_id):
        job_id = await seed_job(db, user_id)

        await make_handler(ok)(payload(job_id))

        job = await get_job(db, job_id)
        expected = datetime.now(UTC).replace(tzinfo=None)
        for column in ("started_at", "completed_at"):
            assert abs(job[column] - expected) < timedelta(seconds=30), column

    def test_no_job_sql_uses_a_bare_now(self):
        from pathlib import Path

        root = Path(__file__).resolve().parents[1] / "app"
        offenders = [
            str(path.relative_to(root))
            for path in root.rglob("*.py")
            if "NOW()" in path.read_text().replace("(NOW() AT TIME ZONE 'UTC')", "")
        ]
        assert offenders == []


class TestReaper:
    @pytest.fixture
    def dispatched(self, monkeypatch):
        sent = []

        async def enqueue(job_id, job_type, data):
            sent.append((job_id, job_type, data))

        monkeypatch.setattr(job_reaper, "enqueue_job", enqueue)
        return sent

    EXPIRED = "SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 minute'"
    LIVE = "SQL:(NOW() AT TIME ZONE 'UTC') + interval '5 minutes'"

    async def test_exhausted_jobs_fail_and_the_others_are_dispatched_again(self, db, user_id, dispatched):
        exhausted = await seed_job(db, user_id, status="processing", attempt_count=3, lease_until=self.EXPIRED)
        retryable = await seed_job(
            db, user_id, "extract_topics", status="processing", attempt_count=1,
            lease_until=self.EXPIRED, input_data={"projectId": "p1"},
        )
        running = await seed_job(db, user_id, status="processing", attempt_count=1, lease_until=self.LIVE)
        pending = await seed_job(db, user_id)

        counts = await job_reaper.reap_expired_jobs()

        assert counts == {
            "failed": 1, "redispatched": 1, "pending_failed": 0, "pending_redispatched": 0,
            "retry_failed": 0, "retry_redispatched": 0, "waiting_redispatched": 0, "waiting_expired": 0,
        }
        job = await get_job(db, exhausted)
        # Final, but starting the work again may well succeed.
        assert (job["status"], job["error_code"], job["retryable"]) == ("failed", "JOB_LEASE_EXPIRED", True)
        assert dispatched == [(retryable, "extract_topics", {"projectId": "p1"})]
        assert (await get_job(db, running))["status"] == "processing"
        assert (await get_job(db, pending))["status"] == "pending"

    async def test_a_redispatched_job_is_taken_over_by_the_claim(self, db, user_id):
        job_id = await seed_job(db, user_id, status="processing", attempt_count=1, lease_until=self.EXPIRED)

        result = await make_handler(ok)(payload(job_id))

        assert result["status"] == "success"
        assert (await get_job(db, job_id))["attempt_count"] == 2

    async def test_grading_jobs_are_redispatched_with_only_the_submission_id(self, db, user_id, dispatched):
        job_id = await seed_job(
            db, user_id, "grade_exam", status="processing", attempt_count=1, lease_until=self.EXPIRED,
            input_data={"submissionId": "s1", "examId": "e1", "answers": {"0": "A"}},
        )

        await job_reaper.reap_expired_jobs()

        assert dispatched == [(job_id, "grade_exam", {"submissionId": "s1"})]

    OLD = "SQL:(NOW() AT TIME ZONE 'UTC') - interval '10 minutes'"
    FRESH = "SQL:(NOW() AT TIME ZONE 'UTC') - interval '5 seconds'"

    @pytest.fixture(autouse=True)
    def pending_settings(self, monkeypatch):
        monkeypatch.setattr(settings, "JOB_PENDING_REDISPATCH_SECONDS", 120)
        monkeypatch.setattr(settings, "JOB_MAX_REDISPATCHES", 3)

    async def test_an_old_pending_job_that_never_started_is_dispatched_again(self, db, user_id, dispatched):
        stuck = await seed_job(
            db, user_id, "extract_topics", created_at=self.OLD, input_data={"projectId": "p1"}
        )
        await seed_job(db, user_id, created_at=self.FRESH)  # not old enough
        # Was claimed once and is waiting for the dispatcher's retry.
        await seed_job(db, user_id, created_at=self.OLD, started_at="SQL:NOW()", lease_until=self.LIVE)

        counts = await job_reaper.reap_expired_jobs()

        assert counts["pending_redispatched"] == 1
        assert dispatched == [(stuck, "extract_topics", {"projectId": "p1"})]
        job = await get_job(db, stuck)
        assert (job["status"], job["dispatch_count"]) == ("pending", 1)

    async def test_redispatches_are_spaced_out_so_each_sweep_does_not_resend(self, db, user_id, dispatched):
        # Created 3 minutes ago: due once (after 2), the next is due after 4 minutes.
        job_id = await seed_job(
            db, user_id, created_at="SQL:(NOW() AT TIME ZONE 'UTC') - interval '3 minutes'"
        )

        await job_reaper.reap_expired_jobs()
        await job_reaper.reap_expired_jobs()
        await job_reaper.reap_expired_jobs()

        assert [d[0] for d in dispatched] == [job_id]

    async def test_a_job_that_can_never_be_dispatched_is_failed_after_the_limit(self, db, user_id, dispatched):
        job_id = await seed_job(db, user_id, created_at=self.OLD, dispatch_count=2)

        first = await job_reaper.reap_expired_jobs()
        assert first["pending_redispatched"] == 1
        assert (await get_job(db, job_id))["dispatch_count"] == 3

        second = await job_reaper.reap_expired_jobs()

        assert second["pending_failed"] == 1
        assert second["pending_redispatched"] == 0
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"], job["retryable"]) == (
            "failed", "JOB_DISPATCH_FAILED", True,
        )
        assert job["completed_at"] is not None
        assert len(dispatched) == 1

    async def test_a_failed_dispatch_still_counts_towards_the_limit(self, db, user_id, monkeypatch):
        async def broken(job_id, job_type, data):
            raise RuntimeError("queue unavailable")

        monkeypatch.setattr(job_reaper, "enqueue_job", broken)
        job_id = await seed_job(db, user_id, created_at=self.OLD)

        counts = await job_reaper.reap_expired_jobs()

        assert counts["pending_redispatched"] == 0
        assert (await get_job(db, job_id))["dispatch_count"] == 1

    async def test_a_redispatched_pending_job_runs_once_when_two_deliveries_arrive(self, db, user_id):
        job_id = await seed_job(db, user_id, created_at=self.OLD, dispatch_count=1)
        runs = []

        async def slow(payload, job):
            runs.append(job.attempt)
            await asyncio.sleep(0.2)
            return JobOutcome()

        handler = make_handler(slow)
        await asyncio.gather(handler(payload(job_id)), handler(payload(job_id)))

        assert runs == [1]

    async def test_a_retry_the_dispatcher_never_made_is_sent_by_the_reaper(self, db, user_id, dispatched):
        waiting = await seed_job(
            db, user_id, "extract_topics", status="pending", attempt_count=1, started_at=self.OLD,
            error_code="LLM_UNAVAILABLE", lease_until=self.EXPIRED, input_data={"projectId": "p1"},
        )
        not_yet = await seed_job(db, user_id, status="pending", attempt_count=1, started_at=self.OLD,
                                 lease_until=self.LIVE)

        counts = await job_reaper.reap_expired_jobs()

        assert counts["retry_redispatched"] == 1
        assert dispatched == [(waiting, "extract_topics", {"projectId": "p1"})]
        job = await get_job(db, waiting)
        # Still pending, its mark pushed forward so the next sweep does not send it again.
        assert (job["status"], job["dispatch_count"], job["error_code"]) == ("pending", 1, "LLM_UNAVAILABLE")
        assert job["lease_until"] > datetime.now(UTC).replace(tzinfo=None)
        assert (await get_job(db, not_yet))["dispatch_count"] == 0

        await job_reaper.reap_expired_jobs()
        assert len(dispatched) == 1

    async def test_a_dispatcher_that_gives_up_leaves_a_waiting_retry_to_the_reaper(self, db, user_id):
        from app.services.dispatch import mark_undelivered

        never_started = await seed_job(db, user_id)
        waiting = await seed_job(db, user_id, status="pending", attempt_count=1, started_at=self.OLD,
                                 error_code="LLM_UNAVAILABLE", lease_until=self.LIVE)

        await mark_undelivered(never_started, "unreachable")
        await mark_undelivered(waiting, "unreachable")

        assert (await get_job(db, never_started))["error_code"] == "ENQUEUE_FAILED"
        job = await get_job(db, waiting)
        assert (job["status"], job["error_code"]) == ("pending", "LLM_UNAVAILABLE")

    async def test_a_retry_that_is_never_claimed_fails_with_its_last_error(self, db, user_id, dispatched):
        job_id = await seed_job(db, user_id, status="pending", attempt_count=1, started_at=self.OLD,
                                error_code="LLM_UNAVAILABLE", retryable=True, lease_until=self.EXPIRED,
                                dispatch_count=3)

        counts = await job_reaper.reap_expired_jobs()

        assert counts["retry_failed"] == 1
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"], job["retryable"]) == ("failed", "LLM_UNAVAILABLE", True)
        assert dispatched == []

    async def test_reap_endpoint_runs_the_reaper(self, db, user_id, dispatched, monkeypatch):
        from fastapi.testclient import TestClient

        from app.main import app

        monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "t")
        await seed_job(db, user_id, status="processing", attempt_count=3, lease_until=self.EXPIRED)

        # The route handler runs in the test client's own event loop, so give it its own pool.
        await connection.close_db_pool()
        with TestClient(app) as client:
            response = client.post("/jobs/reap", headers={"x-ai-internal-token": "t"})
        await connection.close_db_pool()

        assert response.status_code == 200
        assert response.json()["failed"] == 1
        assert response.json()["redispatched"] == 0


class TestActiveJobUniqueness:
    async def test_second_active_job_for_a_target_returns_the_first(self, db, user_id):
        first, created = await create_job(
            user_id=user_id, project_id=None, job_type="extract_topics", stage="extracting",
            input_data={}, target_key="extract:p1",
        )
        second, created_again = await create_job(
            user_id=user_id, project_id=None, job_type="extract_topics", stage="extracting",
            input_data={}, target_key="extract:p1",
        )

        assert created and not created_again
        assert second == first

    async def test_a_finished_job_frees_its_target(self, db, user_id):
        first, _ = await create_job(
            user_id=user_id, project_id=None, job_type="extract_topics", stage="extracting",
            input_data={}, target_key="extract:p1",
        )
        await db.execute("UPDATE processing_jobs SET status = 'completed' WHERE id = $1", first)

        second, created = await create_job(
            user_id=user_id, project_id=None, job_type="extract_topics", stage="extracting",
            input_data={}, target_key="extract:p1",
        )

        assert created and second != first

    async def test_simultaneous_creates_make_one_job(self, db, user_id):
        results = await asyncio.gather(*[
            create_job(
                user_id=user_id, project_id=None, job_type="generate_content", stage="generating",
                input_data={}, target_key="content:t1:section_notes",
            )
            for _ in range(6)
        ])

        assert len({job_id for job_id, _ in results}) == 1
        assert [created for _, created in results].count(True) == 1

    async def test_jobs_without_a_target_are_not_limited(self, db, user_id):
        await seed_job(db, user_id)
        await seed_job(db, user_id)
        assert await db.fetchval("SELECT count(*) FROM processing_jobs") == 2


class TestPool:
    async def test_pool_size_and_command_timeout_come_from_settings(self, db):
        assert settings.DB_POOL_MAX_SIZE == 20
        assert db.get_max_size() == settings.DB_POOL_MAX_SIZE
        assert settings.DB_COMMAND_TIMEOUT_SECONDS == 60

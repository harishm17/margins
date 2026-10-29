"""The shared AI status: what marks it down and up, the owner alert, GET /status/ai, and the
calls that are refused while it is down (jobs, chat, voice).

The status lives in the test Postgres (see conftest.py), like the job tests.
"""
import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import HTTPException

from app.config import settings
from app.main import app
from app.models.jobs import JobPayload
from app.services import ai_status
from app.services.job_runner import JobOutcome, job_handler
from app.services.llm.base import (
    LLMAuthError,
    LLMCreditError,
    LLMMessage,
    LLMOutputError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMUnavailableError,
)
from app.services.llm.mock_provider import MockProvider
from app.services.llm.observed import ObservedProvider
from tests.db_helpers import get_job, seed_job, seed_project, seed_usage, seed_user


@pytest.fixture
def alerts(monkeypatch):
    sent = []

    async def post(url, text):
        sent.append((url, text))

    monkeypatch.setattr(ai_status, "_post_alert", post)
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://hooks.example.test/x")
    monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key")
    return sent


async def call(method, path, **kwargs):
    """The app in this test's event loop, so it shares the test database pool."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


async def row(db):
    return await db.fetchrow("SELECT * FROM ai_status WHERE id = 'global'")


class TestMarking:
    async def test_no_row_means_available(self, db):
        assert (await ai_status.get_status()).available

    @pytest.mark.parametrize("error", [LLMCreditError("credit balance is too low"), LLMAuthError("bad key")])
    async def test_a_provider_level_failure_marks_it_down_at_once_and_alerts_once(self, db, alerts, error):
        await ai_status.record_failure(error)
        await ai_status.wait_for_alerts()

        status = await ai_status.get_status()
        assert (status.available, status.reason) == (False, error.code)
        first = await row(db)
        assert len(alerts) == 1 and error.code in alerts[0][1]

        await ai_status.record_failure(error)
        await ai_status.wait_for_alerts()

        assert len(alerts) == 1  # still down: no second alert
        again = await row(db)
        assert again["since"] == first["since"] and again["checked_at"] >= first["checked_at"]

    async def test_transient_failures_count_only_when_they_repeat(self, db, alerts, monkeypatch):
        monkeypatch.setattr(settings, "AI_STATUS_TRANSIENT_THRESHOLD", 3)
        for _ in range(2):
            await ai_status.record_failure(LLMUnavailableError("overloaded"))
        assert (await ai_status.get_status()).available

        await ai_status.record_failure(LLMRateLimitError("429"))

        status = await ai_status.get_status()
        assert (status.available, status.reason) == (False, "LLM_RATE_LIMITED")

    async def test_a_success_in_between_resets_the_transient_count(self, db, alerts, monkeypatch):
        monkeypatch.setattr(settings, "AI_STATUS_TRANSIENT_THRESHOLD", 2)
        await ai_status.record_failure(LLMUnavailableError("overloaded"))
        await ai_status.record_success()
        await ai_status.record_failure(LLMUnavailableError("overloaded"))
        assert (await ai_status.get_status()).available

    async def test_any_successful_call_clears_it(self, db, alerts):
        await ai_status.record_failure(LLMCreditError("credit"))

        await ai_status.record_success()

        assert (await ai_status.get_status()).available
        assert (await row(db))["state"] == "available"

    @pytest.mark.parametrize("error", [LLMRefusalError("no"), LLMOutputError("cut off")])
    async def test_a_call_the_provider_answered_counts_as_reachable(self, db, alerts, error):
        await ai_status.record_failure(LLMCreditError("credit"))

        await ai_status.record_failure(error)

        assert (await ai_status.get_status()).available

    async def test_a_stale_record_reads_available_and_a_new_failure_is_not_a_new_outage(
        self, db, alerts, monkeypatch
    ):
        await ai_status.record_failure(LLMCreditError("credit"))
        await ai_status.wait_for_alerts()
        since = (await row(db))["since"]
        old = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=settings.AI_STATUS_TTL_S + 5)
        await db.execute("UPDATE ai_status SET checked_at = $1", old)

        # Expired: the next real call tests the provider again.
        assert (await ai_status.get_status()).available

        await ai_status.record_failure(LLMCreditError("credit"))
        await ai_status.wait_for_alerts()
        assert not (await ai_status.get_status()).available
        assert (await row(db))["since"] == since
        assert len(alerts) == 1

    async def test_no_key_is_unavailable_without_a_row(self, db, monkeypatch):
        monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
        status = await ai_status.get_status()
        assert (status.available, status.reason) == (False, "LLM_NOT_CONFIGURED")

    async def test_the_mock_provider_reports_available(self, db, monkeypatch):
        monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
        assert (await ai_status.get_status()).available

    async def test_no_webhook_means_no_alert(self, db, monkeypatch):
        sent = []

        async def post(url, text):
            sent.append(text)

        monkeypatch.setattr(ai_status, "_post_alert", post)
        monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "")
        await ai_status.record_failure(LLMCreditError("credit"))
        await ai_status.wait_for_alerts()
        assert sent == []

    async def test_a_database_problem_never_fails_the_caller(self, monkeypatch):
        async def broken(*args, **kwargs):
            raise RuntimeError("database went away")

        monkeypatch.setattr(ai_status, "execute_one", broken)
        monkeypatch.setattr(ai_status, "execute_in_transaction", broken)
        monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
        ai_status.reset_local_state()

        await ai_status.record_failure(LLMCreditError("credit"))
        await ai_status.record_success()
        assert (await ai_status.get_status()).available


class TestRecoveryAlert:
    async def test_one_alert_when_it_goes_down_and_one_when_it_comes_back_with_how_long(self, db, alerts):
        await ai_status.record_failure(LLMCreditError("credit"))
        # It went down 2 h 5 min ago.
        await db.execute(
            "UPDATE ai_status SET since = (NOW() AT TIME ZONE 'UTC') - interval '2 hours 5 minutes'"
        )

        await ai_status.record_success()
        await ai_status.record_success()
        await ai_status.wait_for_alerts()

        assert len(alerts) == 2
        assert "unavailable" in alerts[0][1]
        assert "available again after 2 h 5 min" in alerts[1][1]
        assert "LLM_CREDIT_EXHAUSTED" in alerts[1][1]

    async def test_only_the_process_that_makes_the_change_alerts(self, db, alerts):
        await ai_status.record_failure(LLMCreditError("credit"))
        await ai_status.wait_for_alerts()

        # Two processes that both last saw it down get a success at the same time.
        await asyncio.gather(ai_status.record_success(), _other_process_success())
        await ai_status.wait_for_alerts()

        assert len([text for _, text in alerts if "available again" in text]) == 1

    async def test_two_first_failures_at_once_alert_once_even_before_the_row_exists(self, db, alerts):
        # A fresh database: the conftest empties ai_status after each test, like a new deploy
        # before the migration's row existed.
        await db.execute("DELETE FROM ai_status")

        await asyncio.gather(*(ai_status._mark_unavailable("LLM_CREDIT_EXHAUSTED", "x") for _ in range(4)))
        await ai_status.wait_for_alerts()

        assert len([text for _, text in alerts if "unavailable" in text]) == 1

    async def test_no_recovery_alert_without_an_outage(self, db, alerts):
        ai_status.reset_local_state()
        await ai_status.record_success()
        await ai_status.wait_for_alerts()
        assert alerts == []

    def test_durations_read_plainly(self):
        assert ai_status.format_duration(40) == "40 s"
        assert ai_status.format_duration(12 * 60 + 5) == "12 min"
        assert ai_status.format_duration(3600) == "1 h"
        assert ai_status.format_duration(2 * 3600 + 5 * 60) == "2 h 5 min"


async def _other_process_success():
    # A second process: its own memory says the AI may be down, so it tries to clear the row too.
    ai_status._local["state"] = None
    await ai_status.record_success()


class TestObservedProvider:
    async def test_the_mock_can_fail_like_the_api_and_every_call_reports(self, db, alerts):
        provider = ObservedProvider(MockProvider())

        with pytest.raises(LLMCreditError):
            await provider.generate_text(
                [LLMMessage(role="user", content="Notes on MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTED")],
                purpose="notes",
            )
        assert (await ai_status.get_status()).reason == "LLM_CREDIT_EXHAUSTED"

        await provider.generate_text([LLMMessage(role="user", content="Notes")], purpose="notes")
        assert (await ai_status.get_status()).available

    def test_the_mock_can_fail_a_set_number_of_times_then_recover(self):
        from app.services.llm.mock_provider import _raise_if_asked

        marker = "answer MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTEDx2@t1 here"
        for _ in range(2):
            with pytest.raises(LLMCreditError):
                _raise_if_asked(marker)
        _raise_if_asked(marker)  # the outage is over
        with pytest.raises(LLMCreditError):
            _raise_if_asked("MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTED")  # without a count: always

    async def test_streams_report_too(self, db, alerts):
        provider = ObservedProvider(MockProvider())

        with pytest.raises(LLMCreditError):
            async for _ in provider.stream_turn(
                system="coach", messages=[{"role": "user", "content": "MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTED"}],
                tools=[],
            ):
                pass

        assert not (await ai_status.get_status()).available


async def mark_down(reason="LLM_CREDIT_EXHAUSTED"):
    await ai_status._mark_unavailable(reason, "test")


class TestRefusedWhileDown:
    async def test_a_job_that_uses_the_model_is_refused_with_the_reason(self, db, alerts):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id)
        await mark_down()
        calls = []

        @job_handler(job_type="generate_content", label="Test job", default_error_code="TEST_FAILED", uses_llm=True)
        async def handler(payload, job):
            calls.append(job.id)
            return JobOutcome()

        with pytest.raises(HTTPException) as raised:
            await handler(JobPayload(jobId=job_id, jobType="generate_content", data={}))

        assert raised.value.status_code == 400
        assert calls == []
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"], job["retryable"]) == ("failed", "LLM_CREDIT_EXHAUSTED", False)

    async def test_a_transient_outage_sends_the_job_back_for_a_retry(self, db, alerts):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id)
        await mark_down("LLM_UNAVAILABLE")

        @job_handler(job_type="generate_content", label="Test job", default_error_code="TEST_FAILED", uses_llm=True)
        async def handler(payload, job):
            return JobOutcome()

        with pytest.raises(HTTPException) as raised:
            await handler(JobPayload(jobId=job_id, jobType="generate_content", data={}))

        assert raised.value.status_code == 503
        job = await get_job(db, job_id)
        assert (job["status"], job["error_code"]) == ("pending", "LLM_UNAVAILABLE")

    async def test_jobs_that_do_not_use_the_model_still_run(self, db, alerts):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id, "chunk_material")
        await mark_down()

        @job_handler(job_type="chunk_material", label="Chunking", default_error_code="CHUNKING_FAILED")
        async def handler(payload, job):
            return JobOutcome()

        result = await handler(JobPayload(jobId=job_id, jobType="chunk_material", data={}))
        assert result["status"] == "success"

    @pytest.mark.parametrize("path,body", [
        ("/chat/answer", {"question": "What is hashing?", "history": []}),
        ("/voice/turn", {"session_id": "s1", "system": "coach", "messages": [{"role": "user", "content": "hi"}]}),
    ])
    async def test_chat_and_voice_are_refused_before_anything_streams(self, db, alerts, path, body):
        user_id = await seed_user(db)
        project_id = await seed_project(db, user_id)
        await mark_down()

        response = await call("POST", path, json={"project_id": project_id, "user_id": user_id, **body})

        assert response.status_code == 503
        assert response.json()["error_code"] == "LLM_CREDIT_EXHAUSTED"
        assert response.json()["retryable"] is False


class TestStatusRoute:
    async def test_available_with_the_users_allowance(self, db, alerts, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 8.0)
        monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 40.0)
        user_id = await seed_user(db)
        await seed_usage(db, user_id, 2.0)

        body = (await call("GET", "/status/ai", params={"user_id": user_id})).json()

        assert body["available"] is True and body["reason"] is None and body["since"] is None
        assert body["allowance"]["used"] == pytest.approx(2.0)
        assert body["allowance"]["limit"] == 8.0
        assert body["allowance"]["resets_at"].endswith("T00:00:00Z")
        assert body["global_cap_hit"] is False

    async def test_down_and_the_global_cap(self, db, alerts, monkeypatch):
        monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 1.0)
        user_id = await seed_user(db)
        await seed_usage(db, user_id, 2.0)
        await mark_down()

        body = (await call("GET", "/status/ai")).json()

        assert (body["available"], body["reason"]) == (False, "LLM_CREDIT_EXHAUSTED")
        assert body["since"].endswith("Z")
        assert body["allowance"] is None
        assert body["global_cap_hit"] is True

    async def test_no_per_user_cap_has_no_limit(self, db, alerts, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 0)
        user_id = await seed_user(db)
        body = (await call("GET", "/status/ai", params={"user_id": user_id})).json()
        assert body["allowance"]["limit"] is None


def test_alert_payload_suits_discord_slack_and_ntfy(monkeypatch):
    import asyncio

    posts = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, **kwargs):
            posts.append((url, kwargs))

            class Response:
                status_code = 204

            return Response()

    monkeypatch.setattr(ai_status.httpx, "AsyncClient", FakeClient)
    asyncio.run(ai_status._post_alert("https://discord.example.test/api/webhooks/1", "down"))
    asyncio.run(ai_status._post_alert("https://ntfy.sh/margins-ops", "down"))

    assert posts[0][1]["json"] == {"content": "down", "text": "down"}
    assert posts[1][1]["content"] == b"down"
    assert json.dumps(posts[0][1]["json"])  # serialisable

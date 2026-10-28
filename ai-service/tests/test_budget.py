"""The daily budget sums the append-only usage ledger, so deleting things cannot lower it."""
import pytest

from app.config import settings
from app.services import budget as budget_module
from app.services.budget import global_spent_today_usd, over_budget_message, record_usage_event, spent_today_usd
from tests.db_helpers import seed_chat_message, seed_chat_thread, seed_project, seed_usage, seed_user

pytestmark = pytest.mark.asyncio

TWO_DAYS_AGO = "SQL:(NOW() AT TIME ZONE 'UTC') - interval '2 days'"


@pytest.fixture(autouse=True)
def budget(monkeypatch):
    monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.00)


async def user_with_project(db):
    user_id = await seed_user(db)
    return user_id, await seed_project(db, user_id)


async def test_spend_adds_jobs_and_chat_answers(db):
    user_id, project_id = await user_with_project(db)
    await seed_usage(db, user_id, 0.30, source="job", project_id=project_id)
    await seed_usage(db, user_id, 0.45, source="chat", project_id=project_id)

    assert await spent_today_usd(user_id) == pytest.approx(0.75)
    assert await over_budget_message(user_id) is None


async def test_job_spend_alone_can_use_up_the_budget(db):
    user_id, _ = await user_with_project(db)
    await seed_usage(db, user_id, 1.25, source="job")

    message = await over_budget_message(user_id)
    assert message is not None and "$1.25 of $1.00" in message


async def test_chat_spend_alone_can_use_up_the_budget(db):
    user_id, _ = await user_with_project(db)
    await seed_usage(db, user_id, 1.10, source="chat")

    message = await over_budget_message(user_id)
    assert message is not None and "$1.10 of $1.00" in message


async def test_jobs_and_chat_together_cross_the_line(db):
    user_id, _ = await user_with_project(db)
    await seed_usage(db, user_id, 0.60, source="job")
    await seed_usage(db, user_id, 0.50, source="chat")

    assert await over_budget_message(user_id) is not None


async def test_deleting_a_chat_thread_does_not_lower_the_total(db):
    user_id, project_id = await user_with_project(db)
    thread_id = await seed_chat_thread(db, user_id, project_id)
    message_id = await seed_chat_message(db, thread_id, cost=1.10)
    await seed_usage(db, user_id, 1.10, source="chat", project_id=project_id)

    await db.execute("DELETE FROM chat_threads WHERE id = $1", thread_id)

    assert await db.fetchval("SELECT count(*) FROM chat_messages WHERE id = $1", message_id) == 0
    assert await spent_today_usd(user_id) == pytest.approx(1.10)
    assert await over_budget_message(user_id) is not None


async def test_deleting_a_project_does_not_lower_the_total(db):
    user_id, project_id = await user_with_project(db)
    thread_id = await seed_chat_thread(db, user_id, project_id)
    await seed_chat_message(db, thread_id, cost=0.40)
    await seed_usage(db, user_id, 0.40, source="chat", project_id=project_id)
    await seed_usage(db, user_id, 0.70, source="job", project_id=project_id)

    await db.execute("DELETE FROM projects WHERE id = $1", project_id)

    assert await db.fetchval("SELECT count(*) FROM chat_threads") == 0
    assert await spent_today_usd(user_id) == pytest.approx(1.10)
    assert await over_budget_message(user_id) is not None


async def test_deleting_the_user_unlinks_their_ledger_and_the_global_total_keeps_it(db):
    # Account deletion (web app, src/server/account/delete-account.ts) relies on the foreign key
    # setting user_id to NULL: the rows stay, so deleting an account cannot lower the global total.
    user_id, _ = await user_with_project(db)
    await seed_usage(db, user_id, 2.0)
    await db.execute("DELETE FROM users WHERE id = $1", user_id)
    assert await db.fetchval("SELECT count(*) FROM llm_usage_events WHERE user_id IS NULL") == 1
    assert await spent_today_usd(user_id) == 0
    assert await global_spent_today_usd() == pytest.approx(2.0)


async def test_other_users_and_earlier_days_do_not_count(db):
    user_id, _ = await user_with_project(db)
    other, _ = await user_with_project(db)
    await seed_usage(db, other, 9)
    await seed_usage(db, user_id, 9, created_at=TWO_DAYS_AGO)

    assert await spent_today_usd(user_id) == 0
    assert await over_budget_message(user_id) is None


async def test_zero_turns_the_budget_off(db, monkeypatch):
    monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 0)
    monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 0)
    user_id, _ = await user_with_project(db)
    await seed_usage(db, user_id, 500)

    assert await over_budget_message(user_id) is None


class TestGlobalBudget:
    """One cap for all users together, over the same ledger and the same student-facing copy."""

    @pytest.fixture(autouse=True)
    def caps(self, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 3.00)
        monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 5.00)
        budget_module._global_log.update(at=None, blocked=0)

    async def test_the_default_is_forty_dollars(self):
        from app.config import Settings

        assert Settings(DATABASE_URL="postgresql://x/y").GLOBAL_DAILY_LLM_BUDGET_USD == 40.00

    async def test_many_users_under_their_own_cap_can_use_up_the_global_one(self, db):
        spenders = [await user_with_project(db) for _ in range(3)]
        for user_id, _ in spenders:
            await seed_usage(db, user_id, 1.80)  # each is under the 3.00 cap; together 5.40
        newcomer, _ = await user_with_project(db)

        assert await spent_today_usd(newcomer) == 0
        assert await global_spent_today_usd() == pytest.approx(5.40)
        message = await over_budget_message(newcomer)
        assert message is not None and "whole service" in message

    async def test_under_the_global_cap_nobody_is_stopped(self, db):
        user_id, _ = await user_with_project(db)
        other, _ = await user_with_project(db)
        await seed_usage(db, other, 2.50)

        assert await over_budget_message(user_id) is None

    async def test_the_per_user_cap_still_applies_first(self, db):
        user_id, _ = await user_with_project(db)
        await seed_usage(db, user_id, 3.50)

        message = await over_budget_message(user_id)
        assert message is not None and "$3.50 of $3.00" in message

    async def test_yesterdays_spend_does_not_count(self, db):
        user_id, _ = await user_with_project(db)
        await seed_usage(db, user_id, 9.00, created_at=TWO_DAYS_AGO)

        assert await global_spent_today_usd() == 0
        assert await over_budget_message(user_id) is None

    async def test_zero_turns_the_global_cap_off(self, db, monkeypatch):
        monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 0)
        user_id, _ = await user_with_project(db)
        other, _ = await user_with_project(db)
        await seed_usage(db, other, 2.90)
        await seed_usage(db, user_id, 2.90)

        assert await over_budget_message(user_id) is None

    async def test_tripping_it_logs_a_line_with_the_figures_once_a_minute(self, db, caplog):
        spender, _ = await user_with_project(db)
        await seed_usage(db, spender, 6.00)
        user_id, _ = await user_with_project(db)

        with caplog.at_level("WARNING", logger="app.services.budget"):
            await over_budget_message(user_id)
            await over_budget_message(user_id)
            await over_budget_message(user_id)

        lines = [r.getMessage() for r in caplog.records if "GLOBAL daily LLM budget reached" in r.getMessage()]
        assert len(lines) == 1
        assert "$6.00 of $5.00" in lines[0]

    async def test_the_job_runner_fails_the_job_with_the_allowance_code(self, db):
        from app.services.job_runner import DailyBudgetExceeded, _enforce_ai_ready, JobContext

        spender, _ = await user_with_project(db)
        await seed_usage(db, spender, 6.00)
        user_id, project_id = await user_with_project(db)
        job = JobContext(id="j", job_type="generate_content", user_id=user_id, project_id=project_id,
                         attempt=1, max_attempts=3, lease_seconds=60)

        with pytest.raises(DailyBudgetExceeded) as raised:
            await _enforce_ai_ready(job)
        assert raised.value.code == "LLM_DAILY_BUDGET"


async def test_record_usage_event_appends_and_skips_free_calls(db):
    user_id, project_id = await user_with_project(db)
    args = dict(user_id=user_id, project_id=project_id, source="job", source_id="j1", models="m")
    await record_usage_event(**args, input_tokens=10, output_tokens=5, cost_usd=0.25)
    await record_usage_event(**args, input_tokens=0, output_tokens=0, cost_usd=0)

    assert await db.fetchval("SELECT count(*) FROM llm_usage_events") == 1
    assert await spent_today_usd(user_id) == pytest.approx(0.25)


async def test_spend_after_the_account_was_deleted_is_kept_unlinked(db):
    # A job that was running when its account was deleted: the foreign key refuses the user, so the
    # row is written without one, and the money still counts toward the global cap.
    await record_usage_event(
        user_id="deleted-user", project_id="gone", source="job", source_id="j", models="m",
        input_tokens=1, output_tokens=1, cost_usd=1.0,
    )
    row = await db.fetchrow("SELECT user_id, project_id, source_id, cost_usd FROM llm_usage_events")
    assert row["user_id"] is None and row["project_id"] is None and row["source_id"] == ""
    assert float(row["cost_usd"]) == pytest.approx(1.0)
    assert await global_spent_today_usd() == pytest.approx(1.0)


async def test_a_ledger_failure_is_logged_not_raised(db, monkeypatch, caplog):
    # The database refuses the row: the work that was billed must not fail.
    async def broken(*args, **kwargs):
        raise RuntimeError("database is down")

    monkeypatch.setattr(budget_module, "execute_update", broken)
    user_id, _ = await user_with_project(db)
    with caplog.at_level("ERROR", logger="app.services.budget"):
        await record_usage_event(
            user_id=user_id, project_id=None, source="job", source_id="j", models="", input_tokens=1,
            output_tokens=1, cost_usd=1.0,
        )
    assert any("Could not record job usage" in r.getMessage() for r in caplog.records)
    assert await db.fetchval("SELECT count(*) FROM llm_usage_events") == 0

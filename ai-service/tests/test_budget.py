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


@pytest.mark.parametrize(
    "spends, shown",
    [
        ([("job", 1.25)], "$1.25 of $1.00"),
        ([("chat", 1.10)], "$1.10 of $1.00"),
        ([("job", 0.60), ("chat", 0.50)], None),
    ],
    ids=["job_alone", "chat_alone", "job_and_chat_together"],
)
async def test_job_or_chat_spend_can_use_up_the_budget(db, spends, shown):
    user_id, _ = await user_with_project(db)
    for source, amount in spends:
        await seed_usage(db, user_id, amount, source=source)

    message = await over_budget_message(user_id)
    assert message is not None
    if shown:
        assert shown in message


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
    # A plain user delete still keeps the rows: the foreign key sets user_id to NULL
    # (delete_user_account also clears project_id and source_id; test_account_deletion_ledger.py).
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


@pytest.mark.parametrize(
    "user_cap, global_cap, spends",
    [(0, 0, [500]), (3.00, 0, [2.90, 2.90])],
    ids=["both_caps_off", "global_cap_off"],
)
async def test_zero_turns_the_budget_off(db, monkeypatch, user_cap, global_cap, spends):
    monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", user_cap)
    monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", global_cap)
    user_id, _ = await user_with_project(db)
    for amount in spends[:-1]:
        other, _ = await user_with_project(db)
        await seed_usage(db, other, amount)
    await seed_usage(db, user_id, spends[-1])

    assert await over_budget_message(user_id) is None


class TestGlobalBudget:
    """One cap for all users together, over the same ledger and the same student-facing copy."""

    @pytest.fixture(autouse=True)
    def caps(self, monkeypatch):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 3.00)
        monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 5.00)
        budget_module._global_log.update(at=None, blocked=0)

    async def test_many_users_under_their_own_cap_can_use_up_the_global_one(self, db):
        spenders = [await user_with_project(db) for _ in range(3)]
        for user_id, _ in spenders:
            await seed_usage(db, user_id, 1.80)  # each is under the 3.00 cap; together 5.40
        newcomer, _ = await user_with_project(db)

        assert await spent_today_usd(newcomer) == 0
        assert await global_spent_today_usd() == pytest.approx(5.40)
        message = await over_budget_message(newcomer)
        assert message is not None and "whole service" in message


    async def test_the_per_user_cap_still_applies_first(self, db):
        user_id, _ = await user_with_project(db)
        await seed_usage(db, user_id, 3.50)

        message = await over_budget_message(user_id)
        assert message is not None and "$3.50 of $3.00" in message


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



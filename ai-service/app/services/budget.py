"""The daily LLM budgets, shared by background jobs, chat and voice: one per user and one for
everyone together.

Spend is read from the `llm_usage_events` ledger, which is append-only: a row is written when a
job attempt or a chat answer has cost something, and nothing deletes it when the job, thread or
project it came from is deleted. Deleting an account unlinks its rows (user_id becomes NULL)
rather than deleting them, so they still count toward the global cap. So removing things cannot
lower the day's total. A "day" is the current UTC day. The check runs before a call starts, so one
call can end a little over the cap.

Sign-up is open and the API key is shared, so on top of the per-user cap there is a global one
(GLOBAL_DAILY_LLM_BUDGET_USD) over the same ledger: once every user together has spent it, no
call starts for anyone until midnight UTC. Students see the same allowance message for both
(their screens never show dollar amounts); the figures are only in logs and job errors.
"""
import logging
import time
import uuid
from typing import Optional

from app.config import settings
from app.db.connection import UTC_NOW, execute_one, execute_update

logger = logging.getLogger(__name__)


async def record_usage_event(
    *,
    user_id: str,
    project_id: Optional[str],
    source: str,
    source_id: str,
    models: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
) -> None:
    """Append one row to the ledger. `source` is 'job', 'chat' or 'voice'; nothing is written for
    a call that cost nothing. Never raises: a ledger failure must not fail the work that was billed
    (a retry would bill it again), so it is logged loudly instead.

    A call that finishes after its account was deleted (a job that was already running) is kept
    too: a trigger on the table (migration 20261121000000_account_deletion) clears the user,
    project and source ids instead of letting the foreign key refuse the row, the same rule for the
    web app's chat route. So the money still counts toward the global daily cap."""
    if cost_usd <= 0 and input_tokens <= 0 and output_tokens <= 0:
        return
    try:
        await execute_update(
            f"""
            INSERT INTO llm_usage_events
                (id, user_id, project_id, source, source_id, models,
                 input_tokens, output_tokens, cost_usd, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, {UTC_NOW})
            """,
            uuid.uuid4().hex,
            user_id,
            project_id,
            source,
            source_id,
            models,
            input_tokens,
            output_tokens,
            cost_usd,
        )
    except Exception:
        logger.exception(
            "Could not record %s usage (user %s, source %s, $%.6f): it will not count toward the daily budget",
            source, user_id, source_id, cost_usd,
        )


async def spent_today_usd(user_id: str) -> float:
    """What the user's jobs and chat answers have cost since midnight UTC."""
    row = await execute_one(
        f"""
        SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent
        FROM llm_usage_events
        WHERE user_id = $1
          AND created_at >= date_trunc('day', {UTC_NOW})
        """,
        user_id,
    )
    return float(row["spent"]) if row else 0.0


async def global_spent_today_usd() -> float:
    """What every user's jobs, chat answers and voice turns have cost since midnight UTC."""
    row = await execute_one(
        f"""
        SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent
        FROM llm_usage_events
        WHERE created_at >= date_trunc('day', {UTC_NOW})
        """
    )
    return float(row["spent"]) if row else 0.0


# The global cap blocks every call for the rest of the day, so it is logged, but at most once a
# minute (with how many calls it stopped) rather than on each of them.
_GLOBAL_LOG_INTERVAL_SECONDS = 60.0
_global_log = {"at": None, "blocked": 0}


def _log_global_trip(spent: float, budget: float) -> None:
    _global_log["blocked"] += 1
    now = time.monotonic()
    last = _global_log["at"]
    if last is not None and now - last < _GLOBAL_LOG_INTERVAL_SECONDS:
        return
    logger.warning(
        "GLOBAL daily LLM budget reached: $%.2f of $%.2f spent today (UTC) by all users; "
        "%s call(s) refused since the last report. Calls resume after midnight UTC or when "
        "GLOBAL_DAILY_LLM_BUDGET_USD is raised.",
        spent, budget, _global_log["blocked"],
    )
    _global_log["at"] = now
    _global_log["blocked"] = 0


async def over_budget_message(user_id: str) -> Optional[str]:
    """None while the user may start another LLM call; otherwise what to tell them.

    Two caps apply: the user's own (DAILY_LLM_BUDGET_USD) and the one for all users together
    (GLOBAL_DAILY_LLM_BUDGET_USD). Either one set to 0 is off.
    """
    message = await _over_user_budget(user_id)
    if message:
        return message
    global_budget = settings.GLOBAL_DAILY_LLM_BUDGET_USD
    if global_budget <= 0:
        return None
    global_spent = await global_spent_today_usd()
    if global_spent < global_budget:
        return None
    _log_global_trip(global_spent, global_budget)
    return (
        f"Daily AI usage limit reached for the whole service (${global_spent:.2f} of "
        f"${global_budget:.2f} used today, UTC). It is available again after midnight UTC."
    )


async def _over_user_budget(user_id: str) -> Optional[str]:
    budget = settings.DAILY_LLM_BUDGET_USD
    if budget <= 0:
        return None
    spent = await spent_today_usd(user_id)
    if spent < budget:
        return None
    # The dollar figures are for logs and the job's error message. Students never see them: the
    # frontend shows its own copy for LLM_DAILY_BUDGET, with the reset time in their timezone.
    message = (
        f"Daily AI usage limit reached (${spent:.2f} of ${budget:.2f} used today, UTC). "
        "It is available again after midnight UTC."
    )
    logger.info("User %s is over the daily AI budget: %s", user_id, message)
    return message

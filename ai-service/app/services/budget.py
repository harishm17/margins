"""The daily LLM allowance, shared by background jobs, chat, voice, tutor and grading: one per account and one for
everyone together. `allowance_today` is the one function that decides; the billing scope (billing.py) calls it before
every model call, the status route and the web app's allowance view read it.

Spend is read from the `llm_usage_events` ledger, which is append-only: a row is written for every model call, and
nothing deletes it when the job, thread or project it came from is deleted. Rows are summed by `spend_key`, a one-way
key derived from the Google account (frontend/src/lib/account/spend-key.ts) that the account-deletion function keeps
on the rows it unlinks, so deleting an account and signing in again does not reset the day's allowance. A "day" is the
current UTC day. The check runs before a call starts, so one call can end a little over the cap.

Sign-up is open and the API key is shared, so on top of the per-account cap there is a global one
(GLOBAL_DAILY_LLM_BUDGET_USD) over the same ledger, of which the share GLOBAL_RESERVE_SHARE is kept for accounts older
than GLOBAL_RESERVE_MIN_AGE_DAYS. New accounts also have a smaller first-day allowance. Students see the web app's own
text for each refusal (their screens never show dollar amounts); the figures are only in logs and job errors.
"""
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from app.config import settings
from app.db.connection import UTC_NOW, execute_one, execute_update
from app.services import ai_status, ops

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
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> None:
    """Append one row to the ledger. `source` is 'job', 'chat', 'voice', 'tutor', 'recall', 'quiz' or 'drill'; nothing
    is written for a call that cost nothing. `input_tokens` includes the cache reads and writes, which are also given
    apart (`usage.ledger_figures` makes all of these from a list of calls). Never raises: a ledger failure must not
    fail the work that was billed (a retry would bill it again), so it is logged loudly instead.

    A call that finishes after its account was deleted (a job that was already running) is kept too: a trigger on the
    table (migrations 20261121000000_account_deletion and 20261208000000_spend_key_and_drill_sets) clears the user,
    project and source ids instead of letting the foreign key refuse the row, and stamps the account's spend_key from
    its tombstone. So the money still counts toward the global daily cap and the account's allowance."""
    if cost_usd <= 0 and input_tokens <= 0 and output_tokens <= 0:
        return
    try:
        await execute_update(
            f"""
            INSERT INTO llm_usage_events
                (id, user_id, project_id, source, source_id, models,
                 input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_write_tokens, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, {UTC_NOW})
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
            cache_read_tokens,
            cache_write_tokens,
        )
    except Exception as exc:
        logger.exception(
            "Could not record %s usage (user %s, source %s, $%.6f): it will not count toward the daily budget",
            source, user_id, source_id, cost_usd,
        )
        await ops.note("ledger_write_failed", f"{source} ${cost_usd:.4f} not in the ledger: {exc!r}")


class DailyBudgetExceeded(Exception):
    """The allowance is used up: the call is refused before it starts. Jobs treat it like the AI being unavailable
    (see job_runner); routes answer 429 LLM_DAILY_BUDGET (main.py)."""

    code = "LLM_DAILY_BUDGET"
    retryable = False

    def __init__(self, message: str, reason: Optional[str] = None):
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class Allowance:
    """What one account may still spend today. `limit_usd` is None when no per-account cap applies. `refused` is why
    a call is refused now, or None: "user" (the day's allowance is spent), "first_day" (the smaller allowance of an
    account under 24 hours old), "reserve" (a young account while the shared cap is down to the share kept for older
    accounts) or "global" (the shared cap is spent). `message` is for logs and job errors; students see the web
    app's own text for the reason."""

    limit_usd: Optional[float]
    used_usd: float
    resets_at: datetime
    refused: Optional[str] = None
    message: Optional[str] = None


async def _account_facts(user_id: str) -> tuple[Optional[str], Optional[float]]:
    """(spend_key, account age in seconds) of the user. A deleted account (a job still running) is found by its
    tombstone. A user with no key yet has none, and their spend is read by user_id."""
    row = await execute_one(
        f"""
        SELECT u.spend_key,
               EXTRACT(EPOCH FROM ({UTC_NOW} - COALESCE(sa.first_seen_at, u.created_at)))::float8 AS age_seconds
        FROM users u
        LEFT JOIN spend_accounts sa ON sa.spend_key = u.spend_key
        WHERE u.id = $1
        """,
        user_id,
    )
    if row is not None:
        return row["spend_key"], row["age_seconds"]
    row = await execute_one(
        f"""
        SELECT d.spend_key,
               EXTRACT(EPOCH FROM ({UTC_NOW} - sa.first_seen_at))::float8 AS age_seconds
        FROM deleted_accounts d
        LEFT JOIN spend_accounts sa ON sa.spend_key = d.spend_key
        WHERE d.user_id = $1
        """,
        user_id,
    )
    return (row["spend_key"], row["age_seconds"]) if row else (None, None)


async def _spent_today(user_id: str, spend_key: Optional[str]) -> float:
    # Rows not stamped yet (before the web app's backfill ran) are still the user's, by user_id.
    row = await execute_one(
        f"""
        SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent
        FROM llm_usage_events
        WHERE created_at >= date_trunc('day', {UTC_NOW})
          AND (spend_key = $1 OR (spend_key IS NULL AND user_id = $2))
        """,
        spend_key,
        user_id,
    )
    return float(row["spent"]) if row else 0.0


async def spent_today_usd(user_id: str) -> float:
    """What the account (every sign-in it ever had, by spend_key) has spent since midnight UTC."""
    spend_key, _ = await _account_facts(user_id)
    return await _spent_today(user_id, spend_key)


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


# The global cap blocks calls for the rest of the day, so it is logged, but at most once a
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


async def allowance_today(user_id: str) -> Allowance:
    """The one place that decides whether an account may start another model call.

    Per account (by spend_key, so deleting and re-creating the account does not reset it): DAILY_LLM_BUDGET_USD, or
    FIRST_DAY_LLM_BUDGET_USD while the account is under 24 hours old. For everyone together: GLOBAL_DAILY_LLM_BUDGET_USD;
    an account younger than GLOBAL_RESERVE_MIN_AGE_DAYS is refused once the day's global spend reaches
    (1 - GLOBAL_RESERVE_SHARE) of it, so a few new accounts cannot use up what older accounts rely on. A cap set to 0
    is off.
    """
    # Vision's half allowance (PR 8) is decided here too: it will lower `limit` for that purpose.
    resets_at = ai_status.next_reset_utc()
    spend_key, age_seconds = await _account_facts(user_id)
    spent = await _spent_today(user_id, spend_key)

    limit: Optional[float] = None
    reason = "user"
    if settings.DAILY_LLM_BUDGET_USD > 0:
        limit = settings.DAILY_LLM_BUDGET_USD
        first_day = settings.FIRST_DAY_LLM_BUDGET_USD
        if first_day > 0 and age_seconds is not None and age_seconds < 24 * 3600 and first_day < limit:
            limit, reason = first_day, "first_day"
    if limit is not None and spent >= limit:
        message = (
            f"Daily AI usage limit reached (${spent:.2f} of ${limit:.2f} used today, UTC"
            f"{', first-day allowance' if reason == 'first_day' else ''}). It is available again after midnight UTC."
        )
        logger.info("User %s is over the daily AI budget: %s", user_id, message)
        return Allowance(limit, spent, resets_at, reason, message)

    global_budget = settings.GLOBAL_DAILY_LLM_BUDGET_USD
    if global_budget > 0:
        global_spent = await global_spent_today_usd()
        if global_spent >= global_budget:
            _log_global_trip(global_spent, global_budget)
            message = (
                f"Daily AI usage limit reached for the whole service (${global_spent:.2f} of "
                f"${global_budget:.2f} used today, UTC). It is available again after midnight UTC."
            )
            return Allowance(limit, spent, resets_at, "global", message)
        young = age_seconds is None or age_seconds < settings.GLOBAL_RESERVE_MIN_AGE_DAYS * 86400
        if young and global_spent >= global_budget * (1 - settings.GLOBAL_RESERVE_SHARE):
            _log_global_trip(global_spent, global_budget)
            message = (
                f"New accounts are paused for today: the service is at ${global_spent:.2f} of ${global_budget:.2f} "
                "(UTC), and the rest is kept for older accounts. It is available again after midnight UTC."
            )
            return Allowance(limit, spent, resets_at, "reserve", message)
    return Allowance(limit, spent, resets_at)


async def over_budget_message(user_id: str) -> Optional[str]:
    """None while the user may start another LLM call; otherwise what to tell them (see `allowance_today`)."""
    return (await allowance_today(user_id)).message

"""Whether the AI provider can be used right now, for every user at once.

Every job, chat answer and voice turn used to find out on its own that the provider was down
(out of credit, say), after the student had already asked for something. This module keeps one
shared answer in the `ai_status` table (one row, id 'global'; the schema is a Prisma migration):

- A provider-level failure marks it unavailable: out of credit, a rejected key, no key, or a
  rate limit or outage that keeps coming back after the SDK's own retries
  (AI_STATUS_TRANSIENT_THRESHOLD failures in a row in this process).
- Any successful model call marks it available again. So does any call the provider answered,
  even with a refusal or unusable output: the provider is reachable.
- An unavailable row older than AI_STATUS_TTL_S counts as unknown, and `get_status` reports
  available: the next real call tests the provider again. There is no paid probe.

The change from available to unavailable is logged and, when OPS_ALERT_WEBHOOK_URL is set, posted
to that webhook (Discord, Slack or ntfy) once. Writing the row is best effort: a database problem
here never fails the call it describes.
"""
import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Set

import httpx

from app.config import settings
from app.db.connection import UTC_NOW, execute_in_transaction, execute_one
from app.services.llm.base import (
    LLMAuthError,
    LLMCreditError,
    LLMError,
    LLMNotConfiguredError,
    LLMRateLimitError,
    LLMUnavailableError,
)

logger = logging.getLogger(__name__)

AVAILABLE = "available"
UNAVAILABLE = "unavailable"

# Codes that mean the provider cannot serve anyone until the owner acts.
PROVIDER_DOWN_CODES = {LLMCreditError.code, LLMAuthError.code, LLMNotConfiguredError.code}
# Codes that count only when they keep coming back.
TRANSIENT_CODES = {LLMRateLimitError.code, LLMUnavailableError.code}

_ERROR_TYPES = {
    LLMCreditError.code: LLMCreditError,
    LLMAuthError.code: LLMAuthError,
    LLMNotConfiguredError.code: LLMNotConfiguredError,
    LLMRateLimitError.code: LLMRateLimitError,
    LLMUnavailableError.code: LLMUnavailableError,
}

# What this process last knew, so a successful call writes to the database only when the row
# may say unavailable (every job, chat answer and voice turn reads the row first, so this is fresh).
_local = {"state": None, "transient_failures": 0}
_background: Set["asyncio.Task[None]"] = set()


@dataclass
class AiStatus:
    available: bool
    reason: Optional[str] = None
    since: Optional[datetime] = None
    checked_at: Optional[datetime] = None

    def as_error(self) -> Optional[LLMError]:
        """The error a call refused because of this status raises, typed by its reason."""
        if self.available:
            return None
        error_type = _ERROR_TYPES.get(self.reason or "", LLMUnavailableError)
        error = error_type(f"AI is marked unavailable ({self.reason}) since {self.since}")
        if error.retryable:
            error.retry_after = 30
        return error


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    """Rows hold UTC wall time without a zone (Prisma's DateTime)."""
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


async def get_status() -> AiStatus:
    """The shared status. A database error reads as available: this check must never be the
    thing that stops the app (the call itself will find out)."""
    if not settings.llm_configured:
        return AiStatus(False, LLMNotConfiguredError.code)
    try:
        row = await execute_one(
            "SELECT state, reason, since, checked_at FROM ai_status WHERE id = 'global'"
        )
    except Exception as exc:
        logger.warning("Could not read the AI status: %s", exc)
        return AiStatus(True)
    if row is None or row["state"] != UNAVAILABLE:
        _local["state"] = AVAILABLE
        return AiStatus(True, since=_utc(row["since"]) if row else None)
    _local["state"] = UNAVAILABLE
    checked_at = _utc(row["checked_at"])
    if checked_at and datetime.now(timezone.utc) - checked_at > timedelta(seconds=settings.AI_STATUS_TTL_S):
        # Stale: let the next real call find out. It refreshes the row if it fails the same way.
        return AiStatus(True)
    return AiStatus(False, row["reason"], _utc(row["since"]), checked_at)


async def record_failure(exc: LLMError) -> None:
    """A model call failed. Provider-level failures mark the status unavailable; any other
    failure (a refusal, unusable output) means the provider answered."""
    try:
        if exc.code in PROVIDER_DOWN_CODES:
            await _mark_unavailable(exc.code, str(exc))
        elif exc.code in TRANSIENT_CODES:
            _local["transient_failures"] += 1
            if _local["transient_failures"] >= settings.AI_STATUS_TRANSIENT_THRESHOLD:
                await _mark_unavailable(exc.code, str(exc))
        else:
            await record_success()
    except Exception:
        logger.exception("Could not record the AI status after %s", exc.code)


async def record_success() -> None:
    """A model call worked: clear an unavailable status."""
    _local["transient_failures"] = 0
    if _local["state"] == AVAILABLE:
        return
    try:
        row = await execute_one(
            f"""
            WITH previous AS (
                SELECT since FROM ai_status WHERE id = 'global' AND state = '{UNAVAILABLE}' FOR UPDATE
            )
            UPDATE ai_status
            SET state = '{AVAILABLE}', reason = NULL, detail = NULL,
                since = {UTC_NOW}, checked_at = {UTC_NOW}
            FROM previous
            WHERE ai_status.id = 'global'
            RETURNING previous.since AS down_since
            """
        )
    except Exception:
        logger.exception("Could not record that the AI provider is available again")
        return
    _local["state"] = AVAILABLE
    if row is not None:
        logger.warning("AI status: available again (unavailable since %s)", _utc(row["down_since"]))


async def _mark_unavailable(reason: str, detail: str) -> None:
    async def write(conn):
        previous = await conn.fetchrow(
            "SELECT state, since FROM ai_status WHERE id = 'global' FOR UPDATE"
        )
        changed = previous is None or previous["state"] != UNAVAILABLE
        row = await conn.fetchrow(
            f"""
            INSERT INTO ai_status (id, state, reason, since, checked_at, detail)
            VALUES ('global', '{UNAVAILABLE}', $1, {UTC_NOW}, {UTC_NOW}, $2)
            ON CONFLICT (id) DO UPDATE SET
                state = EXCLUDED.state,
                reason = EXCLUDED.reason,
                detail = EXCLUDED.detail,
                checked_at = EXCLUDED.checked_at,
                since = CASE WHEN $3 THEN EXCLUDED.since ELSE ai_status.since END
            RETURNING since
            """,
            reason,
            detail[:2000],
            changed,
        )
        return changed, _utc(row["since"])

    changed, since = await execute_in_transaction(write)
    _local["state"] = UNAVAILABLE
    logger.warning(
        "AI status: unavailable reason=%s since=%s changed=%s detail=%s",
        reason, since, changed, detail[:500],
    )
    if changed:
        _alert(f"Margins: AI is unavailable ({reason}) since {since:%Y-%m-%d %H:%M} UTC. {detail[:300]}")


def _alert(text: str) -> None:
    """Post to OPS_ALERT_WEBHOOK_URL in the background, if it is set. Never raises."""
    url = settings.OPS_ALERT_WEBHOOK_URL.strip()
    if not url:
        return
    task = asyncio.create_task(_post_alert(url, text))
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _post_alert(url: str, text: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if "ntfy" in httpx.URL(url).host:
                # ntfy publishes the request body as the message.
                response = await client.post(url, content=text.encode(), headers={"Title": "Margins AI"})
            else:
                # Discord reads "content", Slack reads "text"; each ignores the other.
                response = await client.post(url, json={"content": text, "text": text})
        if response.status_code >= 400:
            logger.error("The ops alert webhook answered %s", response.status_code)
    except Exception as exc:
        logger.error("Could not post the ops alert: %r", exc)


async def wait_for_alerts() -> None:
    """Wait for alerts in flight (tests)."""
    while _background:
        await asyncio.gather(*list(_background), return_exceptions=True)


def reset_local_state() -> None:
    """Forget what this process knew (tests)."""
    _local["state"] = None
    _local["transient_failures"] = 0


def next_reset_utc(now: Optional[datetime] = None) -> datetime:
    """The daily allowances reset at midnight UTC."""
    now = now or datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=1)

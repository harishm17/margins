"""What the operator hears about: failures recorded where they happen, facts the watchdog checks, alerts.

A failure that is handled and logged where it happens (a ledger write, a status write, a dispatch) used to stay in
the log, and nothing read the log. `note` also counts it in `ops_events`, where the watchdog
(app/services/watchdog.py) reads it. When the database itself is the problem the count is kept in this process
instead, and the watchdog reads that too, so a failure is never lost because the place it is recorded failed.

`set_state` and `get_state` keep single facts in `ops_state`: when the watchdog and the voice purge last ran, when the
nightly backup last succeeded, which embedding model wrote the stored vectors.

`alert` posts to OPS_ALERT_WEBHOOK_URL (ntfy, Discord or Slack) at most once per kind per OPS_ALERT_COOLDOWN_SECONDS.
The cooldown is a row in `ops_alerts`, claimed by an update that only one process can win, so two replicas or a
restart never send the same alert twice; if the database cannot be reached the cooldown is kept in this process.
"""
import asyncio
import logging
import time
from collections import Counter

import httpx

from app.config import settings
from app.db.connection import UTC_NOW, execute_one, execute_update

logger = logging.getLogger(__name__)

# Failures that could not be written to ops_events, by kind, until the watchdog reads them.
_unrecorded: Counter = Counter()
# Alert cooldowns used only when ops_alerts cannot be reached: kind -> monotonic time sent.
_local_cooldown: dict[str, float] = {}
_background: set["asyncio.Task[None]"] = set()


async def note(kind: str, detail: str | None = None) -> None:
    """Count a handled failure of `kind` for the watchdog. Never raises."""
    try:
        await execute_update(
            "INSERT INTO ops_events (kind, source, detail, created_at) VALUES ($1, 'ai', $2, "
            f"{UTC_NOW})",
            kind,
            (detail or "")[:500] or None,
        )
    except Exception as exc:
        _unrecorded[kind] += 1
        logger.warning("Could not record ops event %s: %s", kind, exc)


def take_unrecorded() -> dict[str, int]:
    """The failures `note` could not write since the last call, by kind (the watchdog adds them in)."""
    counts = dict(_unrecorded)
    _unrecorded.clear()
    return counts


async def set_state(key: str, value: str) -> None:
    await execute_update(
        f"""
        INSERT INTO ops_state (key, value, updated_at) VALUES ($1, $2, {UTC_NOW})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        """,
        key,
        value,
    )


async def get_state(key: str) -> str | None:
    row = await execute_one("SELECT value FROM ops_state WHERE key = $1", key)
    return row["value"] if row else None


async def alert(kind: str, title: str, text: str, cooldown_seconds: float | None = None) -> bool:
    """Send `text` unless an alert of this kind went out within the cooldown. Returns whether it was sent.

    The cooldown is claimed before posting, so two processes never both send. A post the webhook does not take
    gives the claim back, so the next watchdog run tries again instead of staying quiet for the whole cooldown.
    """
    if not settings.OPS_ALERT_WEBHOOK_URL.strip():
        logger.warning("Ops alert (no webhook set) %s: %s", kind, text)
        return False
    cooldown = settings.OPS_ALERT_COOLDOWN_SECONDS if cooldown_seconds is None else cooldown_seconds
    claimed_in_db = False
    try:
        claimed = await execute_one(
            f"""
            INSERT INTO ops_alerts (kind, last_sent_at, last_message) VALUES ($1, {UTC_NOW}, $2)
            ON CONFLICT (kind) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at, last_message = EXCLUDED.last_message
            WHERE ops_alerts.last_sent_at < {UTC_NOW} - make_interval(secs => $3::float8)
            RETURNING kind
            """,
            kind,
            text[:2000],
            float(cooldown),
        )
        if claimed is None:
            return False
        claimed_in_db = True
    except Exception as exc:
        logger.warning("Could not read the alert cooldown for %s, keeping it in this process: %s", kind, exc)
        sent_at = _local_cooldown.get(kind)
        if sent_at is not None and time.monotonic() - sent_at < cooldown:
            return False
        _local_cooldown[kind] = time.monotonic()
    if await post(title, text):
        return True
    if claimed_in_db:
        try:
            await execute_update("DELETE FROM ops_alerts WHERE kind = $1", kind)
        except Exception as exc:
            logger.warning("Could not give back the alert cooldown for %s: %s", kind, exc)
    else:
        _local_cooldown.pop(kind, None)
    return False


def post_in_background(title: str, text: str) -> None:
    """`post` without waiting for it (callers on a request path). Never raises."""
    if not settings.OPS_ALERT_WEBHOOK_URL.strip():
        return
    task = asyncio.create_task(post(title, text))
    _background.add(task)
    task.add_done_callback(_background.discard)


async def post(title: str, text: str) -> bool:
    """Post one message to OPS_ALERT_WEBHOOK_URL, titled "Margins: <title>". Returns whether the webhook took it.

    Never raises. The webhook is a third party (an ntfy topic): callers send counts and kinds, never user ids, file
    paths or error text, which stay in the logs.
    """
    url = settings.OPS_ALERT_WEBHOOK_URL.strip()
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if "ntfy" in httpx.URL(url).host:
                # ntfy publishes the request body as the message and the Title header as its title.
                response = await client.post(
                    url, content=text.encode(), headers={"Title": f"Margins: {title}", "Tags": "warning"}
                )
            else:
                # Discord reads "content", Slack reads "text"; each ignores the other.
                message = f"Margins: {title}. {text}"
                response = await client.post(url, json={"content": message, "text": message})
        if response.status_code >= 400:
            logger.error("The ops alert webhook answered %s", response.status_code)
            return False
    except Exception as exc:
        logger.error("Could not post the ops alert: %s", exc)
        return False
    return True


async def ping_deadman() -> None:
    """Tell the external dead-man check (OPS_DEADMAN_URL, e.g. a healthchecks.io ping URL) the watchdog ran."""
    url = settings.OPS_DEADMAN_URL.strip()
    if not url:
        return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.get(url)
    except Exception as exc:
        logger.warning("Could not ping the dead-man check: %s", exc)


async def wait_for_alerts() -> None:
    """Wait for alerts in flight (tests)."""
    while _background:
        await asyncio.gather(*list(_background), return_exceptions=True)


def reset_local_state() -> None:
    """Forget this process's counts and cooldowns (tests)."""
    _unrecorded.clear()
    _local_cooldown.clear()

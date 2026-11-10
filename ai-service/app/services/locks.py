"""Locks on the work done for one topic, unit or attempt, shared by every worker (Postgres advisory locks).

`topic_lock(key, exclusive=...)` replaces the old in-process lock: that one only worked while a single
process served every job, and a second replica (or a deploy that overlaps the old one) ran the same
topic's jobs side by side. Keys: `topic:<id>`, `unit:<id>`, `attempt:<id>`.

Concept extraction and concept linking take the lock exclusive, because they rewrite the topic's concept
graph. Content generation and review items also take it exclusive for now, which keeps today's order (one
content job per topic at a time); PR 7's PARALLEL_TOPIC_JOBS moves them to shared. The gap explainer locks
its own attempt, so it no longer waits behind the topic's generation.

The lock lives on its own connection for as long as the block runs (a session-level advisory lock belongs to its
connection). Those connections come from a pool of their own (connection.get_lock_pool), so jobs holding locks never
take the connections interactive routes, heartbeats and ledger writes need. It is taken with `pg_try_advisory_lock*`
in a loop with a short, jittered sleep instead of a blocking call, and the connection goes back to the pool between
tries, so a waiting job holds none; a cancelled job or a shutdown stops waiting at once. It is always released in
`finally`. If the process dies, the database drops the lock with the connection.
"""
import asyncio
import logging
import random
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from app.config import settings
from app.db.connection import get_lock_pool

logger = logging.getLogger(__name__)

# Keys are hashed to a bigint in SQL, so every worker agrees on the number without sharing code.
_KEY = "hashtextextended($1, 0)"
_TRY = {True: f"SELECT pg_try_advisory_lock({_KEY})", False: f"SELECT pg_try_advisory_lock_shared({_KEY})"}
_UNLOCK = {True: f"SELECT pg_advisory_unlock({_KEY})", False: f"SELECT pg_advisory_unlock_shared({_KEY})"}

POLL_SECONDS = 0.25


class LockWaitTimeout(RuntimeError):
    """The lock stayed held by another job for TOPIC_LOCK_WAIT_SECONDS. Transient: the job is retried."""


@asynccontextmanager
async def topic_lock(key: str, *, exclusive: bool) -> AsyncIterator[None]:
    """Hold the advisory lock for `key` (exclusive, or shared with other shared holders) for the block."""
    pool = await get_lock_pool()
    deadline = time.monotonic() + settings.TOPIC_LOCK_WAIT_SECONDS
    while True:
        conn = None
        try:
            conn = await pool.acquire(timeout=max(0.1, deadline - time.monotonic()))
            if await conn.fetchval(_TRY[exclusive], key):
                break
        except asyncio.TimeoutError:
            pass  # every lock connection is held: wait like a taken lock
        except BaseException:
            if conn is not None:
                await pool.release(conn)
            raise
        if conn is not None:
            await pool.release(conn)  # hold no connection while waiting
        if time.monotonic() >= deadline:
            raise LockWaitTimeout(f"Waited {settings.TOPIC_LOCK_WAIT_SECONDS:g}s for the lock on {key}")
        await asyncio.sleep(POLL_SECONDS * (0.5 + random.random()))
    try:
        yield
    finally:
        try:
            # Shielded: a cancelled job must still give the lock back before its connection is reused.
            await asyncio.shield(conn.fetchval(_UNLOCK[exclusive], key))
        except Exception:
            logger.warning("Could not release the lock on %s; dropping its connection", key)
            conn.terminate()
        finally:
            await asyncio.shield(pool.release(conn))

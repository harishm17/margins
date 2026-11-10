"""Advisory locks shared by every worker (app/services/locks.py): the behaviour is in Postgres."""
import asyncio

import pytest

from app.config import settings
from app.services.locks import LockWaitTimeout, topic_lock


async def test_an_exclusive_holder_keeps_shared_and_exclusive_waiters_out(db, monkeypatch):
    monkeypatch.setattr(settings, "TOPIC_LOCK_WAIT_SECONDS", 0.3)
    async with topic_lock("topic:a", exclusive=True):
        for exclusive in (True, False):
            with pytest.raises(LockWaitTimeout):
                async with topic_lock("topic:a", exclusive=exclusive):
                    pass
    monkeypatch.setattr(settings, "TOPIC_LOCK_WAIT_SECONDS", 2)
    async with asyncio.timeout(3):  # released at the end of the block
        async with topic_lock("topic:a", exclusive=True):
            pass


async def test_shared_holders_run_together_but_keep_an_exclusive_one_out(db, monkeypatch):
    monkeypatch.setattr(settings, "TOPIC_LOCK_WAIT_SECONDS", 0.3)
    async with topic_lock("topic:b", exclusive=False):
        async with asyncio.timeout(2):
            async with topic_lock("topic:b", exclusive=False):
                pass
        with pytest.raises(LockWaitTimeout):
            async with topic_lock("topic:b", exclusive=True):
                pass


async def test_a_cancelled_holder_releases_the_lock(db, monkeypatch):
    holder_started = asyncio.Event()

    async def hold():
        async with topic_lock("topic:c", exclusive=True):
            holder_started.set()
            await asyncio.sleep(30)

    task = asyncio.create_task(hold())
    await holder_started.wait()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    monkeypatch.setattr(settings, "TOPIC_LOCK_WAIT_SECONDS", 2)
    async with topic_lock("topic:c", exclusive=True):
        pass

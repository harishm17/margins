import asyncio

import pytest
from fastapi import HTTPException

from app.api.disconnect import run_unless_disconnected


class FakeRequest:
    def __init__(self, gone_after: float | None):
        self._gone_after = gone_after
        self._start = asyncio.get_event_loop().time()

    async def is_disconnected(self) -> bool:
        return self._gone_after is not None and asyncio.get_event_loop().time() - self._start >= self._gone_after


async def test_a_call_is_cancelled_when_the_caller_leaves():
    state = {"cancelled": False, "finished": False}

    async def model_call():
        try:
            await asyncio.sleep(30)
            state["finished"] = True
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    with pytest.raises(HTTPException) as caught:
        await run_unless_disconnected(FakeRequest(0.05), model_call(), poll_seconds=0.02)
    assert caught.value.status_code == 499
    assert state == {"cancelled": True, "finished": False}


async def test_a_call_that_finishes_returns_its_result():
    async def model_call():
        await asyncio.sleep(0.01)
        return "answer"

    assert await run_unless_disconnected(FakeRequest(None), model_call(), poll_seconds=0.02) == "answer"

"""Stop a model call when the caller has gone away.

The web server drops the connection when the student leaves (closes the tab, navigates away). The non-streaming
model routes (tutor, grading, drills) would otherwise run to the end and pay for an answer nobody reads, holding
a model slot meanwhile. Each of them awaits its model work through `run_unless_disconnected`, which runs it as a
task and cancels it as soon as the request reports a disconnect. The route's own `finally` (usage recording) still
runs, so what was spent is on the ledger. Streaming routes (chat, voice turn) already stop when their stream is
closed.
"""
import asyncio
from typing import Awaitable, TypeVar

from fastapi import HTTPException, Request

T = TypeVar("T")

# nginx's code for "the client closed the request"; the caller is gone, so nobody reads it.
CLIENT_CLOSED_REQUEST = 499
POLL_SECONDS = 0.5


async def run_unless_disconnected(request: Request, work: Awaitable[T], *, poll_seconds: float = POLL_SECONDS) -> T:
    task = asyncio.ensure_future(work)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=poll_seconds)
            if done:
                return task.result()
            if await request.is_disconnected():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise HTTPException(status_code=CLIENT_CLOSED_REQUEST, detail="Client closed the request")
    finally:
        if not task.done():
            # This route was itself cancelled: do not leave the model call running.
            task.cancel()

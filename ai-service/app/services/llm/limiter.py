"""Limits on model calls inside this process.

`llm_slot()` wraps every model call (all providers, jobs and chat alike): at most
LLM_MAX_CONCURRENCY calls run at once, the rest wait their turn. This keeps a burst of jobs
(for example "Prepare all topics now") under the account's rate limit instead of failing
part of it with 429s.

Two lanes share the slots. A call is `interactive` (a student is waiting: chat, tutor, voice,
grading) unless it runs inside `background_lane()` (job handlers). Background work holds at most
LLM_MAX_CONCURRENCY - 1 slots, so one is always free for a student, and a freed slot goes to a
waiting interactive call first. An interactive call that has waited LLM_INTERACTIVE_WAIT_SECONDS
for a slot gives up with `LLMBusyError` rather than hanging the student's request; background
calls wait for as long as it takes.

Topic locks (which used to live here) are Postgres advisory locks now: app/services/locks.py.
"""
import asyncio
import logging
from collections import deque
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import AsyncIterator, Deque, Iterator, Optional, Tuple

from app.config import settings
from app.services.llm.base import LLMBusyError

logger = logging.getLogger(__name__)

INTERACTIVE = "interactive"
BACKGROUND = "background"

_lane: ContextVar[str] = ContextVar("llm_lane", default=INTERACTIVE)


@contextmanager
def background_lane() -> Iterator[None]:
    """Model calls made inside this block (and in tasks started from it) count as background work."""
    token = _lane.set(BACKGROUND)
    try:
        yield
    finally:
        _lane.reset(token)


class _Slots:
    """The slots of one event loop and one limit. Waiters are granted in priority order
    (interactive first, each lane first come first served)."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.background_cap = max(1, limit - 1)
        self.active = 0
        self.background_active = 0
        self._waiters: Deque[Tuple[str, "asyncio.Future[None]"]] = deque()

    def _may_take(self, lane: str) -> bool:
        if self.active >= self.limit:
            return False
        return lane == INTERACTIVE or self.background_active < self.background_cap

    def _next(self) -> Optional[Tuple[str, "asyncio.Future[None]"]]:
        for lane in (INTERACTIVE, BACKGROUND):
            for entry in self._waiters:
                if entry[0] == lane and not entry[1].done():
                    if self._may_take(lane):
                        return entry
                    break
        return None

    def _grant(self) -> None:
        while (entry := self._next()) is not None:
            self._waiters.remove(entry)
            self.active += 1
            if entry[0] == BACKGROUND:
                self.background_active += 1
            entry[1].set_result(None)

    def release(self, lane: str) -> None:
        self.active -= 1
        if lane == BACKGROUND:
            self.background_active -= 1
        self._grant()

    async def acquire(self, lane: str, wait: Optional[float]) -> None:
        future: "asyncio.Future[None]" = asyncio.get_running_loop().create_future()
        entry = (lane, future)
        self._waiters.append(entry)
        self._grant()
        try:
            if wait is None:
                await future
            else:
                async with asyncio.timeout(wait):
                    await future
        except BaseException as exc:
            if future.done() and not future.cancelled():
                self.release(lane)  # granted at the moment we left: give it back
            else:
                future.cancel()
                if entry in self._waiters:
                    self._waiters.remove(entry)
                self._grant()
            if isinstance(exc, TimeoutError):
                raise LLMBusyError(f"All {self.limit} model slots stayed busy for {wait:g} seconds") from exc
            raise


_slots: Optional[Tuple[asyncio.AbstractEventLoop, int, _Slots]] = None


def _current_slots() -> _Slots:
    """The process-wide slots. They belong to one event loop and one limit; a different loop
    (tests start a new one each) or a changed LLM_MAX_CONCURRENCY gets fresh ones."""
    global _slots
    loop = asyncio.get_running_loop()
    limit = max(1, settings.LLM_MAX_CONCURRENCY)
    if _slots is None or _slots[0] is not loop or _slots[1] != limit:
        _slots = (loop, limit, _Slots(limit))
    return _slots[2]


@asynccontextmanager
async def llm_slot() -> AsyncIterator[None]:
    """Hold one of the LLM_MAX_CONCURRENCY slots for the length of a model call."""
    lane = _lane.get()
    slots = _current_slots()
    await slots.acquire(lane, settings.LLM_INTERACTIVE_WAIT_SECONDS if lane == INTERACTIVE else None)
    try:
        yield
    finally:
        slots.release(lane)

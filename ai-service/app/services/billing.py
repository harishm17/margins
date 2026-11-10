"""The billing scope: every model call is made for an account, checked against its allowance, and written to the ledger.

    async with billed(user_id, project_id, "chat", thread_id):
        ...  # every call the provider makes in here is billed to that account

`LLMFactory.get_provider()` returns a provider (`BillingProvider`, below) that

1. refuses a call made outside any scope (`UnbilledModelCall`), so a new call site cannot forget to bill;
2. checks `allowance_today(user_id)` before each call and raises `DailyBudgetExceeded` when it is spent;
3. writes one `llm_usage_events` row for each call as soon as the call returns or fails with usage. The write is
   shielded from cancellation, so a student who closes the tab or a job that is killed still pays for the calls
   already made. A stream that is cut off is billed for the usage it had reported so far (the input tokens at least).

`unbilled(reason)` is for evals, replay recording, scripts and tests: no check and no row. Production code under app/
does not use it (tests/test_billing.py greps for it).

The scope is a ContextVar, so a scope opened inside a streaming response's generator covers the stream. Open it there,
not in the route function: Starlette iterates the generator in another task, after the route has returned.
"""
import asyncio
import logging
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator, List, Optional, Type

from app.services.budget import DailyBudgetExceeded, allowance_today, record_usage_event
from app.services.llm.base import (
    AnswerEvent,
    LLMMessage,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    SchemaT,
    TurnEvent,
)
from app.services.llm.usage import billing_sink, ledger_figures

logger = logging.getLogger(__name__)


class UnbilledModelCall(RuntimeError):
    """A model call was made with no billing scope open: it would be free to the student and invisible to the budget."""


@dataclass(frozen=True)
class Scope:
    user_id: str
    project_id: Optional[str]
    source: str
    source_id: str
    # Set for unbilled scopes: why, for the log.
    unbilled_reason: Optional[str] = None

    @property
    def billed(self) -> bool:
        return self.unbilled_reason is None


_scope: ContextVar[Optional[Scope]] = ContextVar("billing_scope", default=None)


def current_scope() -> Optional[Scope]:
    return _scope.get()


@contextmanager
def _entered(scope: Scope) -> Iterator[None]:
    token = _scope.set(scope)
    try:
        yield
    finally:
        try:
            _scope.reset(token)
        except ValueError:  # an abandoned stream closed from another task: its context is gone with it
            pass


@asynccontextmanager
async def billed(
    user_id: str, project_id: Optional[str], source: str, source_id: Optional[str] = None
) -> AsyncIterator[Scope]:
    """Bill every model call made inside the block to `user_id`. `source` is 'job', 'chat', 'voice', 'tutor', 'recall',
    'quiz' or 'drill'; `source_id` names the thing it was for (job id, voice session id)."""
    if not user_id:
        raise ValueError("A billing scope needs a user_id")
    scope = Scope(user_id, project_id, source, source_id or "")
    with _entered(scope):
        yield scope


@contextmanager
def unbilled(reason: str) -> Iterator[Scope]:
    """No allowance check and no ledger row for the model calls made inside the block (evals, scripts, tests)."""
    if not reason:
        raise ValueError("unbilled() needs a reason")
    scope = Scope("", None, "unbilled", "", unbilled_reason=reason)
    with _entered(scope):
        yield scope


@dataclass
class _Call:
    """The usage one model call reports (see usage.record_usage and usage.note_partial_usage)."""

    usages: List[LLMUsage] = field(default_factory=list)
    seen: Optional[LLMUsage] = None

    def add(self, usage: LLMUsage) -> None:
        self.usages.append(usage)

    def partial(self, usage: LLMUsage) -> None:
        self.seen = usage


# Ledger writes in flight. A task nobody references can be collected before it finishes.
_writes: set[asyncio.Task] = set()


async def _write(scope: Scope, call: _Call) -> None:
    usages = call.usages or ([call.seen] if call.seen is not None else [])
    if not usages:
        return
    task = asyncio.ensure_future(
        record_usage_event(
            user_id=scope.user_id,
            project_id=scope.project_id,
            source=scope.source,
            source_id=scope.source_id,
            **ledger_figures(usages),
        )
    )
    _writes.add(task)
    task.add_done_callback(_writes.discard)
    # Cancelling the caller cancels this wait, not the write. record_usage_event never raises.
    await asyncio.shield(task)


async def _begin() -> Optional[tuple[Scope, _Call]]:
    scope = _scope.get()
    if scope is None:
        raise UnbilledModelCall(
            "A model call was made outside a billing scope: open `billed(...)` (or `unbilled(reason)` in a script or test)"
        )
    if not scope.billed:
        return None
    allowance = await allowance_today(scope.user_id)
    if allowance.refused:
        raise DailyBudgetExceeded(allowance.message or "Daily AI usage limit reached", allowance.refused)
    return scope, _Call()


class BillingProvider(LLMProvider):
    """The provider every caller gets (factory.py): the configured one, inside the billing scope."""

    def __init__(self, inner: LLMProvider):
        self.inner = inner

    def __getattr__(self, name: str) -> Any:
        # Anything else (the SDK client, test hooks) is the wrapped provider's.
        return getattr(self.inner, name)

    def model_for(self, purpose: str) -> Optional[str]:
        return self.inner.model_for(purpose)

    async def generate_text(self, messages: List[LLMMessage], *, purpose: str, max_tokens: int = 16000) -> LLMResponse:
        begun = await _begin()
        if begun is None:
            return await self.inner.generate_text(messages, purpose=purpose, max_tokens=max_tokens)
        scope, call = begun
        try:
            with billing_sink(call):
                return await self.inner.generate_text(messages, purpose=purpose, max_tokens=max_tokens)
        finally:
            await _write(scope, call)

    async def generate_structured(
        self, messages: List[LLMMessage], schema: Type[SchemaT], *, purpose: str, max_tokens: int = 16000
    ) -> SchemaT:
        begun = await _begin()
        if begun is None:
            return await self.inner.generate_structured(messages, schema, purpose=purpose, max_tokens=max_tokens)
        scope, call = begun
        try:
            with billing_sink(call):
                return await self.inner.generate_structured(messages, schema, purpose=purpose, max_tokens=max_tokens)
        finally:
            await _write(scope, call)

    async def _stream(self, events: AsyncIterator[Any]) -> AsyncIterator[Any]:
        """Pass a stream through, billing it once when it ends however it ends: finished, failed, cancelled or closed
        early. The call's usage is reported while the inner stream runs, so the sink is set only while it advances."""
        begun = await _begin()
        if begun is None:
            async for event in events:
                yield event
            return
        scope, call = begun
        try:
            while True:
                with billing_sink(call):
                    try:
                        event = await events.__anext__()
                    except StopAsyncIteration:
                        break
                yield event
        finally:
            try:
                with billing_sink(call):
                    await events.aclose()  # type: ignore[attr-defined]
            finally:
                await _write(scope, call)

    def stream_cited_answer(self, **kwargs: Any) -> AsyncIterator[AnswerEvent]:
        return self._stream(self.inner.stream_cited_answer(**kwargs))

    def stream_turn(self, **kwargs: Any) -> AsyncIterator[TurnEvent]:
        return self._stream(self.inner.stream_turn(**kwargs))

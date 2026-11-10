"""The Message Batches API under the app's own provider, for evals nobody waits on (half price).

`install_batching(provider)` puts a `BatchedCalls` where the app's Anthropic provider keeps its client. The provider still
builds every request and reads every reply itself; only `client.beta.messages.create` changes: the call joins a queue,
the queue goes out as one batch once no new call has joined it for `quiet` seconds, and each caller gets its own reply
when the batch ends. The generators run as they do in the app (concurrently across topics), so each step of every topic
lands in the same batch.

A batch request carries no beta header and no server fallback (`betas`, `fallbacks`): fallback answers an overloaded
model at once, which a batch has no need of. A reply that failed on the server's side (overloaded, an API error,
expired) is sent again once, in a later batch; a request the API calls invalid fails at once.
"""
import asyncio
import itertools
import time
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple

# Not sent in a batch request (see the module docstring).
DROPPED_PARAMS = ("betas", "fallbacks")
RETRYABLE = {"api_error", "overloaded_error", "rate_limit_error", "timeout_error"}


class BatchRequestError(Exception):
    """A batched call that came back without a reply."""


class BatchedCalls:
    def __init__(self, client, *, quiet: float = 5.0, poll: float = 15.0, max_requests: int = 2000, log: Optional[Callable[[str], None]] = None):
        self.client = client
        self.quiet = quiet
        self.poll = poll
        self.max_requests = max_requests
        self.log = log or (lambda message: None)
        self.batches: List[Dict[str, Any]] = []
        self._queue: List[Tuple[str, Dict[str, Any], asyncio.Future]] = []
        self._timer: Optional[asyncio.Task] = None
        self._last = 0.0
        self._ids = itertools.count(1)
        self._sent_again: set = set()
        self._running: set = set()
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create, stream=self.stream))

    async def create(self, **params) -> Any:
        request = {k: v for k, v in params.items() if k not in DROPPED_PARAMS}
        future = asyncio.get_running_loop().create_future()
        self._enqueue(f"r{next(self._ids)}", request, future)
        return await future

    def stream(self, **params) -> "_BatchedStream":
        """The provider streams a call whose max_tokens is above its streaming threshold (llm/caps.py STREAM_ABOVE).
        A batch has no request timeout to stream around, so the call joins the batch like any other and the
        "stream" hands back the finished message."""
        return _BatchedStream(self.create(**params))


    def _enqueue(self, custom_id: str, request: Dict[str, Any], future: asyncio.Future) -> None:
        self._queue.append((custom_id, request, future))
        self._last = time.monotonic()
        if self._timer is None or self._timer.done():
            self._timer = asyncio.create_task(self._send_when_quiet())

    async def _send_when_quiet(self) -> None:
        while len(self._queue) < self.max_requests:
            wait = self._last + self.quiet - time.monotonic()
            if wait <= 0:
                break
            await asyncio.sleep(wait)
        batch, self._queue = self._queue[: self.max_requests], self._queue[self.max_requests :]
        task = asyncio.create_task(self._run(batch))
        self._running.add(task)
        task.add_done_callback(self._running.discard)
        if self._queue:
            self._timer = asyncio.create_task(self._send_when_quiet())

    async def _run(self, batch: List[Tuple[str, Dict[str, Any], asyncio.Future]]) -> None:
        waiting = {custom_id: (request, future) for custom_id, request, future in batch}
        started = time.monotonic()
        record: Dict[str, Any] = {"id": None, "requests": len(batch), "seconds": None}
        self.batches.append(record)
        try:
            created = await self.client.beta.messages.batches.create(
                requests=[{"custom_id": custom_id, "params": request} for custom_id, request, _ in batch]
            )
            record["id"] = created.id
            self.log(f"  batch {created.id}: {len(batch)} requests sent")
            while (await self.client.beta.messages.batches.retrieve(created.id)).processing_status != "ended":
                await asyncio.sleep(self.poll)
            async for entry in await self.client.beta.messages.batches.results(created.id):
                if entry.custom_id not in waiting:
                    continue
                request, future = waiting.pop(entry.custom_id)
                self._settle(entry.custom_id, request, future, entry.result)
        except Exception as exc:  # the batch itself failed: every call in it fails
            for request, future in waiting.values():
                if not future.done():
                    future.set_exception(BatchRequestError(f"the batch failed: {type(exc).__name__}: {exc}"))
            waiting.clear()
        finally:
            record["seconds"] = round(time.monotonic() - started, 1)
        for request, future in waiting.values():
            if not future.done():
                future.set_exception(BatchRequestError("the batch ended with no result for this request"))
        self.log(f"  batch {record['id']}: ended after {record['seconds']}s")

    def _settle(self, custom_id: str, request: Dict[str, Any], future: asyncio.Future, result) -> None:
        if future.done():
            return
        kind = getattr(result, "type", None)
        if kind == "succeeded":
            future.set_result(result.message)
            return
        detail = getattr(getattr(getattr(result, "error", None), "error", None), "type", None) if kind == "errored" else kind
        if (kind in ("expired", "canceled") or detail in RETRYABLE) and custom_id not in self._sent_again:
            self._sent_again.add(custom_id)
            self._enqueue(custom_id, request, future)
            return
        message = getattr(getattr(getattr(result, "error", None), "error", None), "message", "")
        future.set_exception(BatchRequestError(f"{kind}: {detail}{': ' + message if message else ''}"))


class _BatchedStream:
    """The part of the SDK's message stream the provider uses: `async with`, `async for` over its events, `get_final_message()`, `request_id`."""

    request_id = None

    def __init__(self, reply):
        self._reply = reply

    async def __aenter__(self) -> "_BatchedStream":
        return self

    async def __aexit__(self, *exc) -> None:
        if asyncio.iscoroutine(self._reply):
            self._reply.close()

    def __aiter__(self) -> "_BatchedStream":
        # A batched reply arrives whole, so there are no events: the provider's loop over them ends at once and
        # get_final_message() gives the reply (and its usage).
        return self

    async def __anext__(self) -> Any:
        raise StopAsyncIteration

    async def get_final_message(self) -> Any:
        reply, self._reply = self._reply, None
        return await reply


def install_batching(provider, *, quiet: float = 5.0, poll: float = 15.0, log: Optional[Callable[[str], None]] = None) -> BatchedCalls:
    """Send `provider`'s calls (the app's AnthropicProvider) through the Batches API. The app's limit on calls at once
    (LLM_MAX_CONCURRENCY) is lifted, so every waiting call can join a batch."""
    from app.config import settings

    settings.LLM_MAX_CONCURRENCY = 10_000
    batched = BatchedCalls(provider.client, quiet=quiet, poll=poll, log=log)
    provider.client = batched
    return batched

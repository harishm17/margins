"""Tests for common/batching.py against a fake batches API. No network."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace as NS


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common.batching import BatchedCalls, BatchRequestError  # noqa: E402


class Results:
    def __init__(self, entries):
        self.entries = entries

    def __aiter__(self):
        async def gen():
            for entry in self.entries:
                yield entry

        return gen()


def ok(params):
    return NS(type="succeeded", message=NS(content=[NS(type="text", text=params["messages"][0]["content"])]))


def error(kind):
    return NS(type="errored", error=NS(type="error", error=NS(type=kind, message=f"{kind} happened")))


class FakeBatches:
    """Each create is one batch; `outcome(params, attempt)` answers each request (attempt counts its sends)."""

    def __init__(self, outcome=lambda params, attempt: ok(params), fail_create=False):
        self.outcome = outcome
        self.fail_create = fail_create
        self.created = []
        self.sends = {}

    async def create(self, *, requests, **kwargs):
        if self.fail_create:
            raise RuntimeError("batch refused")
        self.created.append(list(requests))
        return NS(id=f"batch-{len(self.created)}", processing_status="in_progress")

    async def retrieve(self, batch_id):
        return NS(id=batch_id, processing_status="ended")

    async def results(self, batch_id):
        requests = self.created[int(batch_id.split("-")[1]) - 1]
        entries = []
        for request in requests:
            text = request["params"]["messages"][0]["content"]
            self.sends[text] = self.sends.get(text, 0) + 1
            entries.append(NS(custom_id=request["custom_id"], result=self.outcome(request["params"], self.sends[text])))
        return Results(list(reversed(entries)))  # results come in any order


def client_with(batches):
    return NS(beta=NS(messages=NS(batches=batches)))


def params(text):
    return {"model": "m", "max_tokens": 10, "messages": [{"role": "user", "content": text}], "betas": ["x"], "fallbacks": "default"}


def run(coro):
    return asyncio.run(coro)


def test_calls_made_together_go_out_as_one_batch_and_each_caller_gets_its_own_reply():
    batches = FakeBatches()
    calls = BatchedCalls(client_with(batches), quiet=0.02, poll=0.01)

    async def streamed(text):
        # The provider streams a call capped above 16000 tokens; the PR 1.7 A2 re-run failed on every such call because
        # this client had no `stream`. It joins the same batch.
        async with calls.beta.messages.stream(**params(text)) as stream:
            return await stream.get_final_message()

    async def go():
        return await asyncio.gather(*(calls.beta.messages.create(**params(f"q{i}")) for i in range(2)), streamed("q2"))

    replies = run(go())
    assert [r.content[0].text for r in replies] == ["q0", "q1", "q2"]
    assert len(batches.created) == 1 and len(batches.created[0]) == 3
    sent = batches.created[0][0]["params"]
    assert "betas" not in sent and "fallbacks" not in sent  # the batch carries no beta header and no server fallback
    assert calls.batches[0]["requests"] == 3


def test_a_server_error_is_sent_again_once_and_a_bad_request_fails_at_once():
    def outcome(p, attempt):
        text = p["messages"][0]["content"]
        if text == "flaky":
            return error("overloaded_error") if attempt == 1 else ok(p)
        if text == "broken":
            return error("invalid_request_error")
        if text == "down":
            return error("api_error")
        return ok(p)

    batches = FakeBatches(outcome)
    calls = BatchedCalls(client_with(batches), quiet=0.02, poll=0.01)

    async def go():
        return await asyncio.gather(
            calls.beta.messages.create(**params("flaky")),
            calls.beta.messages.create(**params("broken")),
            calls.beta.messages.create(**params("down")),
            return_exceptions=True,
        )

    flaky, broken, down = run(go())
    assert flaky.content[0].text == "flaky"
    assert isinstance(broken, BatchRequestError) and "invalid_request_error" in str(broken)
    assert isinstance(down, BatchRequestError) and "api_error" in str(down)
    assert batches.sends == {"flaky": 2, "broken": 1, "down": 2}



"""POST /voice/turn: the Claude provider's request and content blocks, the mock provider's
script, the NDJSON route, error mapping, the daily budget and the usage ledger."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, List

import pytest
from anthropic.types.beta import BetaRawContentBlockDeltaEvent, BetaTextDelta
from fastapi.testclient import TestClient

from app.api.routes import voice as voice_route
from app.config import settings
from app.main import app
from app.services.budget import Allowance
from app.services.llm.anthropic_provider import AnthropicProvider
from app.services.llm.base import (
    LLMProvider,
    LLMRateLimitError,
    LLMRefusalError,
    LLMUsage,
    TurnDone,
    TurnText,
    TurnToolUse,
)
from app.services.llm.factory import LLMFactory
from app.services.llm.mock_provider import MockProvider
from tests.db_helpers import seed_project, seed_user

TOOLS = [
    {"name": "get_next_question", "description": "Next question", "input_schema": {"type": "object", "properties": {}}},
    {"name": "record_answer", "description": "Record", "input_schema": {"type": "object", "properties": {}}},
]


def delta(text: str) -> BetaRawContentBlockDeltaEvent:
    return BetaRawContentBlockDeltaEvent(
        type="content_block_delta", index=0, delta=BetaTextDelta(type="text_delta", text=text)
    )


def final_message(content, stop_reason="end_turn", model="claude-haiku-5-5", stop_details=None):
    return SimpleNamespace(
        model=model,
        stop_reason=stop_reason,
        stop_details=stop_details,
        content=content,
        usage=SimpleNamespace(
            input_tokens=900, output_tokens=40, cache_read_input_tokens=0, cache_creation_input_tokens=0
        ),
    )


class FakeStream:
    def __init__(self, events: List[Any], final, error: BaseException | None = None):
        self._events, self._final, self._error = events, final, error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def __aiter__(self):
        for event in self._events:
            yield event
        if self._error is not None:
            raise self._error

    async def get_final_message(self):
        return self._final


def claude(events, final, error=None) -> tuple[AnthropicProvider, list]:
    provider = AnthropicProvider(api_key="test-key")
    calls: list = []

    def stream(**params):
        calls.append(params)
        return FakeStream(events, final, error)

    provider.client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    return provider, calls


async def collect(provider, **overrides):
    args = dict(system="Be a coach.", messages=[{"role": "user", "content": "hi"}], tools=TOOLS)
    args.update(overrides)
    return [event async for event in provider.stream_turn(**args)]


# ---- the Claude provider -------------------------------------------------------------------


class TestClaudeTurn:
    async def test_text_streams_then_tool_use_then_done_with_the_blocks_as_returned(self):
        content = [
            SimpleNamespace(type="thinking", thinking="", signature="sig"),
            SimpleNamespace(type="text", text="Let me get one."),
            SimpleNamespace(type="tool_use", id="toolu_1", name="get_next_question", input={}, caller=None),
        ]
        provider, _ = claude([delta("Let me "), delta("get one.")], final_message(content, "tool_use"))
        events = await collect(provider)

        assert [e.type for e in events] == ["text", "text", "tool_use", "done"]
        assert "".join(e.text for e in events if isinstance(e, TurnText)) == "Let me get one."
        assert events[2] == TurnToolUse(id="toolu_1", name="get_next_question", input={})
        done = events[-1]
        assert isinstance(done, TurnDone) and done.stop_reason == "tool_use"
        assert done.content == [
            {"type": "thinking", "thinking": "", "signature": "sig"},
            {"type": "text", "text": "Let me get one."},
            {"type": "tool_use", "id": "toolu_1", "name": "get_next_question", "input": {}},
        ]
        assert done.usage.input_tokens == 900 and done.usage.model == "claude-haiku-5-5"

    async def test_refusal_raises_with_usage(self):
        final = final_message([], "refusal", stop_details=SimpleNamespace(category="cyber"))
        provider, _ = claude([], final)
        with pytest.raises(LLMRefusalError) as caught:
            await collect(provider)
        assert caught.value.usage is not None and caught.value.usage.output_tokens == 40



# ---- the route -----------------------------------------------------------------------------


class ScriptedProvider(LLMProvider):
    def __init__(self, events=None, error=None):
        self.events, self.error, self.calls = events or [], error, []

    async def generate_text(self, *a, **k):
        raise AssertionError("not used")

    async def generate_structured(self, *a, **k):
        raise AssertionError("not used")

    async def stream_cited_answer(self, **k):
        raise AssertionError("not used")

    async def stream_turn(self, **kwargs):
        self.calls.append(kwargs)
        for event in self.events:
            yield event
        if self.error is not None:
            raise self.error


def usage(model="claude-haiku-5-5", **cache):
    return LLMUsage(model=model, purpose="voice", input_tokens=1000, output_tokens=100, **cache)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def wired(monkeypatch):
    """The route with the database, budget and ledger replaced by stand-ins."""
    state: dict = {"budget": None, "project": {"id": "p1"}, "provider": MockProvider()}

    async def execute_one(sql, *args):
        return state["project"]

    async def allowance(user_id):
        state["budget_user"] = user_id
        refused = state["budget"]
        return Allowance(
            limit_usd=3.0, used_usd=3.1 if refused else 0.0, resets_at=datetime.now(timezone.utc),
            refused="user" if refused else None, message=refused,
        )

    monkeypatch.setattr(voice_route, "execute_one", execute_one)
    monkeypatch.setattr(voice_route, "allowance_today", allowance)
    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    monkeypatch.setattr(LLMFactory, "get_provider", classmethod(lambda cls: state["provider"]))
    return state


def post(client, **overrides):
    body = {
        "user_id": "u1",
        "project_id": "p1",
        "session_id": "s1",
        "system": "You are a coach.",
        "messages": [{"role": "user", "content": "Start"}],
        "tools": TOOLS,
    }
    body.update(overrides)
    return client.post("/voice/turn", json=body)


def lines(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


class TestRoute:
    def test_streams_ndjson_from_the_mock_provider(self, client, wired):
        response = post(client)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["cache-control"] == "no-cache, no-transform"
        events = lines(response)
        assert [e["type"] for e in events] == ["tool_use", "done"]
        assert events[0]["name"] == "get_next_question" and events[0]["input"] == {}
        done = events[-1]
        assert done["stop_reason"] == "tool_use"
        assert done["content"][0]["type"] == "tool_use" and done["content"][0]["id"] == events[0]["id"]

    def test_over_budget_is_refused_before_the_model_runs(self, client, wired):
        wired["provider"] = ScriptedProvider(error=AssertionError("the model must not be called"))
        wired["budget"] = "Daily AI usage limit reached ($3.10 of $3.00 used today, UTC)."
        response = post(client)
        assert response.status_code == 429
        body = response.json()
        assert body["error_code"] == "LLM_DAILY_BUDGET" and "$3.10" in body["detail"]
        assert wired["budget_user"] == "u1"
        assert wired["provider"].calls == []

    def test_unknown_project_is_404(self, client, wired):
        wired["project"] = None
        response = post(client)
        assert response.status_code == 404 and response.json()["error_code"] == "PROJECT_NOT_FOUND"

    @pytest.mark.parametrize(
        "error,code,retryable",
        [
            (LLMRateLimitError("slow down"), "LLM_RATE_LIMITED", True),
            (LLMRefusalError("declined"), "LLM_REFUSED", False),
            (RuntimeError("boom"), "VOICE_TURN_FAILED", True),
        ],
    )
    def test_errors_become_error_events(self, client, wired, error, code, retryable):
        wired["provider"] = ScriptedProvider([TurnText(text="Well")], error=error)
        response = post(client)
        assert response.status_code == 200  # the stream had started
        last = lines(response)[-1]
        assert (last["type"], last["code"], last["retryable"]) == ("error", code, retryable)
        assert last["message"]

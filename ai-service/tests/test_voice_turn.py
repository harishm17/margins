"""POST /voice/turn: the Claude provider's request and content blocks, the mock provider's
script, the NDJSON route, error mapping, the daily budget and the usage ledger."""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, List

import anthropic
import httpx2
import pytest
from anthropic.types.beta import BetaRawContentBlockDeltaEvent, BetaTextDelta
from fastapi.testclient import TestClient

from app.api.routes import voice as voice_route
from app.config import settings
from app.main import app
from app.services.llm.anthropic_provider import AnthropicProvider
from app.services.llm.base import (
    LLMOutputError,
    LLMProvider,
    LLMRateLimitError,
    LLMRefusalError,
    LLMUnavailableError,
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
    async def test_request_uses_the_fast_model_low_effort_and_auto_tool_choice(self):
        text = SimpleNamespace(type="text", text="Hello there.")
        provider, calls = claude([delta("Hello there.")], final_message([text]))
        await collect(provider, max_tokens=800)

        params = calls[0]
        assert params["model"] == "claude-haiku-5-5"
        assert params["max_tokens"] == 800
        assert params["output_config"] == {"effort": "low"}
        assert params["tools"] == TOOLS and params["tool_choice"] == {"type": "auto"}
        assert params["system"][0]["text"] == "Be a coach."
        assert params["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert params["messages"] == [{"role": "user", "content": "hi"}]
        assert "fallbacks" not in params  # Haiku has no server-side fallback

    async def test_no_tools_sends_no_tool_parameters(self):
        text = SimpleNamespace(type="text", text="Hi.")
        provider, calls = claude([delta("Hi.")], final_message([text]))
        await collect(provider, tools=[])
        assert "tools" not in calls[0] and "tool_choice" not in calls[0]

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

    async def test_an_empty_reply_is_a_bad_output(self):
        provider, _ = claude([], final_message([SimpleNamespace(type="text", text="  ")]))
        with pytest.raises(LLMOutputError):
            await collect(provider)

    async def test_sdk_errors_are_translated(self):
        request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
        error = anthropic.RateLimitError(
            "slow down", response=httpx2.Response(429, request=request), body=None
        )
        provider, _ = claude([], None, error=error)
        with pytest.raises(LLMRateLimitError):
            await collect(provider)


# ---- the mock provider ---------------------------------------------------------------------


def user(*blocks):
    return {"role": "user", "content": list(blocks)}


def text(value):
    return {"type": "text", "text": value}


def tool_result(tool_use_id, payload):
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": json.dumps(payload)}


class TestMockTurn:
    async def test_first_turn_asks_for_a_question(self):
        events = await collect(MockProvider(), messages=[{"role": "user", "content": "Start"}])
        assert [e.type for e in events] == ["tool_use", "done"]
        assert events[0].name == "get_next_question"
        assert events[-1].stop_reason == "tool_use"
        assert events[-1].content[0]["id"] == events[0].id

    async def test_a_tool_result_is_answered_with_short_text(self):
        first = await collect(MockProvider(), messages=[{"role": "user", "content": "Start"}])
        messages = [
            {"role": "user", "content": "Start"},
            {"role": "assistant", "content": first[-1].content},
            user(tool_result(first[0].id, {"done": False, "question_index": 0})),
        ]
        events = await collect(MockProvider(), messages=messages)
        assert [e.type for e in events][-1] == "done"
        assert events[-1].stop_reason == "end_turn"
        said = "".join(e.text for e in events if isinstance(e, TurnText))
        assert said and said == events[-1].content[0]["text"]

    async def test_the_next_user_message_is_recorded_as_the_answer(self):
        asked = {"type": "tool_use", "id": "t1", "name": "get_next_question", "input": {}}
        messages = [
            {"role": "user", "content": "Start"},
            {"role": "assistant", "content": [asked]},
            user(tool_result("t1", {"done": False, "question_index": 3})),
            {"role": "assistant", "content": [text("Here is your question.")]},
            {"role": "user", "content": "Hashing maps keys to buckets"},
        ]
        events = await collect(MockProvider(), messages=messages)
        assert events[0].name == "record_answer"
        assert events[0].input == {"question_index": 3, "user_answer": "Hashing maps keys to buckets"}

    async def test_without_tools_it_just_talks(self):
        events = await collect(MockProvider(), messages=[{"role": "user", "content": "Tell me about heaps"}], tools=[])
        assert [e.type for e in events][-1] == "done"
        assert not any(isinstance(e, TurnToolUse) for e in events)
        assert "heaps" in events[-1].content[0]["text"]


TEACH_TOOLS = [
    {"name": "get_concept_to_explain", "description": "Concept", "input_schema": {"type": "object", "properties": {}}},
    {"name": "assess_explanation", "description": "Assess", "input_schema": {"type": "object", "properties": {}}},
    {"name": "record_check", "description": "Check", "input_schema": {"type": "object", "properties": {}}},
]
READING_TOOLS = [
    {"name": "next_claim", "description": "Claim", "input_schema": {"type": "object", "properties": {}}},
    {"name": "record_check", "description": "Check", "input_schema": {"type": "object", "properties": {}}},
]


async def converse(tools, steps):
    """Plays a conversation against the mock. `steps` are the student's messages, or (name, result) pairs for the tool result
    to give back to the tool call the mock just made. Returns the mock's tool calls and its spoken text, in order."""
    messages = [{"role": "user", "content": "[start]"}]
    said, calls, n = [], [], 0
    steps = list(steps)
    while True:
        events = await collect(MockProvider(), messages=messages, tools=tools)
        spoken = "".join(e.text for e in events if isinstance(e, TurnText))
        done = events[-1]
        messages.append({"role": "assistant", "content": done.content})
        if spoken:
            said.append(spoken)
        tool = next((e for e in events if isinstance(e, TurnToolUse)), None)
        if tool is not None:
            calls.append((tool.name, tool.input))
            result = steps.pop(0)
            assert result[0] == tool.name, f"expected {result[0]}, the mock called {tool.name}"
            messages.append(user(tool_result(tool.id, result[1])))
            continue
        if not steps:
            return calls, said
        n += 1
        messages.append({"role": "user", "content": steps.pop(0)})


class TestMockTeachBack:
    async def test_asks_for_an_idea_assesses_the_explanation_and_follows_the_action(self):
        calls, said = await converse(
            TEACH_TOOLS,
            [
                ("get_concept_to_explain", {"done": False, "concept_id": "c1", "prompt": "Explain it"}),
                "Hash tables send keys to buckets.",
                ("assess_explanation", {"action": "probe", "probe": {"type": "implication", "number": 1}}),
                "They collide, I think.",
                ("assess_explanation", {"action": "ask_new_example"}),
                "It works the same in a new case.",
                ("record_check", {"passed": True, "action": "wrap_up"}),
            ],
        )
        assert [name for name, _ in calls] == ["get_concept_to_explain", "assess_explanation", "assess_explanation", "record_check"]
        assert calls[1] == ("assess_explanation", {"concept_id": "c1", "explanation": "Hash tables send keys to buckets."})
        assert calls[3][0] == "record_check" and calls[3][1]["concept_id"] == "c1"
        assert any("Mock probe 1" in line for line in said)

    async def test_without_the_teach_back_tools_it_does_not_script_them(self):
        events = await collect(MockProvider(), messages=[{"role": "user", "content": "Start"}], tools=TOOLS)
        assert events[0].name == "get_next_question"


class TestMockGuidedReading:
    async def test_predicts_then_asks_for_the_claim_then_checks_it(self):
        calls, said = await converse(
            READING_TOOLS,
            [
                ("next_claim", {"done": False, "claim_index": 0, "prediction_prompt": "What do you expect?"}),
                "I think it defines a bucket.",
                ("next_claim", {"done": False, "claim_index": 0, "claim": {"text": "A claim.", "page": 4}}),
                "A bucket holds keys.",
                ("record_check", {"verdict": "right"}),
                "ok",
                ("next_claim", {"done": True}),
            ],
        )
        assert calls[0] == ("next_claim", {})
        assert calls[1] == ("next_claim", {"reveal": True, "prediction": "I think it defines a bucket.", "check_question": "Mock check question?"})
        assert calls[2] == ("record_check", {"claim_index": 0, "answer": "A bucket holds keys."})
        assert calls[3] == ("next_claim", {})
        assert any("every claim" in line for line in said)


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


def usage(model="claude-haiku-5-5"):
    return LLMUsage(model=model, purpose="voice", input_tokens=1000, output_tokens=100)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def wired(monkeypatch):
    """The route with the database, budget and ledger replaced by stand-ins."""
    state: dict = {"budget": None, "project": {"id": "p1"}, "ledger": [], "provider": MockProvider()}

    async def execute_one(sql, *args):
        return state["project"]

    async def over_budget(user_id):
        state["budget_user"] = user_id
        return state["budget"]

    async def record(**row):
        state["ledger"].append(row)

    monkeypatch.setattr(voice_route, "execute_one", execute_one)
    monkeypatch.setattr(voice_route, "over_budget_message", over_budget)
    monkeypatch.setattr(voice_route, "record_usage_event", record)
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

    def test_done_carries_the_time_to_the_first_token_and_the_total(self, client, wired):
        events = lines(post(client))
        timing = events[-1]["timing"]
        assert isinstance(timing["ttft_ms"], int) and isinstance(timing["total_ms"], int)
        assert 0 <= timing["ttft_ms"] <= timing["total_ms"]

    def test_text_deltas_add_up_to_the_final_text(self, client, wired):
        events = lines(post(client, tools=[], messages=[{"role": "user", "content": "Tell me about heaps"}]))
        deltas = "".join(e["delta"] for e in events if e["type"] == "text")
        assert deltas and deltas == events[-1]["content"][0]["text"]

    def test_the_model_gets_the_voice_purpose_and_small_budget(self, client, wired, monkeypatch):
        monkeypatch.setattr(settings, "VOICE_MAX_TOKENS", 777)
        wired["provider"] = ScriptedProvider(
            [TurnText(text="Hi."), TurnDone(stop_reason="end_turn", content=[{"type": "text", "text": "Hi."}], usage=usage())]
        )
        post(client)
        call = wired["provider"].calls[0]
        assert (call["max_tokens"], call["purpose"]) == (777, "voice")
        assert call["system"] == "You are a coach." and call["tools"] == TOOLS
        assert call["messages"] == [{"role": "user", "content": "Start"}]

    def test_over_budget_is_refused_before_the_model_runs(self, client, wired):
        wired["provider"] = ScriptedProvider(error=AssertionError("the model must not be called"))
        wired["budget"] = "Daily AI usage limit reached ($3.10 of $3.00 used today, UTC)."
        response = post(client)
        assert response.status_code == 429
        body = response.json()
        assert body["error_code"] == "LLM_DAILY_BUDGET" and "$3.10" in body["detail"]
        assert wired["budget_user"] == "u1"
        assert wired["provider"].calls == [] and wired["ledger"] == []

    def test_unknown_project_is_404(self, client, wired):
        wired["project"] = None
        response = post(client)
        assert response.status_code == 404 and response.json()["error_code"] == "PROJECT_NOT_FOUND"

    def test_not_configured_is_503(self, client, wired, monkeypatch):
        monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
        response = post(client)
        assert response.status_code == 503 and response.json()["error_code"] == "LLM_NOT_CONFIGURED"

    def test_bad_requests_are_422(self, client, wired):
        assert post(client, messages=[]).status_code == 422
        assert post(client, session_id="").status_code == 422

    @pytest.mark.parametrize(
        "error,code,retryable",
        [
            (LLMRateLimitError("slow down"), "LLM_RATE_LIMITED", True),
            (LLMUnavailableError("overloaded"), "LLM_UNAVAILABLE", True),
            (LLMRefusalError("declined"), "LLM_REFUSED", False),
            (LLMOutputError("empty"), "LLM_BAD_OUTPUT", True),
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

    def test_a_billed_refusal_still_writes_a_ledger_row(self, client, wired):
        error = LLMRefusalError("declined")
        error.usage = usage()
        wired["provider"] = ScriptedProvider(error=error)
        post(client)
        assert len(wired["ledger"]) == 1
        assert wired["ledger"][0]["input_tokens"] == 1000

    def test_each_call_writes_one_ledger_row_with_the_session_as_source(self, client, wired):
        wired["provider"] = ScriptedProvider(
            [TurnDone(stop_reason="end_turn", content=[{"type": "text", "text": "Hi."}], usage=usage())]
        )
        post(client, session_id="sess-9")
        post(client, session_id="sess-9")
        assert len(wired["ledger"]) == 2
        row = wired["ledger"][0]
        assert (row["user_id"], row["project_id"], row["source"], row["source_id"]) == ("u1", "p1", "voice", "sess-9")
        assert row["models"] == "claude-haiku-5-5"
        assert (row["input_tokens"], row["output_tokens"]) == (1000, 100)
        # 1000 in at $0.10/M + 100 out at $0.50/M
        assert row["cost_usd"] == pytest.approx(0.00015)


class TestLedgerInTheDatabase:
    async def test_a_turn_adds_a_voice_row_that_counts_toward_the_budget(self, db, monkeypatch):
        user_id = await seed_user(db)
        project_id = await seed_project(db, user_id)
        monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 3.0)
        provider = ScriptedProvider(
            [TurnDone(stop_reason="end_turn", content=[{"type": "text", "text": "Hi."}], usage=usage())]
        )
        monkeypatch.setattr(LLMFactory, "get_provider", classmethod(lambda cls: provider))

        payload = voice_route.VoiceTurnRequest(
            user_id=user_id, project_id=project_id, session_id="sess-1", system="s",
            messages=[{"role": "user", "content": "hi"}], tools=[],
        )
        response = await voice_route.turn(payload)
        body = b"".join([chunk async for chunk in response.body_iterator])
        assert json.loads(body.splitlines()[-1])["type"] == "done"

        row = await db.fetchrow("SELECT * FROM llm_usage_events WHERE user_id = $1", user_id)
        assert (row["source"], row["source_id"], row["project_id"]) == ("voice", "sess-1", project_id)
        assert row["input_tokens"] == 1000 and float(row["cost_usd"]) == pytest.approx(0.00015)

        # Once the day's spend reaches the cap, the next turn is refused.
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 0.0001)
        refused = await voice_route.turn(payload)
        assert refused.status_code == 429


class TestMockDrillEnd:
    async def test_a_finished_drill_gets_a_goodbye(self):
        asked = {"type": "tool_use", "id": "t1", "name": "get_next_question", "input": {}}
        messages = [
            {"role": "user", "content": "Start"},
            {"role": "assistant", "content": [asked]},
            user(tool_result("t1", {"done": True, "message": "Drill complete."})),
        ]
        events = await collect(MockProvider(), messages=messages)
        assert "goodbye" in events[-1].content[0]["text"]


def with_result(words, step, payload):
    """The student's message as the app sends it when it has already run the step (spec 19.1)."""
    return user(text(words), text(f'<app_result step="{step}">{json.dumps(payload)}</app_result>'))


class TestMockAttachedResults:
    """A step the app ran before the model speaks: the mock speaks at once, with no tool call, as the real coach does."""

    async def test_teach_back_speaks_to_the_attached_assessment(self):
        messages = [
            {"role": "user", "content": "[start]"},
            {"role": "assistant", "content": [text("Explain it.")]},
            with_result("They collide.", "assess_explanation", {"action": "probe", "probe": {"type": "implication", "number": 2}}),
        ]
        events = await collect(MockProvider(), messages=messages, tools=TEACH_TOOLS)
        assert [e.type for e in events][-1] == "done" and events[-1].stop_reason == "end_turn"
        assert not any(isinstance(e, TurnToolUse) for e in events)
        assert "Mock probe 2" in "".join(e.text for e in events if isinstance(e, TurnText))

    async def test_guided_reading_speaks_to_the_attached_reveal_and_check(self):
        reveal = [{"role": "user", "content": "[start]"}, {"role": "assistant", "content": [text("Predict.")]}, with_result("A bucket.", "next_claim", {"claim_index": 0, "claim": {"text": "A claim."}})]
        events = await collect(MockProvider(), messages=reveal, tools=READING_TOOLS)
        assert not any(isinstance(e, TurnToolUse) for e in events)
        assert "Mock claim" in "".join(e.text for e in events if isinstance(e, TurnText))
        check = [*reveal[:2], with_result("It holds keys.", "record_check", {"verdict": "right"})]
        events = await collect(MockProvider(), messages=check, tools=READING_TOOLS)
        assert "Mock feedback" in "".join(e.text for e in events if isinstance(e, TurnText))

    async def test_the_quiz_speaks_to_the_attached_answer(self):
        messages = [{"role": "user", "content": "[start]"}, {"role": "assistant", "content": [text("Question one.")]}, with_result("Buckets.", "record_answer", {"is_correct": True})]
        events = await collect(MockProvider(), messages=messages, tools=TOOLS)
        assert not any(isinstance(e, TurnToolUse) for e in events)
        assert "noted" in "".join(e.text for e in events if isinstance(e, TurnText))

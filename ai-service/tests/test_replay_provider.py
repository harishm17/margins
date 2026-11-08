"""Tests for the record/replay provider: record a real run once, replay it for free."""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, List
from unittest.mock import patch

import pytest
from pydantic import BaseModel

from app.services.llm.base import (
    AnswerCitation,
    AnswerDone,
    AnswerText,
    Excerpt,
    LLMMessage,
    LLMNotConfiguredError,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    TurnDone,
    TurnText,
    TurnToolUse,
)
from app.services.llm.factory import LLMFactory
from app.services.llm.observed import ObservedProvider
from app.services.llm.replay_provider import (
    LLMReplayMissError,
    ReplayProvider,
    normalise,
)
from app.services.llm.usage import record_usage, track_llm_usage

TOPIC_A = "0b6f1c1e-1111-4a4a-8a8a-000000000001"
TOPIC_B = "0b6f1c1e-2222-4b4b-8b8b-000000000002"
NEW_A = "9d9d9d9d-3333-4c4c-8c8c-000000000003"
NEW_B = "9d9d9d9d-4444-4d4d-8d8d-000000000004"


class Linked(BaseModel):
    topic_id: str
    reason: str


def _messages(first: str, second: str, extra: str = "") -> List[LLMMessage]:
    return [
        LLMMessage(role="system", content="You link ideas to topics."),
        LLMMessage(role="user", content=f"Topics: {first} (Sorting), {second} (Hashing). {extra}Pick the one about sorting."),
    ]


def _excerpts(locations: List[str], extra: str = "") -> List[LLMMessage]:
    """A generation prompt whose excerpts are numbered in the order given, as the content generator numbers them."""
    blocks = "\n".join(
        f'<excerpt index="{index}" source="lecture-2.pdf" location="{where}">\nThe text on {where}.\n</excerpt>'
        for index, where in enumerate(locations, start=6)
    )
    return [
        LLMMessage(role="system", content="You write warm-ups."),
        LLMMessage(role="user", content=f"Topics: {TOPIC_A} (Sorting), {TOPIC_B} (Hashing).\n{extra}Supporting excerpts:\n{blocks}"),
    ]


class FakeModel(LLMProvider):
    """Stands in for the real API: answers from the request and records usage the way the real provider does."""

    def __init__(self):
        self.calls = 0

    def _usage(self, purpose: str) -> LLMUsage:
        return LLMUsage(model="claude-haiku-5-5", purpose=purpose, input_tokens=99 + self.calls, output_tokens=10)

    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        self.calls += 1
        usage = self._usage(purpose)
        record_usage(usage)
        return LLMResponse(content=f"answer {self.calls}", model=usage.model, stop_reason="end_turn", usage=usage)

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        self.calls += 1
        record_usage(self._usage(purpose))
        first_id = messages[-1].content.split("Topics: ")[1].split(" ")[0]
        return schema(topic_id=first_id, reason=f"call {self.calls}")

    async def stream_cited_answer(self, *, system, history, question, excerpts, max_tokens=4000, purpose="chat") -> AsyncIterator[Any]:
        self.calls += 1
        usage = self._usage(purpose)
        yield AnswerText(text="Merge sort splits the list.")
        citation = AnswerCitation(ref=excerpts[0].ref, cited_text="splits", start_block_index=0, end_block_index=1, offset=27)
        yield citation
        record_usage(usage)
        yield AnswerDone(text="Merge sort splits the list.", citations=[citation], stop_reason="end_turn", usage=usage)

    async def stream_turn(self, *, system, messages, tools, max_tokens=800, purpose="voice") -> AsyncIterator[Any]:
        self.calls += 1
        usage = self._usage(purpose)
        yield TurnText(text="Let's check.")
        yield TurnToolUse(id="toolu_01", name="grade", input={"topic_id": TOPIC_A})
        record_usage(usage)
        yield TurnDone(stop_reason="tool_use", content=[{"type": "text", "text": "Let's check."}], usage=usage)


def _recorder(tmp_path, inner=None):
    return ReplayProvider(tmp_path, on_miss="record", inner=inner or FakeModel())


def _replayer(tmp_path):
    return ReplayProvider(tmp_path, on_miss="error")


class TestNormalise:
    def test_ids_become_numbered_placeholders_in_order_of_first_appearance(self):
        text, found = normalise(f"{TOPIC_B} then {TOPIC_A} then {TOPIC_B.upper()}")
        assert text == "⟨id1⟩ then ⟨id2⟩ then ⟨id1⟩"
        assert found == {"⟨id1⟩": TOPIC_B, "⟨id2⟩": TOPIC_A}

    def test_emails_and_dates_are_placeholders_too(self):
        text, _ = normalise("wf-3-1731@example.com asked on 2026-11-08T10:22:33.120Z and 2026-11-09")
        assert text == "⟨email1⟩ asked on ⟨date1⟩ and ⟨date2⟩"


class TestStructured:
    async def test_a_recorded_answer_replays_with_the_new_requests_ids(self, tmp_path):
        inner = FakeModel()
        recorded = await _recorder(tmp_path, inner).generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        assert recorded.topic_id == TOPIC_A and inner.calls == 1

        replayed = await _replayer(tmp_path).generate_structured(_messages(NEW_A, NEW_B), Linked, purpose="concepts")
        assert replayed == Linked(topic_id=NEW_A, reason="call 1")

    async def test_a_replay_counts_the_recorded_usage_once(self, tmp_path):
        with track_llm_usage() as during_record:
            await _recorder(tmp_path).generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        assert [u.input_tokens for u in during_record] == [100]

        with track_llm_usage() as during_replay:
            await _replayer(tmp_path).generate_structured(_messages(NEW_A, NEW_B), Linked, purpose="concepts")
        assert during_replay == during_record

    async def test_a_request_is_recorded_once_and_every_repeat_replays_it(self, tmp_path):
        # Each workflow signs up a fresh user and builds the same course: the recording run pays for it once.
        inner = FakeModel()
        recorder = _recorder(tmp_path, inner)
        first = await recorder.generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        again = await recorder.generate_structured(_messages(NEW_A, NEW_B), Linked, purpose="concepts")
        assert inner.calls == 1
        assert (first.reason, again.reason, again.topic_id) == ("call 1", "call 1", NEW_A)

        second_run = FakeModel()
        await _recorder(tmp_path, second_run).generate_structured(_messages(NEW_A, NEW_B), Linked, purpose="concepts")
        assert second_run.calls == 0

    async def test_the_same_excerpts_in_another_order_replay_the_recording(self, tmp_path):
        # Retrieval breaks ties by random chunk ids (finding 92), so one course can list the same excerpts in another
        # order, renumbered. Record mode replays the recording instead of paying for the same content again.
        inner = FakeModel()
        await _recorder(tmp_path, inner).generate_structured(_excerpts(["p. 1", "p. 5"]), Linked, purpose="warmup")
        again = await _recorder(tmp_path, inner).generate_structured(_excerpts(["p. 5", "p. 1"]), Linked, purpose="warmup")
        assert inner.calls == 1
        assert again.reason == "call 1"

    async def test_a_prompt_with_a_line_more_is_recorded(self, tmp_path):
        inner = FakeModel()
        await _recorder(tmp_path, inner).generate_structured(_excerpts(["p. 1", "p. 5"]), Linked, purpose="topics")
        await _recorder(tmp_path, inner).generate_structured(_excerpts(["p. 1", "p. 5"], "Past exam files: quiz-1.pdf\n"), Linked, purpose="topics")
        assert inner.calls == 2

    async def test_a_request_never_recorded_fails_clearly_without_retries(self, tmp_path):
        with pytest.raises(LLMReplayMissError, match="concepts") as raised:
            await _replayer(tmp_path).generate_structured(_messages(NEW_A, NEW_B), Linked, purpose="concepts")
        assert raised.value.code == "LLM_REPLAY_MISS"
        assert raised.value.retryable is False

    async def test_a_slightly_changed_prompt_replays_the_nearest_recording(self, tmp_path):
        await _recorder(tmp_path).generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        changed = _messages(NEW_A, NEW_B, extra="The student opened the reader. ")
        replayed = await _replayer(tmp_path).generate_structured(changed, Linked, purpose="concepts")
        assert replayed.topic_id == NEW_A

    async def test_a_different_purpose_is_never_a_near_match(self, tmp_path):
        await _recorder(tmp_path).generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        with pytest.raises(LLMReplayMissError):
            await _replayer(tmp_path).generate_structured(_messages(NEW_A, NEW_B), Linked, purpose="topics")

    async def test_recordings_are_one_readable_file_per_request(self, tmp_path):
        await _recorder(tmp_path).generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        files = list(tmp_path.rglob("*.json"))
        assert len(files) == 1
        entry = json.loads(files[0].read_text())
        assert entry["purpose"] == "concepts" and entry["schema"] == "Linked"
        assert TOPIC_A not in entry["request"] and "⟨id1⟩" in json.dumps(entry["response"], ensure_ascii=False)


class TestText:
    async def test_text_replays_with_its_usage(self, tmp_path):
        recorded = await _recorder(tmp_path).generate_text(_messages(TOPIC_A, TOPIC_B), purpose="section_notes")
        with track_llm_usage() as usage:
            replayed = await _replayer(tmp_path).generate_text(_messages(NEW_A, NEW_B), purpose="section_notes")
        assert replayed == recorded
        assert [u.input_tokens for u in usage] == [100]


class TestStreams:
    async def test_a_cited_answer_replays_its_events_with_the_new_excerpt_refs(self, tmp_path):
        def excerpts(chunk):
            return [Excerpt(ref=f"chunk:{chunk}", title="Lecture 3", text="Merge sort splits the list in half.")]

        recorder = _recorder(tmp_path)
        recorded = [e async for e in recorder.stream_cited_answer(system="Answer from the excerpts.", history=[], question="How does merge sort work?", excerpts=excerpts(TOPIC_A))]
        with track_llm_usage() as usage:
            replayed = [e async for e in _replayer(tmp_path).stream_cited_answer(system="Answer from the excerpts.", history=[], question="How does merge sort work?", excerpts=excerpts(NEW_A))]
        assert [e.type for e in replayed] == [e.type for e in recorded] == ["text", "citation", "done"]
        assert replayed[1].ref == f"chunk:{NEW_A}"
        assert [u.input_tokens for u in usage] == [100]

    async def test_a_voice_turn_replays_its_text_tool_call_and_usage(self, tmp_path):
        def turn(provider, topic):
            return provider.stream_turn(system="Coach.", messages=[{"role": "user", "content": f"Quiz me on {topic}"}], tools=[{"name": "grade"}])

        recorded = [e async for e in turn(_recorder(tmp_path), TOPIC_A)]
        with track_llm_usage() as usage:
            replayed = [e async for e in turn(_replayer(tmp_path), NEW_A)]
        assert [e.type for e in replayed] == [e.type for e in recorded] == ["text", "tool_use", "done"]
        assert replayed[1].input == {"topic_id": NEW_A}
        assert len(usage) == 1


class TestWiring:
    def teardown_method(self):
        LLMFactory.reset()

    def test_the_factory_builds_a_replay_provider_behind_the_ai_status(self, tmp_path):
        with patch("app.services.llm.factory.settings") as settings:
            settings.LLM_PROVIDER = "replay"
            settings.is_production = False
            settings.LLM_CASSETTE_DIR = str(tmp_path)
            settings.LLM_REPLAY_MISS = "error"
            LLMFactory.reset()
            provider = LLMFactory.get_provider()
            assert isinstance(provider, ObservedProvider)
            assert isinstance(provider.inner, ReplayProvider)
            assert provider.model_for("validate_material") == "claude-haiku-5-5"

    def test_the_factory_refuses_replay_in_production(self, tmp_path):
        with patch("app.services.llm.factory.settings") as settings:
            settings.LLM_PROVIDER = "replay"
            settings.is_production = True
            settings.LLM_CASSETTE_DIR = str(tmp_path)
            LLMFactory.reset()
            with pytest.raises(LLMNotConfiguredError, match="production"):
                LLMFactory.get_provider()

    def test_settings_refuse_replay_in_production_and_count_it_as_configured(self, tmp_path):
        from pydantic import ValidationError

        from app.config import Settings

        with pytest.raises(ValidationError, match="LLM_PROVIDER=replay"):
            Settings(ENVIRONMENT="production", LLM_PROVIDER="replay", LLM_CASSETTE_DIR=str(tmp_path))
        configured = Settings(ENVIRONMENT="development", LLM_PROVIDER="replay", ANTHROPIC_API_KEY="", LLM_CASSETTE_DIR=str(tmp_path))
        assert configured.llm_configured is True

    def test_replay_needs_a_cassette_folder(self):
        from pydantic import ValidationError

        from app.config import Settings

        with pytest.raises(ValidationError, match="LLM_CASSETTE_DIR"):
            Settings(ENVIRONMENT="development", LLM_PROVIDER="replay", LLM_CASSETTE_DIR="")

    def test_record_mode_needs_the_real_model(self, tmp_path):
        with pytest.raises(LLMNotConfiguredError, match="record"):
            ReplayProvider(tmp_path, on_miss="record", inner=None)


class TestRecordingCost:
    async def test_the_cost_of_a_recording_run_counts_only_what_it_recorded(self, tmp_path):
        import os
        import time

        from app.services.llm.replay_provider import recording_cost

        recorder = _recorder(tmp_path)
        await recorder.generate_structured(_messages(TOPIC_A, TOPIC_B), Linked, purpose="concepts")
        [older] = list(tmp_path.rglob("*.json"))
        os.utime(older, (1_000, 1_000))
        started = time.time() - 1
        await recorder.generate_text(_messages(TOPIC_A, TOPIC_B), purpose="section_notes")
        _ = [e async for e in recorder.stream_cited_answer(system="s", history=[], question="q", excerpts=[Excerpt(ref=f"chunk:{TOPIC_A}", title="t", text="x")])]

        summary = recording_cost(tmp_path, since=started)
        assert summary["recordings"] == 2
        assert summary["calls"] == 2
        # Haiku 5.5 at $0.10 in and $0.50 out per million: (101 + 102) input and 20 output tokens.
        assert summary["cost_usd"] == pytest.approx((203 * 0.10 + 20 * 0.50) / 1_000_000)
        assert recording_cost(tmp_path, since=0)["recordings"] == 3

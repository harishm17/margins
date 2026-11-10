"""Tests for judge helpers, analysis, the report and the metered provider. No database, no network.

The metered-provider tests import app code (usage and base types), so they set a placeholder
DATABASE_URL first, as ai-service/tests/conftest.py does.
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")

import analysis  # noqa: E402
import judge  # noqa: E402
from spend import GENERATION, SpendLimitReached, SpendTracker  # noqa: E402

# ---------------------------------------------------------------- judge


def test_labels_are_a_stable_shuffle_of_the_models():
    models = ["opus-medium", "sonnet-medium", "haiku-medium"]
    first = judge.assign_labels("c|t|notes", models, seed=0)
    assert first == judge.assign_labels("c|t|notes", models, seed=0)
    assert sorted(first) == ["A", "B", "C"] and sorted(first.values()) == sorted(models)
    orders = {tuple(judge.assign_labels(f"c|t{i}|notes", models, seed=0).values()) for i in range(30)}
    assert len(orders) > 1  # the order varies between pairs, so no model is always "A"


def test_judge_messages_contain_labels_but_no_model_names():
    messages = judge.build_judge_messages("quiz", [{"filename": "f.pdf", "pages": [1, 2], "section": "S", "text": "body"}], {"A": "one", "B": "two"})
    joined = "\n".join(m.content for m in messages)
    assert '<candidate label="A">' in joined and "Candidates A, B" not in joined and "A, B" in joined
    for word in ("opus", "sonnet", "haiku", "claude"):
        assert word not in joined.lower()
    assert "question_quality (quizzes only" in joined


def _judged(corpus, topic, content_type, mapping, reviews):
    return {"corpus": corpus, "topic": topic, "type": content_type, "mapping": mapping, "result": {"reviews": reviews}}


def test_aggregate_maps_letters_back_to_models_and_lists_errors():
    review = lambda letter, c, t, errors=(), q=None: {  # noqa: E731
        "candidate": letter, "correctness": c, "grounding": 4, "teaching": t, "question_quality": q, "errors": list(errors), "summary": ""
    }
    judged = [
        _judged("c1", "t1", "notes", {"A": "opus-medium", "B": "haiku-medium"}, [review("A", 5, 5), review("B", 3, 4, [{"kind": "mathematical", "where": "step 2", "description": "7 * 8 is 56"}])]),
        _judged("c1", "t1", "quiz", {"A": "haiku-medium", "B": "opus-medium"}, [review("A", 4, 3, q=2), review("B", 5, 4, q=4)]),
    ]
    result = judge.aggregate(judged, ["opus-medium", "haiku-medium"])
    assert result["pairs_judged"] == 2
    opus, haiku = result["models"]["opus-medium"], result["models"]["haiku-medium"]
    assert opus["means"]["all"]["correctness"] == 5.0 and opus["means"]["quiz"]["question_quality"] == 4.0
    assert haiku["means"]["all"]["correctness"] == 3.5
    assert haiku["mathematical_errors"] == 1 and haiku["mathematical_errors_by_type"] == {"notes": 1}
    assert haiku["errors"][0]["topic"] == "t1" and opus["errors"] == []


# ---------------------------------------------------------------- analysis and report


def _record(corpus, topic, slug, content_type, output, cost=0.01, seconds=5.0, status="ok"):
    return {
        "corpus": corpus,
        "topic": {"key": topic, "name": topic.upper(), "index": 0},
        "model": {"slug": slug, "label": slug.replace("-", ":"), "model_id": "x"},
        "type": content_type,
        "status": status,
        "output": output,
        "error": None if status == "ok" else "boom",
        "cost_usd": cost,
        "seconds": seconds,
        "calls": [{"cost_usd": cost, "input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 5}],
    }


NOTES = "# T\n\n## Overview\nHashing maps keys to slots using a hash function.\n\n## Key Concepts\n- keys and slots\n"
QUIZ = [{"question_type": "true_false", "question_text": "Chaining resolves collisions.", "correct_answer": True, "explanation": "Yes.", "points": 1, "concepts_tested": ["chaining"]}]


def test_cost_and_latency_projection():
    records = [
        _record("c", "t1", "m-low", "notes", NOTES, cost=0.10, seconds=10),
        _record("c", "t2", "m-low", "notes", NOTES, cost=0.20, seconds=20),
        _record("c", "t1", "m-low", "quiz", QUIZ, cost=0.05, seconds=4),
        _record("c", "t2", "m-low", "quiz", None, cost=0.02, seconds=3, status="error"),
    ]
    result = analysis.cost_and_latency(records, ["notes", "solved", "quiz"])
    assert result["per_type"]["notes"]["mean_cost_usd"] == pytest.approx(0.15)
    assert result["per_type"]["quiz"]["generated"] == 1 and result["per_type"]["quiz"]["failed"] == 1
    assert "solved" not in result["per_type"]
    assert result["mean_cost_per_topic_usd"] == pytest.approx(0.20)
    assert result["projected_cost_12_topics_usd"] == pytest.approx(2.40)
    assert result["total_cost_usd"] == pytest.approx(0.37)
    assert result["cache_creation_input_tokens"] == 20


# ---------------------------------------------------------------- the metered provider


from app.services.llm.base import LLMMessage, LLMProvider, LLMResponse, LLMUsage  # noqa: E402
from app.services.llm.usage import record_usage  # noqa: E402


class FakeProvider(LLMProvider):
    """Reports usage like the real provider does (through record_usage); counts its calls."""

    def __init__(self, output_tokens=1000, fail=False):
        self.calls = 0
        self.output_tokens = output_tokens
        self.fail = fail

    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        self.calls += 1
        usage = LLMUsage(model="claude-haiku-5-5", purpose=purpose, input_tokens=100, output_tokens=self.output_tokens, cache_creation_input_tokens=900)
        record_usage(usage)
        if self.fail:
            raise RuntimeError("cut off")
        return LLMResponse(content="notes text", model=usage.model, stop_reason="end_turn", usage=usage)

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        raise NotImplementedError

    def stream_cited_answer(self, **kwargs):
        raise NotImplementedError


def _metered(max_usd, fake):
    import adapters

    tracker = SpendTracker(max_usd, 3, adapters.estimate_cost)
    spec = adapters.parse_model_spec("haiku:medium")
    return adapters.MeteredProvider(fake, spec, tracker, GENERATION), tracker


def test_metered_provider_records_usage_cost_and_raw_output():
    fake = FakeProvider(output_tokens=1000)
    provider, tracker = _metered(1.0, fake)
    messages = [LLMMessage(role="user", content="x" * 4000)]
    response = asyncio.run(provider.generate_text(messages, purpose="section_notes"))
    assert response.content == "notes text"
    call = provider.calls[0]
    # haiku: 100 in * 0.10 + 1000 out * 0.50 + 900 cache write * 0.125, per million
    assert call["cost_usd"] == pytest.approx((100 * 0.10 + 1000 * 0.50 + 900 * 0.125) / 1_000_000, rel=1e-3)
    assert call["raw_output"] == "notes text" and call["error"] is None and call["purpose"] == "section_notes"
    assert tracker.total_spent == pytest.approx(call["cost_usd"], rel=1e-3)


def test_metered_provider_stops_before_the_call_when_the_cap_is_reached():
    fake = FakeProvider()
    provider, tracker = _metered(0.0001, fake)  # the estimate for a 4000-char prompt alone is above this
    with pytest.raises(SpendLimitReached):
        asyncio.run(provider.generate_text([LLMMessage(role="user", content="x" * 4000)], purpose="section_notes"))
    assert fake.calls == 0 and provider.calls == []
    assert tracker.total_spent == 0


def test_metered_provider_counts_cost_of_a_failed_call_and_reraises():
    fake = FakeProvider(fail=True)
    provider, tracker = _metered(1.0, fake)
    with pytest.raises(RuntimeError):
        asyncio.run(provider.generate_text([LLMMessage(role="user", content="hi")], purpose="section_notes"))
    assert provider.calls[0]["error"].startswith("RuntimeError") and provider.calls[0]["cost_usd"] > 0
    assert tracker.total_spent == pytest.approx(provider.calls[0]["cost_usd"], rel=1e-3)


def test_the_model_pin_reaches_the_apps_resolver_per_task_and_leaves_no_trace():
    import adapters
    from app.services.llm import anthropic_provider

    adapters.install_model_pin()
    adapters.install_model_pin()  # idempotent
    opus, haiku = adapters.parse_model_spec("opus:high"), adapters.parse_model_spec("haiku:low")
    outside = anthropic_provider.resolve_model("section_notes")

    async def seen(spec):
        with adapters.pinned_model(spec):
            await asyncio.sleep(0)  # let the other task run while this pin is set
            return anthropic_provider.resolve_model("section_notes")

    async def both():
        return await asyncio.gather(seen(opus), seen(haiku), seen(None))

    first, second, third = asyncio.run(both())
    assert (first.model, first.effort) == ("claude-opus-5-5", "high")
    assert (second.model, second.effort) == ("claude-haiku-5-5", "low")
    assert third == outside  # no pin: the app's own choice
    assert anthropic_provider.resolve_model("section_notes") == outside
    # A purpose the app does not know (the judge) works while pinned, and still fails outside a pin.
    with adapters.pinned_model(opus):
        assert anthropic_provider.resolve_model("judge").model == "claude-opus-5-5"
    with pytest.raises(ValueError):
        anthropic_provider.resolve_model("judge")


def test_real_provider_sends_the_pinned_model_and_effort(monkeypatch):
    """Through MeteredProvider and the app's AnthropicProvider, with the HTTP call replaced."""
    import types

    import adapters

    sent = []

    async def fake_create(**params):
        sent.append(params)
        usage = types.SimpleNamespace(input_tokens=10, output_tokens=20, cache_read_input_tokens=0, cache_creation_input_tokens=0)
        return types.SimpleNamespace(
            model=params["model"], usage=usage, stop_reason="end_turn", stop_details=None,
            content=[types.SimpleNamespace(type="text", text="hello notes")],
        )

    inner = adapters.build_provider(mock=False, api_key="not-a-real-key")
    monkeypatch.setattr(inner.client.beta.messages, "create", fake_create)
    tracker = SpendTracker(1.0, 1.0, adapters.estimate_cost)
    for label, model, effort in (("opus:high", "claude-opus-5-5", "high"), ("haiku:low", "claude-haiku-5-5", "low")):
        provider = adapters.MeteredProvider(inner, adapters.parse_model_spec(label), tracker, GENERATION)
        response = asyncio.run(provider.generate_text([LLMMessage(role="user", content="hi")], purpose="section_notes"))
        assert response.content == "hello notes"
        assert sent[-1]["model"] == model and sent[-1]["output_config"]["effort"] == effort
        assert provider.calls[0]["model"] == model and provider.calls[0]["effort"] == effort



"""Tests for judge helpers, analysis, the report and the metered provider. No database, no network.

The metered-provider tests import app code (usage and base types), so they set a placeholder
DATABASE_URL first, as ai-service/tests/conftest.py does.
"""
import asyncio
import json
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
import report  # noqa: E402
from spend import GENERATION, SpendLimitReached, SpendTracker  # noqa: E402

# ---------------------------------------------------------------- judge


def test_labels_are_a_stable_shuffle_of_the_models():
    models = ["opus-medium", "sonnet-medium", "haiku-medium"]
    first = judge.assign_labels("c|t|notes", models, seed=0)
    assert first == judge.assign_labels("c|t|notes", models, seed=0)
    assert sorted(first) == ["A", "B", "C"] and sorted(first.values()) == sorted(models)
    orders = {tuple(judge.assign_labels(f"c|t{i}|notes", models, seed=0).values()) for i in range(30)}
    assert len(orders) > 1  # the order varies between pairs, so no model is always "A"


def test_rendering_hides_nothing_but_is_the_same_layout_for_every_model():
    quiz = [
        {
            "question_type": "multiple_choice",
            "question_text": "What is 3 + 4?",
            "options": [{"id": "A", "text": "6"}, {"id": "B", "text": "7"}],
            "correct_answer": "B",
            "explanation": "Add.",
            "points": 1,
            "concepts_tested": ["addition"],
        },
        {"question_type": "numerical", "question_text": "Root of 9?", "correct_answer": 3.0, "unit": "", "tolerance": 0.1, "explanation": "x", "points": 2},
        {"question_type": "short_answer", "question_text": "Define a heap.", "sample_answer": "A tree.", "key_points": ["tree", "order"], "explanation": "y", "points": 3},
    ]
    text = judge.render_output("quiz", quiz)
    assert "### Question 1 (multiple_choice, 1 pt)" in text and "  B. 7" in text and "Answer key: B" in text
    assert "tolerance 0.1" in text and "Sample answer: A tree." in text
    solved = [{"title": "T", "problem_statement": "P", "solution_steps": [{"step_number": 1, "description": "d", "work": "w", "explanation": "e"}], "final_answer": "- a", "key_concepts": ["k"]}]
    assert "Step 1: d" in judge.render_output("solved", solved)
    assert judge.render_output("notes", "  # Notes  ") == "# Notes"


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


def test_aggregate_clamps_and_ignores_bad_scores():
    judged = [_judged("c", "t", "notes", {"A": "m"}, [{"candidate": "a", "correctness": 9, "grounding": "x", "teaching": 0, "errors": []}])]
    means = judge.aggregate(judged, ["m"])["models"]["m"]["means"]["all"]
    assert means["correctness"] == 5 and means["grounding"] is None and means["teaching"] == 1


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


def _run_dir(tmp_path):
    run = tmp_path / "2026-01-01-test"
    (run / "raw").mkdir(parents=True)
    records = [
        _record("c", "t1", "a-medium", "notes", NOTES),
        _record("c", "t1", "a-medium", "quiz", QUIZ),
        _record("c", "t1", "b-low", "notes", NOTES, cost=0.001),
        _record("c", "t1", "b-low", "quiz", None, status="error"),
    ]
    for r in records:
        (run / "raw" / analysis.raw_name(r["corpus"], r["topic"]["key"], r["model"]["slug"], r["type"])).write_text(json.dumps(r))
    (run / "excerpts.json").write_text(json.dumps({"c": {"t1": [{"text": "A hash function maps keys to slots."}]}}))
    (run / "topics.json").write_text(json.dumps({"c": {"all": [{"name": "T1"}], "selected": [{"name": "T1", "key": "t1"}]}}))
    info = {
        "label": "test", "date": "2026-01-01", "corpora": ["c"], "types": ["notes", "quiz"],
        "models": [{"slug": "a-medium", "label": "a:medium", "model_id": "x"}, {"slug": "b-low", "label": "b:low", "model_id": "y"}],
        "params": {"examples": 3, "questions": 10, "difficulty": "medium", "detail_level": "comprehensive"},
        "judge": None, "mock": False, "seed": 0, "max_usd": 8.0, "max_judge_usd": 3.0, "topics_source": "fixed",
    }
    return run, info


def test_build_summary_and_report_from_files(tmp_path):
    run, info = _run_dir(tmp_path)
    summary = analysis.build_summary(run, info, {"generation": 0.02, "topics": 0.0, "judge": 0.0}, {})
    assert summary["models"]["a-medium"]["checks"]["notes_count"] == 1
    assert summary["models"]["b-low"]["failures"][0]["type"] == "quiz"
    assert summary["judge"] is None
    assert summary["samples"] is None or summary["samples"]["topic"] == "t1"
    markdown = report.render_markdown(summary)
    for heading in ("# Generation eval: test", "## Cost and latency", "## Automatic checks", "## Judge", "## Side by side", "Failed generations"):
        assert heading in markdown
    assert "The judge was not run." in markdown
    json.dumps(summary)  # the summary must serialise


def test_report_includes_judge_errors(tmp_path):
    run, info = _run_dir(tmp_path)
    (run / "judge").mkdir()
    (run / "judge" / "c__t1__notes.json").write_text(
        json.dumps(
            _judged("c", "t1", "notes", {"A": "a-medium", "B": "b-low"}, [
                {"candidate": "A", "correctness": 5, "grounding": 5, "teaching": 4, "errors": [], "summary": ""},
                {"candidate": "B", "correctness": 2, "grounding": 3, "teaching": 3, "summary": "",
                 "errors": [{"kind": "mathematical", "where": "section 2", "description": "wrong sum"}]},
            ])
        )
    )
    info["judge"] = "opus:medium"
    summary = analysis.build_summary(run, info, {"generation": 0.02, "topics": 0.0, "judge": 0.3}, {})
    markdown = report.render_markdown(summary)
    assert "mathematical, section 2: wrong sum" in markdown
    assert "b:low** (1 errors, 1 mathematical)" in markdown


def test_notes_section_and_quiz_samples():
    section = analysis.notes_section("# T\n\n## Overview\nintro\n\n## Key Concepts\nbody text here\n\n## How\nmore")
    assert section["title"] == "Key Concepts" and section["text"] == "body text here"
    questions = [{"question_type": "numerical"}, {"question_type": "multiple_choice"}, {"question_type": "true_false"}]
    picked = analysis.quiz_samples(questions)
    assert [q["question_type"] for q in picked] == ["multiple_choice", "numerical"]


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


def test_parse_model_spec():
    import adapters

    spec = adapters.parse_model_spec("opus:high")
    assert (spec.model_id, spec.effort, spec.slug, spec.label) == ("claude-opus-5-5", "high", "opus-high", "opus:high")
    full = adapters.parse_model_spec("claude-sonnet-5-5:medium")
    assert full.alias == "sonnet" and full.slug == "sonnet-medium"
    for bad in ("opus", "opus:", "opus:turbo", ":low"):
        with pytest.raises(SystemExit):
            adapters.parse_model_spec(bad)


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


def test_metered_provider_pins_the_model_during_the_call():
    import adapters
    from app.services.llm import anthropic_provider

    seen = {}

    class Probe(FakeProvider):
        async def generate_text(self, messages, *, purpose, max_tokens=16000):
            seen["choice"] = anthropic_provider.resolve_model(purpose)
            return await super().generate_text(messages, purpose=purpose, max_tokens=max_tokens)

    adapters.install_model_pin()
    provider, _ = _metered(1.0, Probe())
    asyncio.run(provider.generate_text([LLMMessage(role="user", content="hi")], purpose="section_notes"))
    assert (seen["choice"].model, seen["choice"].effort) == ("claude-haiku-5-5", "medium")


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


def test_concepts_and_warmup_flow_through_summary_and_report(tmp_path):
    run = tmp_path / "2026-01-01-graph"
    (run / "raw").mkdir(parents=True)
    graph = {
        "objective_count": 1,
        "concepts": [{"id": f"c{i}", "name": f"C{i}", "objective_indexes": [0]} for i in range(3)],
        "claims": [{"concept_id": "c0", "chunk_id": "k1", "quote": "maps keys to slots"}, {"concept_id": "c1", "chunk_id": "k1", "quote": "not in the chunk"}],
        "edges": [{"source_id": "c0", "target_id": "c1", "type": "prerequisite"}],
    }
    warmup = [{"question_type": "true_false", "question_text": "A hash function maps any key to a slot.", "correct_answer": True, "explanation": "Yes.", "concept_ids": ["c0"]}]
    for content_type, output in (("concepts", graph), ("warmup", warmup), ("quiz", QUIZ)):
        r = _record("c", "t1", "a-medium", content_type, output)
        (run / "raw" / analysis.raw_name("c", "t1", "a-medium", content_type)).write_text(json.dumps(r))
    (run / "excerpts.json").write_text(json.dumps({"c": {"t1": [{"chunk_id": "k1", "text": "A hash function maps keys to slots."}]}}))
    (run / "topics.json").write_text(json.dumps({"c": {"all": [{"name": "T1"}], "selected": [{"name": "T1", "key": "t1"}]}}))
    info = {
        "label": "graph", "date": "2026-01-01", "corpora": ["c"], "types": ["concepts", "warmup", "quiz"],
        "models": [{"slug": "a-medium", "label": "a:medium", "model_id": "x"}],
        "params": {"examples": 3, "questions": 10, "difficulty": "medium", "detail_level": "comprehensive"},
        "judge": None, "mock": False, "seed": 0, "max_usd": 3.0, "max_judge_usd": 3.0, "topics_source": "fixed",
    }
    summary = analysis.build_summary(run, info, {"generation": 0.03, "topics": 0.0, "judge": 0.0}, {})
    checks_ = summary["models"]["a-medium"]["checks"]
    assert (checks_["claims_total"], checks_["claims_matched"]) == (2, 1)
    assert checks_["claim_quote_gate_ok"] is False
    assert checks_["concept_count_ok"] == 1 and checks_["warmup_reused_items"] == 0
    # The warm-up is tagged with a real concept; the quiz fixture has no tags at all.
    assert (checks_["items_tagged"], checks_["items_tagged_valid"]) == (2, 1)
    markdown = report.render_markdown(summary)
    assert "50% (1 of 2) FAIL" in markdown and "Concepts" in markdown and "Warm-up" in markdown
    # The item-tag gate fails (one quiz item is untagged); the warm-up reuse gate passes at zero.
    assert checks_["item_tag_gate_ok"] is False and checks_["warmup_reuse_gate_ok"] is True
    assert "50% (1 of 2) FAIL" in markdown.split("Items whose concept tags are all valid")[1].splitlines()[0]
    assert "| 0 PASS |" in markdown.split("Warm-up questions the topic quiz repeats")[1].splitlines()[0]
    json.dumps(summary)

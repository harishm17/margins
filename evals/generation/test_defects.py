"""Tests for A2's adapters: why the app drops an item, the support-check recorder and per-task call records.
No database, no network; app code is imported as in test_pipeline.py.
"""
import asyncio
import os
import sys
import types
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")

import adapters  # noqa: E402
from app.services.llm.base import LLMMessage, LLMProvider, LLMResponse, LLMUsage  # noqa: E402
from app.services.llm.schemas import GeneratedQuestion, InteractiveExample, SolvedExample  # noqa: E402
from app.services.llm.usage import record_usage  # noqa: E402
from spend import GENERATION, SpendTracker  # noqa: E402

# ---------------------------------------------------------------- why a question is dropped


def option(id_, text, misconception="A mix-up."):
    return {"id": id_, "text": text, "misconception": misconception}


def question(**overrides):
    base = {
        "question_type": "multiple_choice",
        "question_text": "Which colour is the box?",
        "options": [option("A", "Red", ""), option("B", "Blue"), option("C", "Green"), option("D", "Yellow")],
        "correct_answer": "A",
        "explanation": "The box is red.",
    }
    return {**base, **overrides}


QUESTION_CASES = [
    ("usable", question(), None),
    ("no text", question(question_text="  "), "empty"),
    ("no explanation", question(explanation=""), "empty"),
    ("two options", question(options=[option("A", "Red", ""), option("B", "Blue")]), "too_few_options"),
    ("repeated id", question(options=[option("A", "Red", ""), option("B", "Blue"), option("B", "Green")]), "duplicate_options"),
    ("repeated text", question(options=[option("A", "Red", ""), option("B", "Blue"), option("C", "blue")]), "duplicate_options"),
    ("key not an option", question(correct_answer="E"), "answer_not_in_options"),
    ("wrong option without misconception", question(options=[option("A", "Red", ""), option("B", "Blue", ""), option("C", "Green")]), "missing_misconception"),
    ("true/false without a boolean", {"question_type": "true_false", "question_text": "Is it red?", "correct_answer": "maybe", "explanation": "Yes."}, "bad_answer"),
    ("numerical without a number", {"question_type": "numerical", "question_text": "How many?", "correct_answer": "lots", "explanation": "Three."}, "bad_answer"),
    ("short answer without key points", {"question_type": "short_answer", "question_text": "Why?", "sample_answer": "Because.", "explanation": "So."}, "incomplete_short_answer"),
    ("usable true/false", {"question_type": "true_false", "question_text": "Is it red?", "correct_answer": True, "explanation": "Yes."}, None),
]


@pytest.mark.parametrize("name,raw,reason", QUESTION_CASES, ids=[c[0] for c in QUESTION_CASES])
def test_question_drop_reason_names_the_rule_and_agrees_with_the_app(name, raw, reason):
    assert adapters.question_drop_reason(raw) == reason
    kept = GeneratedQuestion.model_validate(raw).normalized() is not None
    assert kept == (reason is None)


def test_a_question_the_schema_rejects_is_named_so():
    assert adapters.question_drop_reason({"question_text": "no type"}) == "schema"


# ---------------------------------------------------------------- why a problem is dropped


def step(**overrides):
    base = {
        "step_number": 1,
        "question": "How many cards are in the hand?",
        "hints": ["Look at the hand.", "Count the cards.", "Add one for each card."],
        "answer_type": "numeric",
        "correct_answer": "5",
        "explanation": "There are five.",
        "feedback_correct": "Right.",
        "feedback_incorrect": "Count again.",
    }
    return {**base, **overrides}


def problem(*steps, **overrides):
    base = {"title": "A hand of cards", "problem_statement": "A hand is dealt.", "steps": list(steps) or [step()]}
    return {**base, **overrides}


PROBLEM_CASES = [
    ("usable", problem(), None),
    ("no steps", problem(steps=[]), "unusable"),
    ("a step with two hints", problem(step(hints=["Look.", "Count."])), "step_unusable"),
    ("a hint with the number", problem(step(hints=["Look at the hand.", "There are 5 of them.", "Count."])), "hint_leak"),
    (
        "a hint with the answer's number word",
        problem(step(correct_answer="2", acceptable_answers=["two"], hints=["Look at the hand.", "Pick any two cards.", "Count them."])),
        "hint_leak_word_form",
    ),
]


@pytest.mark.parametrize("name,raw,reason", PROBLEM_CASES, ids=[c[0] for c in PROBLEM_CASES])
def test_problem_drop_reason_names_the_rule_and_agrees_with_the_app(name, raw, reason):
    assert adapters.problem_drop_reason("interactive", raw) == reason
    assert (InteractiveExample.model_validate(raw).stored() is not None) == (reason is None)


def test_a_solved_example_without_steps_is_unusable():
    raw = {"title": "T", "problem_statement": "P", "solution_steps": [], "final_answer": "4"}
    assert adapters.problem_drop_reason("solved", raw) == "unusable"
    assert SolvedExample.model_validate(raw).stored() is None
    raw["solution_steps"] = [{"step_number": 1, "description": "d", "work": "w", "explanation": "e"}]
    assert adapters.problem_drop_reason("solved", raw) is None


# ---------------------------------------------------------------- the support-check recorder


def fake_module():
    module = types.ModuleType("fake_generator")

    async def check_support(items, chunks):
        return items[:1], len(items) - 1

    module.check_support = check_support
    return module


def test_the_support_recorder_keeps_what_each_check_sent_and_dropped():
    module = fake_module()
    adapters.install_support_recorder([module])
    adapters.install_support_recorder([module])  # installing twice records once
    items = [{"question_text": "a"}, {"question_text": "b"}, {"question_text": "c"}]

    async def go():
        with adapters.support_sink() as records:
            kept, dropped = await module.check_support(items, [])
        return kept, dropped, records

    kept, dropped, records = asyncio.run(go())
    assert (kept, dropped) == ([items[0]], 2)
    assert records == [{"sent": 3, "kept": 1, "dropped": [items[1], items[2]]}]
    # Outside a sink the check runs as before and nothing is kept.
    assert asyncio.run(module.check_support(items, [])) == ([items[0]], 2)


# ---------------------------------------------------------------- calls of concurrent tasks


class FakeProvider(LLMProvider):
    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        await asyncio.sleep(0.01)
        usage = LLMUsage(model="claude-haiku-5-5", purpose=purpose, input_tokens=100, output_tokens=200)
        record_usage(usage)
        return LLMResponse(content=messages[0].content, model=usage.model, stop_reason="end_turn", usage=usage)

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        raise NotImplementedError

    def stream_cited_answer(self, **kwargs):
        raise NotImplementedError


def test_each_task_gets_its_own_calls_and_the_batch_price_is_half():
    tracker = SpendTracker(1.0, 1.0, adapters.estimate_cost)
    provider = adapters.MeteredProvider(FakeProvider(), adapters.parse_model_spec("haiku:low"), tracker, GENERATION)

    async def task(text, n):
        with adapters.call_sink() as calls:
            for _ in range(n):
                await provider.generate_text([LLMMessage(role="user", content=text)], purpose="warmup")
        return calls

    async def go():
        return await asyncio.gather(task("first", 2), task("second", 1))

    first, second = asyncio.run(go())
    assert [c["raw_output"] for c in first] == ["first", "first"]
    assert [c["raw_output"] for c in second] == ["second"]
    full = first[0]["cost_usd"]

    provider.price_factor = 0.5
    halved = asyncio.run(task("third", 1))
    assert halved[0]["cost_usd"] == pytest.approx(full / 2)


# ---------------------------------------------------------------- the item judge

import item_judge  # noqa: E402


def test_a_rendered_question_shows_what_a_student_sees_and_the_key_but_not_the_metadata():
    raw = question()
    raw["concept_ids"] = ["c-secret"]
    text = item_judge.render_question(3, GeneratedQuestion.model_validate(raw).normalized())
    assert text.startswith('<question number="3" type="multiple_choice">')
    assert "A. Red" in text and "Answer key: A" in text and "Explanation: The box is red." in text
    assert "c-secret" not in text and "A mix-up." not in text
    written = item_judge.render_question(1, {"question_type": "short_answer", "question_text": "Why?", "sample_answer": "S", "key_points": ["k1", "k2"], "explanation": "E"})
    assert "Sample answer: S" in written and "Key points: k1; k2" in written and "Answer key" not in written
    number = item_judge.render_question(2, {"question_type": "numerical", "question_text": "How far?", "correct_answer": 2.5, "unit": "m", "tolerance": 0.1, "explanation": "E"})
    assert "Answer key: 2.5 m (tolerance 0.1)" in number


def test_the_mock_judge_answers_every_question_in_the_prompt():
    from app.services.llm.mock_provider import MockProvider

    items = [{"ref": f"quiz-{n}", "item": question()} for n in range(1, 4)]
    messages = item_judge.build_messages("<excerpt/>", items)
    result = asyncio.run(MockProvider().generate_structured(messages, item_judge.ItemJudgeResult, purpose="judge"))
    assert [v.number for v in result.items] == [1, 2, 3]
    assert "every question number from 1 to 3" in "\n".join(m.content for m in messages)


def test_verdicts_go_back_to_their_items_and_are_tallied_per_generator():
    items = [{"ref": "quiz-1", "item": {}}, {"ref": "quiz-2", "item": {}}, {"ref": "exam-1", "item": {}}]
    result = {"items": [
        {"number": 1, "defects": ["wrong_key", "made_up"], "note": "B is right."},
        {"number": 3, "defects": [], "note": ""},
    ]}
    verdicts = item_judge.verdicts_by_ref(items, result)
    assert verdicts == {"quiz-1": {"defects": ["other", "wrong_key"], "note": "B is right."}, "exam-1": {"defects": [], "note": ""}}
    kinds = item_judge.tally([{"verdicts": verdicts}])
    assert (kinds["quiz"]["judged"], kinds["quiz"]["flagged"], kinds["quiz"]["rate"]) == (1, 1, 1.0)
    assert kinds["quiz"]["by_defect"]["wrong_key"] == 1 and kinds["quiz"]["by_defect"]["other"] == 1
    assert (kinds["exam"]["judged"], kinds["exam"]["flagged"]) == (1, 0)


# ---------------------------------------------------------------- what each generator wrote, dropped and stored

import defects  # noqa: E402


def call(purpose, raw, cost=0.01):
    return {"purpose": purpose, "raw_output": raw, "cost_usd": cost}


def test_a_generator_summary_counts_written_dropped_by_rule_unsupported_and_stored():
    good = question()
    stored_good = GeneratedQuestion.model_validate(good).normalized()
    records = [
        {   # 4 written: 1 malformed (key not an option), 1 dropped by the support check, 1 spare cut, 1 stored
            "status": "ok",
            "seconds": 10.0,
            "calls": [call("topic_quiz", {"questions": [good, question(correct_answer="E"), good, good]}, 0.10), call("router", {"items": []}, 0.01)],
            "support": [{"sent": 3, "kept": 2, "dropped": [stored_good]}],
            "output": [stored_good],
        },
        {   # a run that failed after writing 2 questions with no misconception: nothing stored
            "status": "error",
            "seconds": 4.0,
            "error": "LLMOutputError: Quiz had 0 usable questions",
            "calls": [call("topic_quiz", {"questions": [question(options=[option("A", "Red", ""), option("B", "Blue", ""), option("C", "Green")])] * 2}, 0.05)],
            "support": [],
            "output": [],
        },
    ]
    summary = defects.summarize_kind("quiz", records)
    assert (summary["runs"], summary["failed"]) == (2, 1)
    assert (summary["written"], summary["malformed"], summary["unsupported"], summary["other_losses"], summary["stored"]) == (6, 3, 1, 1, 1)
    assert summary["by_reason"] == {"answer_not_in_options": 1, "missing_misconception": 2}
    assert summary["drop_rate"] == pytest.approx(5 / 6)
    assert summary["unsupported_rate"] == pytest.approx(1 / 3)
    assert summary["cost_usd"] == pytest.approx(0.16)
    assert summary["checks"]["items"] == 1


def test_a_problem_generator_summary_names_its_drop_rules():
    usable = problem()
    leaking = problem(step(correct_answer="2", acceptable_answers=["two"], hints=["Look at the hand.", "Pick any two cards.", "Count them."]))
    stored = InteractiveExample.model_validate(usable).stored()
    records = [{"status": "ok", "seconds": 5.0, "calls": [call("interactive_examples", {"examples": [usable, leaking]})], "support": [], "output": [stored]}]
    summary = defects.summarize_kind("interactive", records)
    assert (summary["written"], summary["malformed"], summary["stored"]) == (2, 1, 1)
    assert summary["by_reason"] == {"hint_leak_word_form": 1}
    assert summary["unsupported_rate"] is None
    assert summary["checks"]["items"] == 1

"""Tests for A2's adapters: why the app drops an item, the support-check recorder and per-task call records.
No database, no network; app code is imported as in test_pipeline.py.
"""
import asyncio
import json
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
from app.services.llm.schemas import GeneratedQuestion, InteractiveExample  # noqa: E402
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
    ("two options", question(options=[option("A", "Red", ""), option("B", "Blue")]), "too_few_options"),
    ("repeated id", question(options=[option("A", "Red", ""), option("B", "Blue"), option("B", "Green")]), "duplicate_options"),
    ("key not an option", question(correct_answer="E"), "answer_not_in_options"),
    ("wrong option without misconception", question(options=[option("A", "Red", ""), option("B", "Blue", ""), option("C", "Green")]), "missing_misconception"),
    ("true/false without a boolean", {"question_type": "true_false", "question_text": "Is it red?", "correct_answer": "maybe", "explanation": "Yes."}, "bad_answer"),
    ("short answer without key points", {"question_type": "short_answer", "question_text": "Why?", "sample_answer": "Because.", "explanation": "So."}, "incomplete_short_answer"),
]


@pytest.mark.parametrize("name,raw,reason", QUESTION_CASES, ids=[c[0] for c in QUESTION_CASES])
def test_question_drop_reason_names_the_rule_and_agrees_with_the_app(name, raw, reason):
    assert adapters.question_drop_reason(raw) == reason
    kept = GeneratedQuestion.model_validate(raw).normalized() is not None
    assert kept == (reason is None)


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


# ---------------------------------------------------------------- the support-check recorder


def fake_module():
    module = types.ModuleType("fake_generator")

    async def check_support(items, chunks):
        from app.services.content_generator import support_check

        sink = support_check._DROP_SINK.get()
        if sink is not None:  # the app's check reports why it dropped an item; the last one here has no reason
            sink.append((items[1], support_check.REASON_QUOTE_MISSING))
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
    assert records == [{"sent": 3, "kept": 1, "dropped": [items[1], items[2]], "reasons": ["a quote is not in the excerpt it names", ""]}]
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


def test_a_call_record_names_the_schema_and_system_prompt_that_were_sent():
    from app.services.llm.schemas import QuestionSet, QuestionSetV2

    tracker = SpendTracker(1.0, 1.0, adapters.estimate_cost)
    provider = adapters.MeteredProvider(FakeProvider(), adapters.parse_model_spec("haiku:low"), tracker, GENERATION)
    messages = [LLMMessage(role="system", content="rules"), LLMMessage(role="user", content="go")]
    schemas = {}
    for schema in (QuestionSet, QuestionSetV2):
        with adapters.call_sink() as calls:
            try:
                asyncio.run(provider.generate_structured(messages, schema, purpose="quiz"))
            except Exception:  # FakeProvider need not support structured output; the request is recorded either way
                pass
        schemas[schema.__name__] = calls[0]["request"]["schema"]
    assert schemas == {"QuestionSet": "QuestionSet", "QuestionSetV2": "QuestionSetV2"}


# ---------------------------------------------------------------- the item judge

import item_judge  # noqa: E402


def test_verdicts_go_back_to_their_items_and_are_tallied_per_generator():
    items = [{"ref": "quiz-1", "item": {}}, {"ref": "quiz-2", "item": {}}, {"ref": "exam-1", "item": {}}]
    result = {"items": [
        {"number": 1, "faults": [{"kind": "wrong_key", "note": "B is right."}, {"kind": "made_up", "note": "The stem names no unit."}]},
        {"number": 3, "faults": []},
    ]}
    verdicts = item_judge.verdicts_by_ref(items, result)
    assert verdicts == {
        "quiz-1": {"defects": ["other", "wrong_key"], "unexplained": [], "note": "B is right. The stem names no unit."},
        "exam-1": {"defects": [], "unexplained": [], "note": ""},
    }
    kinds = item_judge.tally([{"verdicts": verdicts}])
    assert (kinds["quiz"]["judged"], kinds["quiz"]["flagged"], kinds["quiz"]["rate"]) == (1, 1, 1.0)
    assert kinds["quiz"]["by_defect"]["wrong_key"] == 1 and kinds["quiz"]["by_defect"]["other"] == 1
    assert (kinds["exam"]["judged"], kinds["exam"]["flagged"]) == (1, 0)


def test_a_fault_without_a_note_is_not_a_flag():
    """Review of the PR 1.7 A2 run: 6 of its 8 flags had no note ("other" with nothing said), so nobody could check
    them and they were counted like the two that could be. A fault now counts only with its note; the rest are shown
    apart. Verdicts stored before this (one note for all of a question's faults) are read the same way."""
    items = [{"ref": f"quiz-{n}", "item": {}} for n in (1, 2, 3)]
    result = {"items": [
        {"number": 1, "faults": [{"kind": "other", "note": "  "}]},
        {"number": 2, "faults": [{"kind": "two_correct", "note": "A and C both hold."}, {"kind": "guessable", "note": ""}]},
        {"number": 3, "faults": []},
    ]}
    verdicts = item_judge.verdicts_by_ref(items, result)
    assert verdicts["quiz-1"] == {"defects": [], "unexplained": ["other"], "note": ""}
    assert verdicts["quiz-2"] == {"defects": ["two_correct"], "unexplained": ["guessable"], "note": "A and C both hold."}
    stored_before = {"quiz-4": {"defects": ["other"], "note": ""}, "quiz-5": {"defects": ["wrong_key"], "note": "B is right."}}
    quiz = item_judge.tally([{"verdicts": {**verdicts, **stored_before}}])["quiz"]
    assert (quiz["judged"], quiz["flagged"], quiz["unexplained"], quiz["rate"]) == (5, 2, 2, 0.4)
    assert quiz["by_defect"]["other"] == 0 and quiz["by_defect"]["guessable"] == 0
    assert quiz["by_defect"]["two_correct"] == 1 and quiz["by_defect"]["wrong_key"] == 1


def test_a_resumed_run_judges_a_topic_again_when_it_has_items_the_judge_did_not_see(tmp_path):
    # PR 1.7 A2: the first run stored only warm-up items; the resume stored the rest, but each topic's judge file
    # already held a result, so the judge never saw them.
    class Judge:
        spec = types.SimpleNamespace(label="judge:test")

        def __init__(self):
            self.seen = []

        async def generate_structured(self, messages, schema, **kwargs):
            self.seen.append(messages[-2].content.count("<question "))
            return schema(items=[])

    warmup = {"ref": "warmup-1", "item": {"question_text": "Q1"}}
    quiz = {"ref": "quiz-1", "item": {"question_text": "Q2"}}
    (tmp_path / "t1.json").write_text(json.dumps({"group": "t1", "refs": ["warmup-1"], "result": {"items": []}, "calls": [{"cost_usd": 0.1}]}))
    judge = Judge()

    def run(items):
        return asyncio.run(item_judge.judge_topics(
            provider=judge, groups={"t1": {"excerpts": "", "items": items}}, judge_dir=tmp_path, log=lambda _: None
        ))

    run([warmup])
    assert judge.seen == []  # the same items: kept
    run([warmup, quiz])
    assert judge.seen == [2]
    record = json.loads((tmp_path / "t1.json").read_text())
    assert record["refs"] == ["warmup-1", "quiz-1"]
    assert record["calls"][0] == {"cost_usd": 0.1}  # the earlier judgment's spend still counts


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
            "support": [{"sent": 3, "kept": 2, "dropped": [stored_good], "reasons": ["a quote is not in the excerpt it names"]}],
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
    assert summary["unsupported_by_reason"] == {"a quote is not in the excerpt it names": 1}
    assert summary["cost_usd"] == pytest.approx(0.16)
    assert summary["checks"]["items"] == 1



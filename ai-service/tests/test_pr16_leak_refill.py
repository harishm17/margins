"""PR 1.6: finding 99 (a number word in a hint is not a hard leak) and finding 102 (a short set is refilled once).

Both are behind flags that are off by default, so each case runs with the flag off (today's behaviour) and on.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import settings
from app.services.content_generator.examples import ExampleType, ExamplesGenerator
from app.services.content_generator.quiz import QuizGenerator
from app.services.content_generator.warmup import generate_warmup
from app.services.llm.base import LLMOutputError
from app.services.llm.schemas import (
    ChoiceOption,
    GeneratedQuestion,
    InteractiveExample,
    InteractiveExampleSet,
    InteractiveStep,
    LeakVerdict,
    QuestionSet,
    WarmupSet,
)
from app.services.tutor.leak import blocks_alone, string_leak
from tests.context_stub import stub_topic_context
from tests.test_warmup import _choice, _llm as _warmup_llm, world  # noqa: F401  (world is a fixture)

CHUNKS = [
    {
        "id": "c1", "chunk_text": "Sets are groups of items.", "section_hierarchy": "1", "page_start": 1,
        "page_end": 1, "material_id": "m1", "filename": "sets.pdf", "category": "lecture_notes", "relevance_score": 0.9,
    }
]


# ---- 99 ----

@pytest.mark.parametrize(
    "reply, answers, expected",
    [
        ("Pick any two items and compare.", ["2", "two"], "word_form"),
        ("Add one each pass.", ["1", "one"], "word_form"),
        ("There are 2 items.", ["2", "two"], "hard"),
        ("The answer is two, then 2.", ["2", "two"], "hard"),
        ("The answer is two.", ["two"], "hard"),  # the exact answer text, with no numeral beside it
        ("Compare the items side by side.", ["2", "two"], None),
    ],
)
def test_string_leak_says_how_it_matched(reply, answers, expected):
    assert string_leak(reply, answers, 0) == expected


def test_a_word_form_is_dropped_only_while_the_flag_is_off(monkeypatch):
    match = string_leak("Pick any two items.", ["2", "two"], 0)
    assert blocks_alone(match)
    monkeypatch.setattr(settings, "LEAK_WORD_FORMS_TO_JUDGE", True)
    assert not blocks_alone(match)
    assert blocks_alone(string_leak("There are 2 items.", ["2", "two"], 0))  # a numeral stays a hard leak


def _problem(hint: str) -> InteractiveExample:
    step = InteractiveStep(
        step_number=1, question="How many items does the pair hold?", hints=["Look at the pair.", hint, "Count them."],
        answer_type="numeric", correct_answer="2", acceptable_answers=["two"], tolerance=0,
        explanation="A pair has 2 items.", feedback_correct="Yes.", feedback_incorrect="Count again.",
    )
    return InteractiveExample(title="Pairs", problem_statement="A pair of socks.", steps=[step], source_excerpts=[1])


async def _interactive(monkeypatch, hint, *, flag, revealed=False):
    monkeypatch.setattr(settings, "LEAK_WORD_FORMS_TO_JUDGE", flag)
    judged = []

    async def generate(messages, schema, **kwargs):
        if schema is LeakVerdict:
            judged.append(messages)
            return LeakVerdict(answer_revealed=revealed, reason="x" if revealed else "")
        return InteractiveExampleSet(examples=[_problem(hint)])

    llm = MagicMock()
    llm.generate_structured = AsyncMock(side_effect=generate)
    with stub_topic_context(CHUNKS), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        return await ExamplesGenerator().generate_examples("t1", "Sets", "d", ExampleType.INTERACTIVE, count=1), judged


@pytest.mark.asyncio
async def test_finding_99_a_neutral_word_form_hint_goes_to_the_judge(monkeypatch):
    result, judged = await _interactive(monkeypatch, "Pick any two items to compare.", flag=True)
    assert len(result["examples"]) == 1 and len(judged) == 1


@pytest.mark.asyncio
async def test_finding_99_the_judge_can_still_drop_a_word_form_hint(monkeypatch):
    with pytest.raises(LLMOutputError):
        await _interactive(monkeypatch, "It is two, the pair.", flag=True, revealed=True)


@pytest.mark.asyncio
async def test_finding_99_a_numeral_hint_is_refused_without_the_judge(monkeypatch):
    with pytest.raises(LLMOutputError):
        await _interactive(monkeypatch, "A pair holds 2 items.", flag=True)


@pytest.mark.asyncio
async def test_finding_99_flag_off_drops_the_word_form_problem(monkeypatch):
    with pytest.raises(LLMOutputError):
        await _interactive(monkeypatch, "Pick any two items to compare.", flag=False)


# ---- 102 ----

def _bare(n):
    question = _choice(n, "easy")
    question.options[1].misconception = None  # a wrong option without its misconception drops the question
    return question


@pytest.mark.usefixtures("passthrough_support")
class TestWarmupRefill:
    async def test_four_of_five_rejected_is_refilled_and_does_not_fail(self, db, world, monkeypatch):  # noqa: F811
        monkeypatch.setattr(settings, "SUPPORT_REFILL", True)
        first = WarmupSet(questions=[_bare(i) for i in range(4)] + [_choice(9, "medium")])
        second = WarmupSet(questions=[_choice(10, "easy"), _choice(11, "easy"), _choice(12, "medium"), _choice(13, "hard")])
        llm = _warmup_llm([])
        llm.generate_structured = AsyncMock(side_effect=[first, second])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            result = await generate_warmup(world.topic_id)
        assert result["total_questions"] == 5 and result["refilled"] == 4 and result["short_by"] == 0
        assert llm.generate_structured.await_count == 2

    async def test_a_set_still_short_after_the_refill_is_served_and_says_so(self, db, world, monkeypatch):  # noqa: F811
        monkeypatch.setattr(settings, "SUPPORT_REFILL", True)
        first = WarmupSet(questions=[_bare(i) for i in range(4)] + [_choice(9, "medium")])
        second = WarmupSet(questions=[_choice(10, "easy"), _choice(11, "hard"), _bare(12)])
        llm = _warmup_llm([])
        llm.generate_structured = AsyncMock(side_effect=[first, second])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            result = await generate_warmup(world.topic_id)  # 1 + 2 = 3, the floor
        assert result["total_questions"] == 3 and result["refilled"] == 2 and result["short_by"] == 2
        assert llm.generate_structured.await_count == 2  # asked once, never twice

    async def test_under_the_floor_after_the_refill_still_fails(self, db, world, monkeypatch):  # noqa: F811
        monkeypatch.setattr(settings, "SUPPORT_REFILL", True)
        first = WarmupSet(questions=[_bare(i) for i in range(4)] + [_choice(9, "medium")])
        second = WarmupSet(questions=[_choice(10, "easy"), _bare(11)])
        llm = _warmup_llm([])
        llm.generate_structured = AsyncMock(side_effect=[first, second])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            with pytest.raises(LLMOutputError, match="2 usable questions of 5"):
                await generate_warmup(world.topic_id)

    async def test_flag_off_fails_as_before(self, db, world):  # noqa: F811
        llm = _warmup_llm([_bare(i) for i in range(4)] + [_choice(9, "medium")])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            with pytest.raises(LLMOutputError, match="1 usable questions of 5"):
                await generate_warmup(world.topic_id)
        assert llm.generate_structured.await_count == 1


def _mcq(text, answer="B"):
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=text,
        options=[ChoiceOption(id=x, text=f"Option {x}", misconception="wrong idea") for x in "ABCD"],
        correct_answer=answer, explanation="Because.",
    )


@pytest.mark.usefixtures("passthrough_support")
@pytest.mark.parametrize("flag", [False, True])
@pytest.mark.asyncio
async def test_quiz_refills_once_when_under_its_floor(monkeypatch, flag):
    monkeypatch.setattr(settings, "SUPPORT_REFILL", flag)
    first = QuestionSet(questions=[_mcq("bad key", answer="E")] * 4)
    second = QuestionSet(questions=[_mcq("Good one"), _mcq("Another")])
    llm = MagicMock()
    llm.generate_structured = AsyncMock(side_effect=[first, second])
    with stub_topic_context(CHUNKS), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        if not flag:
            with pytest.raises(LLMOutputError):
                await QuizGenerator().generate_quiz("t1", "Sets", "d", question_count=2)
            return
        result = await QuizGenerator().generate_quiz("t1", "Sets", "d", question_count=2)
    assert result["total_questions"] == 2 and result["refilled"] == 2 and result["short_by"] == 0
    assert json.dumps(result)  # the result is plain data the job stores

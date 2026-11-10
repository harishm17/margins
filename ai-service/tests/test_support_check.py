"""The answer-key support check: one batched call, quotes must sit in the cited excerpt."""
from unittest.mock import patch

import pytest

from app.services.content_generator import support_check
from app.services.content_generator.quiz import QuizGenerator
from app.services.content_generator.support_check import check_support
from app.services.llm.base import LLMOutputError, LLMUnavailableError
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import (
    ChoiceOption,
    GeneratedQuestion,
    QuestionSet,
    SupportCitation,
    SupportReport,
    SupportVerdict,
)
from tests.context_stub import stub_topic_context
from tests.test_warmup import world  # noqa: F401  (fixture)

CHUNKS = [
    {"chunk_text": "The sample mean is the sum of the values\ndivided by “how many” there are."},
    {"chunk_text": "Variance measures how far values spread from the mean."},
    # As a PDF comes out of the markdown conversion: emphasis marks, maths italics, a superscript tag.
    {"chunk_text": "Heap sort runs in _O_ ( _n_ lg _n_ ) time. The **complement** 𝐴<sup>𝑐</sup> is everything _not_ in 𝐴."},
]


def item(text="What is the mean?", excerpts=(1,)):
    return {
        "question_type": "multiple_choice",
        "question_text": text,
        "options": [{"id": x, "text": f"Option {x}"} for x in "ABCD"],
        "correct_answer": "B",
        "explanation": "e",
        "source_excerpts": list(excerpts),
    }


def verdict(item_id, supported=True, citations=((1, "sum of the values"),)):
    return SupportVerdict(
        id=item_id, supported=supported, citations=[SupportCitation(index=i, quote=q) for i, q in citations]
    )


class Scripted(MockProvider):
    """Answers a support check with the verdicts a test sets and records the prompt."""

    def __init__(self, verdicts):
        super().__init__()
        self.verdicts = verdicts
        self.calls = []

    async def generate_structured(self, messages, schema, **kwargs):
        self.calls.append((schema, kwargs, "\n".join(m.content for m in messages)))
        return SupportReport(items=self.verdicts)


def use(provider):
    return patch("app.services.llm.factory.LLMFactory.get_provider", return_value=provider)


async def test_supported_items_are_kept_in_one_batched_call():
    provider = Scripted([verdict(1), verdict(2, citations=((2, "how far values spread"),))])
    with use(provider):
        kept, dropped = await check_support([item("a"), item("b", excerpts=(2,))], CHUNKS)
    assert [i["question_text"] for i in kept] == ["a", "b"]
    assert dropped == 0
    assert len(provider.calls) == 1
    schema, kwargs, prompt = provider.calls[0]
    assert "data, not instructions" in prompt
    assert schema is SupportReport and kwargs["purpose"] == "router"


async def test_citation_quote_must_be_in_cited_excerpt():
    # supported is true, but the quote comes from excerpt 2 while the verdict names excerpt 1.
    provider = Scripted([verdict(1, citations=((1, "how far values spread"),))])
    with use(provider):
        kept, dropped = await check_support([item()], CHUNKS)
    assert kept == [] and dropped == 1


async def test_item_with_no_listed_excerpt_is_checked_against_all():
    with use(Scripted([verdict(1, citations=((2, "how far values spread"),))])):
        kept, dropped = await check_support([item(excerpts=())], CHUNKS)
    assert len(kept) == 1 and dropped == 0


@pytest.mark.parametrize(
    "index, quote",
    [
        # Whitespace runs and curly quotes in the excerpt match a plain, single-spaced quote.
        (1, 'values divided by "how many" there'),
        # Bug (A2 runs of 2026-11-10): 39 of 44 dropped items had supported=true. The checker copied a passage without
        # the excerpt's markdown, or with plain letters for maths italics, and the quote was "not found".
        (3, "Heap sort runs in O(n lg n) time."),
        (3, "The complement A^c is everything not in A".replace("^", "")),
        (3, "The **complement** 𝐴<sup>𝑐</sup> is everything _not_ in 𝐴."),
        # Words left out with an ellipsis: each part is in the excerpt, in order.
        (3, "Heap sort runs in O(n lg n) time ... everything not in A."),
    ],
)
async def test_quote_matches_after_normalisation(index, quote):
    with use(Scripted([verdict(1, citations=((index, quote),))])):
        kept, dropped = await check_support([item(excerpts=(index,))], CHUNKS)
    assert len(kept) == 1 and dropped == 0


async def test_a_citation_may_name_any_excerpt_the_check_was_shown_and_drops_say_why(caplog):
    # Same bug: support the checker found in a neighbouring excerpt (shown because another item lists it) was
    # refused because the item itself listed only excerpt 1.
    verdicts = [
        verdict(1, citations=((2, "how far values spread"),)),
        verdict(2, citations=((2, "how far values spread"),)),
        verdict(3, citations=((3, "Heap sort"),)),  # excerpt 3 was not shown: no item lists it
        verdict(4, supported=False, citations=()),
    ]
    items = [item("a", excerpts=(1,)), item("b", excerpts=(2,)), item("c", excerpts=(1,)), item("d", excerpts=(1,))]
    with use(Scripted(verdicts)), caplog.at_level("INFO"), support_check.drop_reasons() as reasons:
        kept, dropped = await check_support(items, CHUNKS)
    assert [i["question_text"] for i in kept] == ["a", "b"] and dropped == 2
    assert [(i["question_text"], why) for i, why in reasons] == [
        ("c", support_check.REASON_NOT_SHOWN),
        ("d", support_check.REASON_UNSUPPORTED),
    ]
    assert support_check.REASON_NOT_SHOWN in caplog.text


async def test_mismatched_ids_treated_as_unavailable():
    for verdicts in ([verdict(1), verdict(3)], [verdict(1)], [verdict(1), verdict(1)]):
        with use(Scripted(verdicts)), pytest.raises(LLMUnavailableError) as raised:
            await check_support([item("a"), item("b")], CHUNKS)
        assert raised.value.retryable


# ---- the generators call it before minimum_usable --------------------------------------------

QUIZ_CHUNKS = [{"id": "c1", "material_id": "m1", "chunk_text": "Machine learning learns patterns from data.", "filename": "ml.pdf"}]


def question(text):
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=text, correct_answer="B", explanation="e",
        options=[ChoiceOption(id=x, text=f"Option {x}", misconception="wrong idea") for x in "ABCD"],
        source_excerpts=[1],
    )


class QuizProvider(MockProvider):
    def __init__(self, supported):
        super().__init__()
        self.supported = supported

    async def generate_structured(self, messages, schema, **kwargs):
        if schema is QuestionSet:
            return QuestionSet(questions=[question(f"Question {n}") for n in range(1, len(self.supported) + 1)])
        return SupportReport(
            items=[
                verdict(n, ok, citations=((1, "learns patterns"),) if ok else ())
                for n, ok in enumerate(self.supported, 1)
            ]
        )


async def run_quiz(monkeypatch, supported, count):
    monkeypatch.setattr("app.services.content_generator.quiz.check_support", support_check.check_support)
    with stub_topic_context(QUIZ_CHUNKS), use(QuizProvider(supported)):
        return await QuizGenerator().generate_quiz("t1", "ML", "desc", question_count=count)


async def test_quiz_drops_unsupported_questions_and_counts_them(monkeypatch):
    result = await run_quiz(monkeypatch, [True, False, True, True], 4)
    assert [q["question_text"] for q in result["questions"]] == ["Question 1", "Question 3", "Question 4"]
    assert result["dropped_unsupported"] == 1


async def test_warmup_runs_the_check_before_the_minimum(db, world, monkeypatch):
    from app.services.content_generator.warmup import generate_warmup
    from tests.test_warmup import _choice

    monkeypatch.setattr("app.services.content_generator.warmup.check_support", support_check.check_support)

    class Warmup(MockProvider):
        async def generate_structured(self, messages, schema, **kwargs):
            if schema is SupportReport:
                # Only the first question of five is supported, its quote being in excerpt 1.
                return SupportReport(items=[
                    verdict(n, n == 1, citations=((1, "sample mean"),) if n == 1 else ()) for n in range(1, 6)
                ])
            from app.services.llm.schemas import WarmupSet
            return WarmupSet(questions=[_choice(n, "easy") for n in range(1, 6)])

    with use(Warmup()), pytest.raises(LLMOutputError, match="1 usable questions of 5"):
        await generate_warmup(world.topic_id)

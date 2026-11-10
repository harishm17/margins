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
    assert schema is SupportReport and kwargs["purpose"] == "router"
    assert "<excerpts>" in prompt and "<items>" in prompt and "data, not instructions" in prompt
    assert "Partial coverage of the topic doesn't support an unrelated fact." in prompt
    assert "Correct answer: Option B" in prompt


async def test_unsupported_item_dropped():
    provider = Scripted([verdict(1), verdict(2, supported=False, citations=())])
    with use(provider):
        kept, dropped = await check_support([item("a"), item("b")], CHUNKS)
    assert [i["question_text"] for i in kept] == ["a"]
    assert dropped == 1


async def test_citation_quote_must_be_in_cited_excerpt():
    # supported is true, but the quote comes from excerpt 2 while the verdict names excerpt 1.
    provider = Scripted([verdict(1, citations=((1, "how far values spread"),))])
    with use(provider):
        kept, dropped = await check_support([item()], CHUNKS)
    assert kept == [] and dropped == 1


async def test_supported_without_any_citation_is_dropped():
    with use(Scripted([verdict(1, citations=())])):
        kept, dropped = await check_support([item()], CHUNKS)
    assert kept == [] and dropped == 1


async def test_a_citation_to_an_excerpt_the_item_did_not_list_is_dropped():
    with use(Scripted([verdict(1, citations=((2, "how far values spread"),))])):
        kept, dropped = await check_support([item(excerpts=(1,))], CHUNKS)
    assert kept == [] and dropped == 1


async def test_item_with_no_listed_excerpt_is_checked_against_all():
    with use(Scripted([verdict(1, citations=((2, "how far values spread"),))])):
        kept, dropped = await check_support([item(excerpts=())], CHUNKS)
    assert len(kept) == 1 and dropped == 0


async def test_quote_matches_after_normalisation():
    # Whitespace runs and curly quotes in the excerpt match a plain, single-spaced quote.
    quote = 'values divided by "how many" there'
    with use(Scripted([verdict(1, citations=((1, quote),))])):
        kept, dropped = await check_support([item()], CHUNKS)
    assert len(kept) == 1 and dropped == 0


async def test_mismatched_ids_treated_as_unavailable():
    for verdicts in ([verdict(1), verdict(3)], [verdict(1)], [verdict(1), verdict(1)]):
        with use(Scripted(verdicts)), pytest.raises(LLMUnavailableError) as raised:
            await check_support([item("a"), item("b")], CHUNKS)
        assert raised.value.retryable


async def test_an_empty_set_makes_no_call():
    provider = Scripted([])
    with use(provider):
        assert await check_support([], CHUNKS) == ([], 0)
    assert provider.calls == []


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


async def test_too_few_supported_fails_set(monkeypatch):
    with pytest.raises(LLMOutputError, match="1 usable questions of 4"):
        await run_quiz(monkeypatch, [True, False, False, False], 4)


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

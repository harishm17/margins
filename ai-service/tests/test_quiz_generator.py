"""Tests for quiz generation."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.context_stub import stub_topic_context
from app.services.content_generator.context import NoSourceMaterialError
from app.services.content_generator.quiz import QuestionType, QuizGenerator, minimum_usable
from app.services.llm.base import LLMOutputError
from app.services.llm.schemas import ChoiceOption, GeneratedQuestion, QuestionSet


pytestmark = pytest.mark.usefixtures("passthrough_support")


CHUNKS = [
    {
        "id": "c1",
        "chunk_text": "Machine learning learns patterns from data.",
        "section_hierarchy": "Chapter 1",
        "page_start": 1,
        "page_end": 1,
        "filename": "ml.pdf",
        "category": "lecture_notes",
        "relevance_score": 0.9,
    }
]


def _mcq(text="What is ML?", answer="B"):
    return GeneratedQuestion(
        question_type="multiple_choice",
        question_text=text,
        options=[ChoiceOption(id=x, text=f"Option {x}", misconception="wrong idea") for x in "ABCD"],
        correct_answer=answer,
        explanation="Because.",
    )


def _tf():
    return GeneratedQuestion(
        question_type="true_false", question_text="ML needs data.", correct_answer=True, explanation="It does."
    )


async def _run(questions, **kwargs):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=QuestionSet(questions=questions))
    with stub_topic_context(CHUNKS), \
         patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        result = await QuizGenerator().generate_quiz("t1", "ML", "desc", **kwargs)
    return result, llm


class TestQuizGenerator:
    @pytest.mark.asyncio
    async def test_returns_valid_questions_and_metadata(self):
        result, llm = await _run([_mcq(), _tf()], question_count=2)
        assert result["total_questions"] == 2
        assert result["question_types"] == [qt.value for qt in QuestionType]
        assert {q["question_type"] for q in result["questions"]} == {"multiple_choice", "true_false"}
        assert llm.generate_structured.call_args.args[1] is QuestionSet
        assert llm.generate_structured.call_args.kwargs["purpose"] == "topic_quiz"

    @pytest.mark.asyncio
    async def test_invalid_questions_are_dropped(self):
        bad_answer = _mcq(text="Bad key", answer="E")
        result, _ = await _run([_mcq(), bad_answer, _tf()], question_count=3)
        assert [q["question_text"] for q in result["questions"]] == ["What is ML?", "ML needs data."]

    @pytest.mark.asyncio
    async def test_types_outside_the_request_are_dropped(self):
        result, llm = await _run(
            [_mcq(), _tf()], question_count=2, question_types=[QuestionType.MULTIPLE_CHOICE]
        )
        assert [q["question_type"] for q in result["questions"]] == ["multiple_choice"]
        assert "multiple_choice." in llm.generate_structured.call_args.args[0][-1].content

    @pytest.mark.asyncio
    async def test_too_few_usable_questions_fail(self):
        with pytest.raises(LLMOutputError, match="1 usable questions of 10"):
            await _run([_mcq()], question_count=10)

    @pytest.mark.asyncio
    async def test_no_chunks_is_not_retryable(self):
        with stub_topic_context([]), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MagicMock()):
            with pytest.raises(NoSourceMaterialError):
                await QuizGenerator().generate_quiz("t1", "ML", "desc")

    def test_minimum_usable(self):
        assert [minimum_usable(n) for n in (1, 2, 5, 10)] == [1, 1, 3, 5]

    def test_question_type_values(self):
        assert {qt.value for qt in QuestionType} == {
            "multiple_choice", "short_answer", "numerical", "true_false"
        }

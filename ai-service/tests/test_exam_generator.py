"""Tests for exam planning and generation."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.context_stub import stub_topic_context
from app.services.exam_generator import ExamGenerator, plan_exam
from app.services.llm.base import LLMUnavailableError
from app.services.llm.schemas import ChoiceOption, GeneratedQuestion, QuestionSet


DIST = {"multiple_choice": 60, "short_answer": 30, "numerical": 10}


class TestPlanning:

    def test_fewer_questions_than_topics(self):
        """5 questions over 12 topics is 5 questions, not 12."""
        plan = plan_exam([f"t{i}" for i in range(12)], 5, DIST)
        assert sum(sum(c.values()) for c in plan.values()) == 5
        assert len(plan) == 5

    def test_type_mix_is_honoured_and_spread(self):
        plan = plan_exam(["a", "b", "c"], 20, DIST)
        totals = {}
        for counts in plan.values():
            for q_type, n in counts.items():
                totals[q_type] = totals.get(q_type, 0) + n
        assert totals == {"multiple_choice": 12, "short_answer": 6, "numerical": 2}
        assert sorted(sum(c.values()) for c in plan.values()) == [6, 7, 7]
        assert all(len(counts) >= 2 for counts in plan.values())


TOPICS = [
    {"id": "t1", "name": "Topic 1", "description": "d1", "keywords": []},
    {"id": "t2", "name": "Topic 2", "description": "d2", "keywords": []},
]
CHUNKS = [{"id": "c", "chunk_text": "text", "filename": "f.pdf", "category": "x", "page_start": 1, "page_end": 1}]


def _mcqs(n, prefix):
    return QuestionSet(
        questions=[
            GeneratedQuestion(
                question_type="multiple_choice",
                question_text=f"{prefix} {i}",
                options=[ChoiceOption(id=x, text=f"{prefix}{i}{x}", misconception="wrong idea") for x in "ABCD"],
                correct_answer="A",
                explanation="E",
            )
            for i in range(n)
        ]
    )


async def _generate(side_effect, total=4):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(side_effect=side_effect)
    with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=TOPICS)), \
         stub_topic_context(CHUNKS), \
         patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        return await ExamGenerator().generate_exam(
            "p1", ["t1", "t2"], {"total_questions": total, "question_type_distribution": {"multiple_choice": 100}}
        )


@pytest.mark.usefixtures("passthrough_support")
class TestGeneration:
    @pytest.mark.asyncio
    async def test_questions_are_tagged_and_capped_to_plan(self):
        exam = await _generate([_mcqs(5, "one"), _mcqs(5, "two")])
        assert exam["total_questions"] == 4
        assert {q["topic_id"] for q in exam["questions"]} == {"t1", "t2"}
        assert exam["topics_covered"] == ["Topic 1", "Topic 2"]


    @pytest.mark.asyncio
    async def test_one_failed_topic_keeps_the_rest(self):
        exam = await _generate([_mcqs(2, "one"), LLMUnavailableError("timeout")])
        assert exam["total_questions"] == 2


    @pytest.mark.asyncio
    async def test_too_few_questions_raise_the_underlying_error(self):
        with pytest.raises(LLMUnavailableError):
            await _generate([LLMUnavailableError("a"), LLMUnavailableError("b")])


@pytest.mark.usefixtures("passthrough_support")
class TestTopicsWithoutPages:
    @pytest.mark.asyncio
    async def test_a_topic_with_no_pages_is_left_out_before_the_questions_are_shared_out(self):
        """The exam has the number asked for, over the topics that can be written from, and says which were left out."""
        from tests.context_stub import topic_context

        llm = MagicMock()
        llm.generate_structured = AsyncMock(side_effect=[_mcqs(8, "one")])
        with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=TOPICS)), \
             stub_topic_context(CHUNKS, contexts={"t2": topic_context([])}), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            exam = await ExamGenerator().generate_exam(
                "p1", ["t1", "t2"], {"total_questions": 5, "question_type_distribution": {"multiple_choice": 100}}
            )
        assert exam["total_questions"] == 5
        assert {q["topic_id"] for q in exam["questions"]} == {"t1"}
        assert exam["topics_covered"] == ["Topic 1"]
        assert exam["skipped_topics"] == ["Topic 2"]
        assert llm.generate_structured.await_count == 1

    @pytest.mark.asyncio
    async def test_no_topic_with_pages_fails_the_exam(self):
        from app.services.content_generator.context import NoSourceMaterialError
        from tests.context_stub import topic_context

        with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=TOPICS)), \
             stub_topic_context([], context=topic_context([])), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MagicMock()):
            with pytest.raises(NoSourceMaterialError):
                await ExamGenerator().generate_exam("p1", ["t1", "t2"], {"total_questions": 5})

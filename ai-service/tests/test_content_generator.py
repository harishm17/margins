"""Tests for notes and examples generation and the shared source context."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.context_stub import stub_topic_context
from app.services.content_generator.context import (
    CONTENT_SYSTEM_PROMPT,
    NoSourceMaterialError,
    content_messages,
)
from app.services.content_generator.examples import ExampleType, ExamplesGenerator
from app.services.content_generator.notes import NotesGenerator
from app.services.llm.base import LLMOutputError, LLMResponse, LLMUsage
from app.services.llm.schemas import (
    SolvedExample,
    SolvedExampleSet,
    SolutionStep,
)


CHUNKS = [
    {
        "id": "c1",
        "chunk_text": "Photosynthesis turns light energy into chemical energy.",
        "section_hierarchy": "Chapter 1 > Light reactions",
        "page_start": 3,
        "page_end": 4,
        "material_id": "m1",
        "filename": "bio.pdf",
        "category": "lecture_notes",
        "relevance_score": 0.9,
    },
    {
        "id": "c2",
        "chunk_text": "The Calvin cycle fixes carbon dioxide.",
        "section_hierarchy": None,
        "page_start": 5,
        "page_end": 5,
        "material_id": "m1",
        "filename": "bio.pdf",
        "category": "lecture_notes",
        "relevance_score": 0.8,
    },
]

LONG_NOTES = "# Photosynthesis\n\n## Overview\n" + ("Plants capture light energy. " * 40)


def _llm(text=None, structured=None):
    llm = MagicMock()
    llm.generate_text = AsyncMock(
        return_value=LLMResponse(
            content=text or "", model="m", stop_reason="end_turn", usage=LLMUsage(model="m")
        )
    )
    llm.generate_structured = AsyncMock(return_value=structured)
    return llm


def _patched(llm, chunks=CHUNKS, **stub):
    return (
        stub_topic_context(chunks, **stub),
        patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm),
    )


class TestSharedContext:

    def test_prefix_is_identical_across_tasks(self):
        """Every generator shares system prompt + excerpts, so a regeneration can read the cache."""
        a = content_messages("T", "D", CHUNKS, "write notes", cache_excerpts=True)
        b = content_messages("T", "D", CHUNKS, "write a quiz", cache_excerpts=True)
        assert a[0].content == b[0].content == CONTENT_SYSTEM_PROMPT
        assert a[1].content == b[1].content and a[1].cache is True
        assert a[2].content != b[2].content and a[2].cache is False


class TestNotesGeneration:
    @pytest.mark.asyncio
    async def test_generates_notes_with_citations(self):
        llm = _llm(text=LONG_NOTES)
        db, factory = _patched(llm)
        with db, factory:
            result = await NotesGenerator().generate_notes("t1", "Photosynthesis", "desc", {"focus": "Calvin cycle"})
        assert result["content"].startswith("# Photosynthesis")
        assert result["citations"] == [
            {"filename": "bio.pdf", "category": "lecture_notes", "pages": "3-4", "material_id": "m1", "page": 3}
        ]
        kwargs = llm.generate_text.call_args.kwargs
        assert kwargs["purpose"] == "section_notes"
        instructions = llm.generate_text.call_args.args[0][-1].content
        assert "Calvin cycle" in instructions


    @pytest.mark.asyncio
    async def test_too_short_notes_are_rejected(self):
        db, factory = _patched(_llm(text="# Notes\n\nToo short."))
        with db, factory, pytest.raises(LLMOutputError, match="too short"):
            await NotesGenerator().generate_notes("t1", "P", "d")

    @pytest.mark.asyncio
    async def test_no_chunks_is_not_retryable(self):
        db, factory = _patched(_llm(text=LONG_NOTES), chunks=[])
        with db, factory, pytest.raises(NoSourceMaterialError):
            await NotesGenerator().generate_notes("t1", "P", "d")

    def test_postprocess_leaves_code_blocks_alone(self):
        generator = NotesGenerator.__new__(NotesGenerator)
        raw = (
            "Overview\nText [Citation: a.pdf p1] here\n\n\n\n"
            "```python\ndef f():\n    return  1\n\n\n\n```\n1) a list item"
        )
        cleaned = generator._postprocess_notes_markdown(raw)
        assert cleaned.startswith("## Overview\nText here")
        assert "    return  1\n\n\n\n```" in cleaned  # indentation and blank lines kept
        assert "1) a list item" in cleaned  # not turned into a heading


def _solved(title="Example", steps=1):
    return SolvedExample(
        title=title,
        problem_statement="Problem",
        solution_steps=[
            SolutionStep(step_number=i + 1, description="d", work="w", explanation="e") for i in range(steps)
        ],
        final_answer="- answer",
        key_concepts=["c"],
    )


class TestExamplesGeneration:
    @pytest.mark.asyncio
    async def test_solved_examples_drop_unusable_items(self):
        structured = SolvedExampleSet(examples=[_solved("Good"), _solved("No steps", steps=0)])
        llm = _llm(structured=structured)
        db, factory = _patched(llm)
        with db, factory:
            result = await ExamplesGenerator().generate_examples(
                "t1", "P", "d", ExampleType.SOLVED, count=3
            )
        assert [e["title"] for e in result["examples"]] == ["Good"]
        assert llm.generate_structured.call_args.args[1] is SolvedExampleSet

    @pytest.mark.asyncio
    async def test_all_unusable_is_an_output_error(self):
        llm = _llm(structured=SolvedExampleSet(examples=[_solved(steps=0)]))
        db, factory = _patched(llm)
        with db, factory, pytest.raises(LLMOutputError):
            await ExamplesGenerator().generate_examples("t1", "P", "d", ExampleType.SOLVED)



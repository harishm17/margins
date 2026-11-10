"""The audited (v2) requests of the generation and support areas, behind PROMPTS_V2.

What is checked here is behaviour: which request a flag picks, what the app stores, and what the model is shown of a
schema. The wording of the prompts is judged by the evals (evals/generation), not pinned here, and what untrusted text
can do to a v2 prompt is checked in tests/test_untrusted_prompts.py."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import settings
from app.services.content_generator import support_check
from app.services.content_generator.context import (
    CONTENT_SYSTEM_PROMPT,
    OBJECTIVES_HEADING,
    PREREQUISITES_HEADING,
    content_messages,
    format_source_excerpts,
)
from app.services.content_generator.examples import ExampleType, ExamplesGenerator
from app.services.content_generator.quiz import QuizGenerator
from app.services.exam_generator import ExamGenerator
from app.services.llm import schemas
from app.services.llm.schemas import (
    ChoiceOption,
    GeneratedQuestion,
    InteractiveExampleSet,
    QuestionSet,
    SolvedExampleSet,
)
from tests.context_stub import stub_topic_context

pytestmark = pytest.mark.usefixtures("passthrough_support")

CHUNKS = [
    {
        "id": "c1",
        "material_id": "m1",
        "chunk_text": "The mean is the sum divided by the count.",
        "section_hierarchy": "Chapter 1",
        "page_start": 1,
        "page_end": 1,
        "filename": "ml.pdf",
        "category": "lecture_notes",
        "source_kind": "primary",
    }
]


@pytest.fixture
def v2(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "generation")


@pytest.fixture
def v1(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "")


def _mcq(answer="B", difficulty="whatever"):
    return GeneratedQuestion(
        question_type="multiple_choice",
        question_text="What is the mean?",
        options=[ChoiceOption(id=x, text=f"Option {x}", misconception="wrong idea") for x in "ABCD"],
        correct_answer=answer,
        explanation="Because.",
        difficulty=difficulty,
    )


def _llm(result):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=result)
    return llm


def _sent(llm):
    call = llm.generate_structured.call_args
    return call.args[0], call.args[1]


async def _quiz(difficulty="easy", questions=None):
    llm = _llm(QuestionSet(questions=questions or [_mcq()]))
    with stub_topic_context(CHUNKS, course_map="Course map: x"), patch(
        "app.services.llm.factory.LLMFactory.get_provider", return_value=llm
    ):
        result = await QuizGenerator().generate_quiz("t1", "Stats", "d", question_count=1, difficulty_level=difficulty)
    return result, llm


# ---------------------------------------------------------------- which request a flag picks, and what is stored


async def test_a_v1_quiz_keeps_the_models_difficulty_and_the_v1_request(v1):
    result, llm = await _quiz("easy")
    messages, schema = _sent(llm)
    assert schema is QuestionSet and messages[0].content == CONTENT_SYSTEM_PROMPT
    assert result["questions"][0]["difficulty"] == "whatever"  # the model's value, as today


async def test_a_v2_quiz_stores_the_difficulty_that_was_asked_for(v2):
    result, llm = await _quiz("easy")
    messages, schema = _sent(llm)
    assert schema is schemas.QuestionSetV2 and messages[0].content != CONTENT_SYSTEM_PROMPT
    assert result["questions"][0]["difficulty"] == "easy"  # the model is not asked: the code knows it


async def test_a_v2_exam_stores_the_difficulty_that_was_asked_for(v2):
    llm = _llm(QuestionSet(questions=[_mcq()]))
    with stub_topic_context(CHUNKS), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        questions, _, _ = await ExamGenerator()._generate_topic_questions(
            {"id": "t1", "name": "Stats", "description": "d"}, {"multiple_choice": 1}, "hard", ""
        )
    assert _sent(llm)[1] is schemas.QuestionSetV2
    assert questions[0]["difficulty"] == "hard"


async def test_flags_are_per_area(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "support")
    _, llm = await _quiz("easy")
    messages, schema = _sent(llm)
    assert schema is QuestionSet and messages[0].content == CONTENT_SYSTEM_PROMPT

    def support_system():
        item = {"question_type": "true_false", "question_text": "q", "correct_answer": True, "explanation": "e",
                "source_excerpts": [1]}
        return support_check._messages([item], [[1]], CHUNKS, [1])[0].content

    assert support_system() != support_check.SUPPORT_SYSTEM_PROMPT
    monkeypatch.setattr(settings, "PROMPTS_V2", "generation")
    assert support_system() == support_check.SUPPORT_SYSTEM_PROMPT


async def _examples(kind):
    result = SolvedExampleSet.example() if kind == ExampleType.SOLVED else InteractiveExampleSet.example()
    llm = _llm(result)
    with stub_topic_context(CHUNKS), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        out = await ExamplesGenerator().generate_examples("t1", "Stats", "d", kind, count=1, difficulty_level="hard")
    return out, llm


@pytest.mark.parametrize("kind", [ExampleType.SOLVED, ExampleType.INTERACTIVE])
async def test_examples_store_the_models_difficulty_on_v1_and_the_requested_one_on_v2(monkeypatch, kind):
    monkeypatch.setattr(settings, "PROMPTS_V2", "")
    out, _ = await _examples(kind)
    assert out["examples"][0]["difficulty"] is None  # the mock example names none
    monkeypatch.setattr(settings, "PROMPTS_V2", "generation")
    out, llm = await _examples(kind)
    assert _sent(llm)[1].__name__.endswith("V2")
    assert out["examples"][0]["difficulty"] == "hard"


# ---------------------------------------------------------------- what the model is shown of a v2 schema


def test_the_model_is_not_shown_a_field_the_app_fills_in():
    """Prompt review of PR #90: `difficulty` was still in the v2 schemas with the description "leave out", which asks a
    model to fill it. The app sets it after generation for a quiz, an exam, a review item and an example, so those
    schemas do not show it; a warm-up's difficulty is the model's (the bank is bracketed on it) and stays."""

    def fields(schema, definition):
        return list(schema.model_json_schema()["$defs"][definition]["properties"])

    for schema, definition in (
        (schemas.QuestionSetV2, "GeneratedQuestion"),
        (schemas.ReviewItemSetV2, "GeneratedQuestion"),
        (schemas.SolvedExampleSetV2, "SolvedExample"),
        (schemas.InteractiveExampleSetV2, "InteractiveExample"),
    ):
        assert "difficulty" not in fields(schema, definition), schema.__name__
    assert "difficulty" in fields(schemas.WarmupSetV2, "GeneratedQuestion")
    assert "difficulty" in fields(QuestionSet, "GeneratedQuestion")  # v1 as it was
    # R5: an interactive example's minutes are computed from its step count.
    assert "estimated_time_minutes" not in fields(schemas.InteractiveExampleSetV2, "InteractiveExample")


def test_a_v2_item_names_its_excerpts_before_its_answer():
    """Prompt review of PR #90: `source_excerpts` was the last field, written after the answer it should have come
    from. The model writes fields in the schema's order, so the v2 schemas ask for the excerpts first."""

    def order(schema, definition):
        return list(schema.model_json_schema()["$defs"][definition]["properties"])

    for schema in (schemas.QuestionSetV2, schemas.ReviewItemSetV2, schemas.WarmupSetV2):
        names = order(schema, "GeneratedQuestion")
        assert names.index("question_text") < names.index("source_excerpts") < names.index("options"), schema.__name__
        assert names.index("source_excerpts") < names.index("correct_answer")
    solved = order(schemas.SolvedExampleSetV2, "SolvedExample")
    assert solved.index("source_excerpts") < solved.index("solution_steps")
    interactive = order(schemas.InteractiveExampleSetV2, "InteractiveExample")
    assert interactive.index("source_excerpts") < interactive.index("steps")
    assert order(QuestionSet, "GeneratedQuestion")[-1] == "source_excerpts"  # v1 as it was
    # Parsing does not depend on the order.
    assert schemas.QuestionSetV2.model_validate(QuestionSet.example().model_dump()).questions


# ---------------------------------------------------------------- the course map


def test_the_v2_course_map_holds_data_only_and_its_rules_follow_the_tag(v2):
    """Prompt review of PR #90: the map's objectives and prerequisites lines carry rules ("teach these and nothing
    beyond them", "do not teach them again"), and v2 put the whole map inside <course_map>, a tag the system prompt
    calls data. The rules are now said after the tag; a map without those lines adds none."""
    course_map = f"Course map:\n- A  <- THIS TOPIC\n\n{OBJECTIVES_HEADING}\n- explain x\n\n{PREREQUISITES_HEADING}B; C"
    inside, _, after = format_source_excerpts("T", "d", CHUNKS, course_map).partition("</course_map>")
    assert "teach these" not in inside and "do not teach them again" not in inside
    assert "explain x" in inside and "B; C" in inside  # the objectives and the prerequisite names are still there
    rules = after.split("Source excerpts")[0].strip().splitlines()
    assert len(rules) == 2
    assert format_source_excerpts("T", "d", CHUNKS, "Course map:\n- A").partition("</course_map>")[2].startswith("\n\nSource excerpts")
    # v1 is the map as it was built.
    assert course_map in format_source_excerpts("T", "d", CHUNKS, course_map, v2=False)


# ---------------------------------------------------------------- callers outside the audit


async def test_lesson_notes_and_requote_stay_on_v1_with_every_area_switched_on(monkeypatch):
    """Review of PR #90: lesson notes and concept re-quoting were not audited but shared helpers that follow the flag,
    so with generation or ingest on they sent a v2 system prompt and excerpt layout around v1 instructions and a v1
    cap (a long lesson could be cut off). Both stay wholly on their earlier prompts until they are audited."""
    from app.services.concepts import requote
    from app.services.content_generator.notes import NotesGenerator
    from app.services.llm.schemas import ConceptRequote
    from tests.context_stub import topic_context

    monkeypatch.setattr(settings, "PROMPTS_V2", "all")
    llm = MagicMock()
    llm.generate_text = AsyncMock(return_value=SimpleNamespace(content="# Stats\n\n" + "word " * 100))
    with stub_topic_context(CHUNKS, course_map="Course map: x"), patch(
        "app.services.llm.factory.LLMFactory.get_provider", return_value=llm
    ):
        await NotesGenerator().generate_notes("t1", "Stats", "d", {"focus": "means"})
    system, excerpts, instructions = (m.content for m in llm.generate_text.call_args.args[0])
    assert system == CONTENT_SYSTEM_PROMPT
    assert "<course_map>" not in excerpts and "<student_focus>" not in instructions

    llm.generate_structured = AsyncMock(return_value=ConceptRequote(claims=[]))
    concept = {"id": "k1", "name": "Mean", "summary": "The average."}
    with patch.object(requote, "concepts_without_claims", AsyncMock(return_value=[concept])), patch.object(
        requote, "fetch_topic_context", AsyncMock(return_value=topic_context(CHUNKS, "Course map: x"))
    ), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        await requote.propose_quotes("t1")
    excerpts = llm.generate_structured.call_args.args[0][1].content
    assert "<topic>" not in excerpts and "<course_map>" not in excerpts
    assert content_messages("T", "d", CHUNKS, "x")[0].content != CONTENT_SYSTEM_PROMPT  # the audited callers are on v2

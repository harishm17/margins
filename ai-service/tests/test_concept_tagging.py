"""Generators tag their items with the topic's concepts, practice steps carry three hints, and a
wrong multiple-choice option names the idea behind it."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api.routes import voice
from app.services.content_generator.context import resolve_concept_ids
from app.services.content_generator.examples import ExampleType, ExamplesGenerator
from app.services.content_generator.quiz import QuizGenerator
from app.services.llm.schemas import (
    ChoiceOption,
    DrillQuestion,
    DrillQuestionSet,
    GeneratedQuestion,
    InteractiveExample,
    InteractiveExampleSet,
    InteractiveStep,
    QuestionSet,
)
from tests.context_stub import stub_topic_context

pytestmark = pytest.mark.usefixtures("passthrough_support")


CHUNKS = [
    {"id": "ch1", "chunk_text": "The mean is the sum divided by the count.", "filename": "s.pdf", "category": "x",
     "page_start": 1, "page_end": 1, "material_id": "m1"},
    {"id": "ch2", "chunk_text": "Variance is the average squared distance from the mean.", "filename": "s.pdf",
     "category": "x", "page_start": 2, "page_end": 2, "material_id": "m1"},
]
CONCEPTS = [
    {"id": "k-mean", "name": "Mean", "summary": "The average of values.", "order_index": 0, "chunk_ids": {"ch1"}},
    {"id": "k-var", "name": "Variance", "summary": "Spread around the mean.", "order_index": 1, "chunk_ids": {"ch2"}},
]
TOPICS = [{"id": "t1", "name": "Topic 1", "description": "d1", "keywords": []}]


def _mcq(text="What is the mean?", ids=None, excerpts=None, mode="recall", wrong=None, **option_overrides):
    """A multiple-choice question; `wrong` replaces the wrong options' fields, by option letter."""
    wrong = wrong or {}
    options = []
    for letter in "ABCD":
        fields = {} if letter == "A" else {"misconception": f"wrong idea {letter}"}
        fields.update(wrong.get(letter, {}))
        options.append(ChoiceOption(id=letter, text=f"Option {letter}", **fields))
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=text, options=options, correct_answer="A",
        explanation="Because.", concept_ids=ids or [], source_excerpts=excerpts or [], mode=mode,
    )


NEIGHBOURS = [
    {"id": "k-median", "name": "Median", "summary": "The middle value.", "topic_id": "t0"},
]


async def _quiz(questions, concepts=CONCEPTS, count=None, neighbours=None):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=QuestionSet(questions=questions))
    with stub_topic_context(CHUNKS, concepts=concepts, neighbours=neighbours), \
         patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        result = await QuizGenerator().generate_quiz("t1", "Stats", "d", question_count=count or len(questions))
    return result, llm


class TestConceptIds:
    async def test_quiz_items_get_valid_concept_ids(self):
        result, _ = await _quiz([
            _mcq("Known and unknown", ids=["k-var", "made-up"], excerpts=[1]),
            _mcq("None given, cites the second excerpt", ids=[], excerpts=[2]),
            _mcq("Only unknown ids, cites the first excerpt", ids=["made-up"], excerpts=[1]),
            _mcq("Nothing to go on", ids=[], excerpts=[]),
        ])
        assert [q["concept_ids"] for q in result["questions"]] == [["k-var"], ["k-var"], ["k-mean"], ["k-mean"]]


    async def test_examples_and_their_steps_are_tagged(self):
        problem = InteractiveExample(
            title="P", problem_statement="S", concept_ids=["k-var"], source_excerpts=[2],
            steps=[
                _step(1, concept_ids=["k-mean"]),
                _step(2, concept_ids=["made-up"]),
                _step(3),
            ],
        )
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=InteractiveExampleSet(examples=[problem]))
        with stub_topic_context(CHUNKS, concepts=CONCEPTS), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            result = await ExamplesGenerator().generate_examples("t1", "Stats", "d", ExampleType.INTERACTIVE, count=1)
        stored = result["examples"][0]
        assert stored["concept_ids"] == ["k-var"]
        assert [s["concept_ids"] for s in stored["steps"]] == [["k-mean"], ["k-var"], ["k-var"]]

    async def test_voice_drill_questions_are_tagged(self):
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=DrillQuestionSet(questions=[
            DrillQuestion(question_text="Explain variance", key_points=["k"], sample_answer="s", explanation="e",
                          concept_ids=["k-var", "made-up"]),
            DrillQuestion(question_text="Explain the mean", key_points=["k"], sample_answer="s", explanation="e"),
        ]))

        async def concepts(topic_id):
            return [dict(c) for c in CONCEPTS]

        with patch.object(voice.LLMFactory, "get_provider", return_value=llm), \
             patch.object(voice, "fetch_concepts", concepts):
            result = await voice.generate_concept_drill(
                voice.DrillGenerateRequest(topic_id="t1", notes="n", count=3)
            )
        assert [q["concept_ids"] for q in result["questions"]] == [["k-var"], ["k-mean"]]
        assert '<concept id="k-var">' in llm.generate_structured.call_args.args[0][-1].content


def _step(number=1, **overrides):
    fields = dict(
        step_number=number, question="How many?", answer_type="numeric", correct_answer="4",
        hints=["Where to look", "Which idea", "The general form"], explanation="e",
        feedback_correct="Yes", feedback_incorrect="No",
    )
    fields.update(overrides)
    return InteractiveStep(**fields)


class TestHints:

    @pytest.mark.parametrize("hints", [[], ["one"], ["a", "b"], ["a", "b", "c", "d"], ["a", " ", "c"]])
    def test_a_step_without_exactly_three_hints_is_unusable(self, hints):
        assert _step(hints=hints).normalized() is None
        assert InteractiveExample(title="P", problem_statement="S", steps=[_step(1), _step(hints=hints)]).stored() is None


class TestDistractors:
    async def test_every_distractor_names_its_misconception(self):
        assert _mcq(wrong={"C": {"misconception": None}}).normalized() is None
        assert _mcq(wrong={"D": {"misconception": "   "}}).normalized() is None
        stored = _mcq().normalized()
        by_id = {o["id"]: o for o in stored["options"]}
        assert by_id["A"] == {"id": "A", "text": "Option A"}  # the correct option names nothing
        assert by_id["B"]["misconception"] == "wrong idea B"

    async def test_a_question_with_a_bare_distractor_is_dropped_not_the_set(self):
        bare = _mcq("Bare", wrong={"B": {"misconception": None}})
        result, _ = await _quiz([bare, _mcq("Fine one"), _mcq("Fine two")], count=3)
        assert [q["question_text"] for q in result["questions"]] == ["Fine one", "Fine two"]


    async def test_distractor_confusable_id_must_be_known(self):
        result, _ = await _quiz([
            _mcq("Known twin", ids=["k-mean"], wrong={"B": {"confusable_concept_id": "k-var"}}),
            _mcq("Unknown twin", ids=["k-mean"], wrong={"B": {"confusable_concept_id": "made-up"}}),
            _mcq("Itself", ids=["k-mean"], wrong={"B": {"confusable_concept_id": "k-mean"}}),
        ])
        known, unknown, itself = (
            {o["text"]: o for o in q["options"]} for q in result["questions"]
        )
        assert known["Option B"]["confusable_concept_id"] == "k-var"
        assert "confusable_concept_id" not in unknown["Option B"]
        assert "confusable_concept_id" not in itself["Option B"]


class TestModes:
    async def test_items_carry_mode(self):
        result, _ = await _quiz([
            _mcq("Recall"),
            _mcq("Twins", ids=["k-mean"], mode="discrimination", wrong={"B": {"confusable_concept_id": "k-var"}}),
            _mcq("Twins, unnamed", ids=["k-mean"], mode="discrimination"),
            _mcq("Twins, unknown", ids=["k-mean"], mode="discrimination", wrong={"B": {"confusable_concept_id": "x"}}),
            _mcq("Chain", mode="composition"),
        ])
        assert [q["mode"] for q in result["questions"]] == [
            "recall", "discrimination", "recall", "recall", "composition",
        ]


class TestResolveDirectly:
    def test_prerequisite_review_questions_get_no_fallback_concept(self):
        items = [{"concept_ids": [], "source_excerpts": [1], "prerequisite_topic": "Earlier"}]
        resolve_concept_ids(items, CONCEPTS, CHUNKS)
        assert items[0]["concept_ids"] == []


class TestDegradation:
    async def test_voice_drill_survives_a_concept_lookup_failure(self):
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=DrillQuestionSet(questions=[
            DrillQuestion(question_text="Explain it", key_points=["k"], sample_answer="s", explanation="e"),
        ]))

        async def broken(topic_id):
            raise RuntimeError("database down")

        with patch.object(voice.LLMFactory, "get_provider", return_value=llm), \
             patch.object(voice, "fetch_concepts", broken):
            result = await voice.generate_concept_drill(voice.DrillGenerateRequest(topic_id="bad", notes="n", count=3))
        assert result["total"] == 1
        assert result["questions"][0]["concept_ids"] == []
        assert "<concept id=" not in llm.generate_structured.call_args.args[0][-1].content


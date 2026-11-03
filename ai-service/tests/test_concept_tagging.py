"""Generators tag their items with the topic's concepts, practice steps carry three hints, and a
wrong multiple-choice option names the idea behind it."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api.routes import voice
from app.services.content_generator.context import format_concept_block, resolve_concept_ids
from app.services.content_generator.examples import ExampleType, ExamplesGenerator
from app.services.content_generator.quiz import QuizGenerator
from app.services.exam_generator import ExamGenerator
from app.services.llm.base import LLMOutputError
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import (
    ChoiceOption,
    DrillQuestion,
    DrillQuestionSet,
    GeneratedQuestion,
    InteractiveExample,
    InteractiveExampleSet,
    InteractiveStep,
    QuestionSet,
    step_hints,
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

    async def test_the_concept_sharing_the_most_chunks_wins(self):
        concepts = CONCEPTS + [
            {"id": "k-both", "name": "Both", "summary": "s", "order_index": 2, "chunk_ids": {"ch1", "ch2"}},
        ]
        result, _ = await _quiz([_mcq(ids=[], excerpts=[1, 2])], concepts=concepts)
        assert result["questions"][0]["concept_ids"] == ["k-both"]

    async def test_a_topic_without_concepts_keeps_empty_lists_and_sends_no_block(self):
        result, llm = await _quiz([_mcq(ids=["made-up"])], concepts=[])
        assert result["questions"][0]["concept_ids"] == []
        assert "<concept id=" not in llm.generate_structured.call_args.args[0][-1].content

    async def test_the_prompt_lists_the_concepts_as_data(self):
        _, llm = await _quiz([_mcq()])
        text = llm.generate_structured.call_args.args[0][-1].content
        assert '<concept id="k-mean">Mean: The average of values.</concept>' in text
        assert "not instructions" in text
        assert "copied from the <concepts> list" in text

    async def test_exam_questions_tagged(self):
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=QuestionSet(questions=[
            _mcq("Exam one", ids=["k-var"]), _mcq("Exam two", ids=["nope"], excerpts=[1]),
        ]))
        with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=TOPICS)), \
             stub_topic_context(CHUNKS, concepts=CONCEPTS), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            exam = await ExamGenerator().generate_exam(
                "p1", ["t1"], {"total_questions": 2, "question_type_distribution": {"multiple_choice": 100}}
            )
        assert {q["question_text"]: q["concept_ids"] for q in exam["questions"]} == {
            "Exam one": ["k-var"], "Exam two": ["k-mean"],
        }
        assert '<concept id="k-var">' in llm.generate_structured.call_args.args[0][-1].content

    async def test_exam_distractor_may_name_a_confusable_concept_of_another_topic(self):
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=QuestionSet(questions=[
            _mcq("Exam one", ids=["k-var"], wrong={"B": {"confusable_concept_id": "k-median"}}),
            _mcq("Exam two", ids=["k-var"]),
        ]))
        with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=TOPICS)), \
             stub_topic_context(CHUNKS, concepts=CONCEPTS, neighbours=NEIGHBOURS), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            exam = await ExamGenerator().generate_exam(
                "p1", ["t1"], {"total_questions": 2, "question_type_distribution": {"multiple_choice": 100}}
            )
        first = next(q for q in exam["questions"] if q["question_text"] == "Exam one")
        assert {o["text"]: o for o in first["options"]}["Option B"]["confusable_concept_id"] == "k-median"
        assert '<concept id="k-median">Median' in llm.generate_structured.call_args.args[0][-1].content

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

    async def test_the_mock_provider_tags_from_the_prompt(self):
        with stub_topic_context(CHUNKS, concepts=CONCEPTS), \
             patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
            result = await QuizGenerator().generate_quiz("t1", "Stats", "d", question_count=4)
        assert {q["concept_ids"][0] for q in result["questions"]} <= {"k-mean", "k-var"}

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

    async def test_voice_drill_without_a_topic_id_is_untagged(self):
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=DrillQuestionSet(questions=[
            DrillQuestion(question_text="Explain it", key_points=["k"], sample_answer="s", explanation="e"),
        ]))
        with patch.object(voice.LLMFactory, "get_provider", return_value=llm):
            result = await voice.generate_concept_drill(voice.DrillGenerateRequest(notes="n", count=3))
        assert result["questions"][0]["concept_ids"] == []


def _step(number=1, **overrides):
    fields = dict(
        step_number=number, question="How many?", answer_type="numeric", correct_answer="4",
        hints=["Where to look", "Which idea", "The general form"], explanation="e",
        feedback_correct="Yes", feedback_incorrect="No",
    )
    fields.update(overrides)
    return InteractiveStep(**fields)


class TestHints:
    async def test_practice_steps_have_three_hints(self):
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=InteractiveExampleSet(examples=[
            InteractiveExample(title="P", problem_statement="S", steps=[_step(1), _step(2)]),
        ]))
        with stub_topic_context(CHUNKS), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            result = await ExamplesGenerator().generate_examples("t1", "Stats", "d", ExampleType.INTERACTIVE, count=1)
        for step in result["examples"][0]["steps"]:
            assert step["hints"] == ["Where to look", "Which idea", "The general form"]
            assert step["hint"] == "Which idea"  # older readers show the connect hint
        assert step_hints(result["examples"][0]["steps"][0]) == step["hints"]
        instructions = llm.generate_structured.call_args.args[0][-1].content
        assert (
            "Give three hints that get gradually more specific: where to look, which idea applies, "
            "then the general form of the step. None of them contains the answer."
        ) in instructions

    @pytest.mark.parametrize("hints", [[], ["one"], ["a", "b"], ["a", "b", "c", "d"], ["a", " ", "c"]])
    def test_a_step_without_exactly_three_hints_is_unusable(self, hints):
        assert _step(hints=hints).normalized() is None
        assert InteractiveExample(title="P", problem_statement="S", steps=[_step(1), _step(hints=hints)]).stored() is None

    async def test_one_bad_problem_does_not_fail_the_set(self):
        good = InteractiveExample(title="Good", problem_statement="S", steps=[_step()])
        bad = InteractiveExample(title="Bad", problem_statement="S", steps=[_step(hints=["only one"])])
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=InteractiveExampleSet(examples=[bad, good]))
        with stub_topic_context(CHUNKS), patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            result = await ExamplesGenerator().generate_examples("t1", "Stats", "d", ExampleType.INTERACTIVE, count=2)
        assert [e["title"] for e in result["examples"]] == ["Good"]

    def test_old_single_hint_rows_still_parse(self):
        old = {
            "step_number": 1, "question": "q", "hint": "Think about growth.", "answer_type": "text",
            "correct_answer": "x", "explanation": "e", "feedback_correct": "y", "feedback_incorrect": "n",
        }
        step = InteractiveStep.model_validate(old)
        assert step.hints == [] and step.hint == "Think about growth."
        assert step_hints(old) == ["", "Think about growth.", ""]
        assert step_hints({"step_number": 1}) == ["", "", ""]

    def test_the_mock_example_has_three_hints(self):
        stored = InteractiveExampleSet.example().examples[0].stored()
        assert len(stored["steps"][0]["hints"]) == 3


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

    async def test_too_many_bare_questions_fail_the_set(self):
        bare = [_mcq(f"Bare {i}", wrong={"B": {"misconception": None}}) for i in range(3)]
        with pytest.raises(LLMOutputError, match="0 usable questions of 3"):
            await _quiz(bare, count=3)

    async def test_the_misconception_survives_the_shuffle(self):
        stored = QuestionSet(questions=[_mcq()]).usable()[0]
        by_text = {o["text"]: o for o in stored["options"]}
        assert by_text["Option C"]["misconception"] == "wrong idea C"
        assert "misconception" not in by_text["Option A"]

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

    async def test_distractor_may_name_a_confusable_concept_of_another_topic(self):
        result, llm = await _quiz(
            [
                _mcq("Other topic", ids=["k-mean"], wrong={"B": {"confusable_concept_id": "k-median"}}),
                _mcq("Not offered", ids=["k-mean"], wrong={"B": {"confusable_concept_id": "k-mode"}}),
                _mcq("Twin as the tag", ids=["k-median"]),
            ],
            neighbours=NEIGHBOURS,
        )
        named, unlisted, tagged = ({o["text"]: o for o in q["options"]} for q in result["questions"])
        assert named["Option B"]["confusable_concept_id"] == "k-median"
        assert "confusable_concept_id" not in unlisted["Option B"]
        # The neighbour is a distractor target only: it is never a tag, so the item falls back to a topic concept.
        assert result["questions"][2]["concept_ids"] == ["k-mean"]
        text = llm.generate_structured.call_args.args[0][-1].content
        assert '<confusable_concepts>\n<concept id="k-median">Median: The middle value.</concept>' in text
        assert "Do not list them in `concept_ids`" in text

    async def test_no_neighbours_no_confusable_block(self):
        _, llm = await _quiz([_mcq()])
        assert "<confusable_concepts>\n" not in llm.generate_structured.call_args.args[0][-1].content

    async def test_the_prompt_asks_for_the_misconception_and_the_mode(self):
        _, llm = await _quiz([_mcq()])
        text = llm.generate_structured.call_args.args[0][-1].content
        assert (
            "Each wrong option is the answer a student would give if they held one specific wrong idea; "
            "write that idea in `misconception`."
        ) in text
        assert "`mode`" in text


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

    async def test_a_non_choice_question_cannot_stay_discrimination(self):
        question = GeneratedQuestion(
            question_type="short_answer", question_text="Contrast them", sample_answer="s", key_points=["k"],
            explanation="e", mode="discrimination",
        )
        result, _ = await _quiz([question])
        assert result["questions"][0]["mode"] == "recall"

    def test_a_mode_outside_the_three_is_refused(self):
        with pytest.raises(ValueError):
            GeneratedQuestion(question_type="true_false", question_text="q", explanation="e", mode="guess")


class TestResolveDirectly:
    def test_prerequisite_review_questions_get_no_fallback_concept(self):
        items = [{"concept_ids": [], "source_excerpts": [1], "prerequisite_topic": "Earlier"}]
        resolve_concept_ids(items, CONCEPTS, CHUNKS)
        assert items[0]["concept_ids"] == []

    def test_no_concepts_no_block(self):
        assert format_concept_block([]) == ""


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

    def test_the_output_schema_leaves_out_the_legacy_hint(self):
        schema = InteractiveStep.model_json_schema()
        assert "hint" not in schema["properties"] and "hint" not in schema.get("required", [])
        assert "hints" in schema["properties"]
        assert InteractiveStep.model_validate({
            "step_number": 1, "question": "q", "hint": "old", "answer_type": "text", "correct_answer": "x",
            "explanation": "e", "feedback_correct": "y", "feedback_incorrect": "n",
        }).hint == "old"

"""Schemas added with course structure: practice steps with options, excerpt indexes, the plan."""
import random

import pytest

from app.services.llm.schemas import (
    ChoiceOption,
    CoursePlan,
    GeneratedQuestion,
    InteractiveExample,
    InteractiveExampleSet,
    InteractiveStep,
    MaterialCheck,
    SolutionStep,
    SolvedExample,
    UnitOrder,
    split_option_lines,
)


def _step(**overrides):
    fields = dict(
        step_number=1,
        question="Which is faster for large n?",
        hints=["Look at the growth rates.", "Think about growth.", "Compare the leading terms."],
        answer_type="multiple_choice",
        options=[ChoiceOption(id=x, text=f"choice {x}") for x in "ABC"],
        correct_answer="B",
        explanation="The second choice grows slowest.",
        feedback_correct="Yes.",
        feedback_incorrect="No.",
    )
    fields.update(overrides)
    return InteractiveStep(**fields)


def _problem(*steps):
    return InteractiveExample(title="P", problem_statement="Statement", steps=list(steps) or [_step()])


def _mcq(**overrides):
    fields = dict(
        question_type="multiple_choice",
        question_text="Q",
        options=[ChoiceOption(id=x, text=f"text {x}", misconception="wrong idea") for x in "ABCD"],
        correct_answer="C",
        explanation="E",
    )
    fields.update(overrides)
    return GeneratedQuestion(**fields)


class TestPracticeMultipleChoice:
    def test_a_multiple_choice_step_keeps_its_options_and_the_key_follows_the_shuffle(self):
        stored = _step().normalized()
        assert sorted(o["id"] for o in stored["options"]) == ["A", "B", "C"]
        by_id = {o["id"]: o["text"] for o in stored["options"]}
        assert by_id[stored["correct_answer"]] == "choice B"

    def test_options_are_shuffled_and_letters_in_the_explanation_follow(self):
        step = _step(
            explanation="Option B is right and (C) is not; A is wrong.",
            feedback_incorrect="Not A. Look at Option B again.",
        )
        seen = set()
        for seed in range(30):
            random.seed(seed)
            stored = step.normalized()
            by_id = {o["id"]: o["text"] for o in stored["options"]}
            key = stored["correct_answer"]
            assert by_id[key] == "choice B"
            assert f"Option {key} is right" in stored["explanation"]
            assert f"Look at Option {key} again" in stored["feedback_incorrect"]
            seen.add(key)
        assert len(seen) > 1  # the key does not always stay in the slot the model chose

    @pytest.mark.parametrize("key", ["B", "b", " (B) ", "B) choice B", "choice B"])
    def test_the_key_may_name_the_option_by_letter_or_text(self, key):
        stored = _step(correct_answer=key).normalized()
        assert {o["id"]: o["text"] for o in stored["options"]}[stored["correct_answer"]] == "choice B"

    def test_a_key_that_names_no_option_makes_the_step_unusable(self):
        assert _step(correct_answer="E").normalized() is None

    def test_a_multiple_choice_step_with_no_options_and_none_in_the_question_is_rejected(self):
        assert _step(options=[]).normalized() is None

    def test_one_option_is_not_enough_and_six_are_too_many(self):
        assert _step(options=[ChoiceOption(id="A", text="only")], correct_answer="A").normalized() is None
        six = [ChoiceOption(id=x, text=f"t{x}") for x in "ABCDEF"]
        assert _step(options=six, correct_answer="A").normalized() is None
        assert len(_step(options=six[:5], correct_answer="A").normalized()["options"]) == 5

    def test_duplicate_ids_or_texts_are_rejected(self):
        same_id = [ChoiceOption(id="A", text="x"), ChoiceOption(id="A", text="y")]
        same_text = [ChoiceOption(id="A", text="x"), ChoiceOption(id="B", text="X")]
        assert _step(options=same_id, correct_answer="A").normalized() is None
        assert _step(options=same_text, correct_answer="A").normalized() is None

    def test_options_written_into_the_question_are_moved_into_options(self):
        stored = _step(
            question="Which is faster?\nA) O(n)\nB) O(n log n)\nC) O(n^2)", options=[], correct_answer="A"
        ).normalized()
        assert stored["question"] == "Which is faster?"
        assert {o["text"] for o in stored["options"]} == {"O(n)", "O(n log n)", "O(n^2)"}
        assert {o["id"]: o["text"] for o in stored["options"]}[stored["correct_answer"]] == "O(n)"

    def test_split_option_lines(self):
        assert split_option_lines("Pick one\n(A) first\n(B) second") == (
            "Pick one", [{"id": "A", "text": "first"}, {"id": "B", "text": "second"}]
        )
        assert split_option_lines("What is 2 + 2?") == ("What is 2 + 2?", [])
        assert split_option_lines("Only\nA) one") == ("Only\nA) one", [])

    def test_a_problem_with_one_unusable_step_is_dropped_whole(self):
        good = _step(step_number=1, answer_type="numeric", options=[], correct_answer="4")
        bad = _step(step_number=2, options=[])
        assert _problem(good, bad).stored() is None
        assert _problem(good).stored() is not None

    def test_only_problems_that_can_be_stored_are_kept(self):
        examples = [_problem(), _problem(_step(options=[]))]
        kept = [stored for e in examples if (stored := e.stored()) is not None]
        assert len(kept) == 1 and kept[0]["steps"][0]["options"]


class TestPracticeNumericAndText:
    def test_a_numeric_step_keeps_its_tolerance(self):
        stored = _step(answer_type="numeric", options=[], correct_answer="0.0588", tolerance=-0.005).normalized()
        assert stored["tolerance"] == 0.005 and "options" not in stored

    def test_a_missing_or_nan_tolerance_is_left_out(self):
        assert "tolerance" not in _step(answer_type="numeric", options=[], correct_answer="4").normalized()
        nan = _step(answer_type="numeric", options=[], correct_answer="4", tolerance=float("nan"))
        assert "tolerance" not in nan.normalized()

    def test_a_text_step_has_no_options_or_tolerance(self):
        stored = _step(answer_type="text", options=[], correct_answer="independent", tolerance=0.5).normalized()
        assert "options" not in stored and "tolerance" not in stored

    def test_empty_questions_and_answers_are_unusable(self):
        assert _step(answer_type="text", options=[], question="  ").normalized() is None
        assert _step(answer_type="text", options=[], correct_answer=" ").normalized() is None

    def test_the_schema_asks_for_options_and_a_tolerance(self):
        fields = InteractiveStep.model_fields
        assert "2 to 5 options" in fields["options"].description
        assert "absolute difference" in fields["tolerance"].description
        assert "canonical" in fields["answer_type"].description
        assert "never a comma-separated list" in fields["acceptable_answers"].description

    def test_the_mock_example_stores_cleanly(self):
        stored = InteractiveExampleSet.example().examples[0].stored()
        assert stored["steps"][0]["correct_answer"] == "4" and stored["source_excerpts"] == [1]


class TestSourceExcerpts:
    def test_questions_keep_clean_excerpt_indexes(self):
        stored = _mcq(source_excerpts=[2, 2, 0, -1, 3]).normalized()
        assert stored["source_excerpts"] == [2, 3]
        assert "source_excerpts" not in _mcq().normalized()

    def test_examples_and_problems_keep_them_too(self):
        solved = SolvedExample(
            title="t", problem_statement="p", final_answer="a", source_excerpts=[1, 4, 1],
            solution_steps=[SolutionStep(step_number=1, description="d", work="w", explanation="e")],
        )
        assert solved.stored()["source_excerpts"] == [1, 4]
        assert _problem(_step(answer_type="text", options=[], correct_answer="x")).stored()["source_excerpts"] == []
        assert SolvedExample(title="t", problem_statement="p", final_answer="a", solution_steps=[]).stored() is None


class TestPlannerSchemas:
    def test_the_material_check_has_a_kind(self):
        assert MaterialCheck(is_valid=True, notes="n").kind == "content"
        assert MaterialCheck(is_valid=True, notes="n", kind="exam").kind == "exam"
        with pytest.raises(Exception):
            MaterialCheck(is_valid=True, notes="n", kind="homework")

    def test_the_mock_plan_places_the_sections_in_the_prompt(self):
        prompt = (
            'intro\nS1 | a.pdf | p. 1, 300 tokens | H | "x"\nS2 | a.pdf | p. 2, 300 tokens | H | "y"\n'
            'S3 | b.pdf | p. 1, 90 tokens | H | "z"'
        )
        plan = CoursePlan.example_for(prompt)
        ids = [sid for u in plan.units for t in u.topics for sid in t.section_ids]
        assert sorted(ids) == ["S1", "S2", "S3"]
        assert [u.title for u in plan.units] == ["a (mock)", "b (mock)"]
        assert all(t.name.endswith("(mock)") for u in plan.units for t in u.topics)

    def test_a_lone_small_file_still_gets_two_topics(self):
        plan = CoursePlan.example_for('S1 | a.pdf | p. 1, 9 tokens | H | ""\nS2 | a.pdf | p. 2, 9 tokens | H | ""')
        assert len([t for u in plan.units for t in u.topics]) == 2

    def test_a_prompt_without_sections_gets_the_fixed_example(self):
        assert CoursePlan.example_for("nothing here").units[0].topics[0].name == "Core Concepts (mock)"

    def test_unit_order_example(self):
        assert UnitOrder.example_for("1. a\n2. b\n3. c").order == [1, 2, 3]

    def test_the_schemas_are_accepted_by_the_structured_output_transform(self):
        import anthropic

        for schema in (CoursePlan, UnitOrder, MaterialCheck, InteractiveExampleSet):
            assert anthropic.transform_schema(schema)

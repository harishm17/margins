"""Schemas added with course structure: practice steps with options, excerpt indexes, the plan."""


from app.services.llm.schemas import (
    ChoiceOption,
    CoursePlan,
    GeneratedQuestion,
    InteractiveExample,
    InteractiveExampleSet,
    InteractiveStep,
    MaterialCheck,
    UnitOrder,
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
    def test_options_are_shuffled_and_letters_in_the_explanation_follow(self):
        seen = set()
        for n in range(30):
            stored = _step(
                question=f"Which is faster for large n? ({n})",
                explanation="Option B is right and (C) is not; A is wrong.",
                feedback_incorrect="Not A. Look at Option B again.",
            ).normalized()
            by_id = {o["id"]: o["text"] for o in stored["options"]}
            key = stored["correct_answer"]
            assert by_id[key] == "choice B"
            assert f"Option {key} is right" in stored["explanation"]
            assert f"Look at Option {key} again" in stored["feedback_incorrect"]
            seen.add(key)
        assert len(seen) > 1  # the key does not always stay in the slot the model chose

    def test_a_key_that_names_no_option_makes_the_step_unusable(self):
        assert _step(correct_answer="E").normalized() is None

    def test_a_problem_with_one_unusable_step_is_dropped_whole(self):
        good = _step(step_number=1, answer_type="numeric", options=[], correct_answer="4")
        bad = _step(step_number=2, options=[])
        assert _problem(good, bad).stored() is None
        assert _problem(good).stored() is not None

class TestSourceExcerpts:
    def test_questions_keep_clean_excerpt_indexes(self):
        stored = _mcq(source_excerpts=[2, 2, 0, -1, 3]).normalized()
        assert stored["source_excerpts"] == [2, 3]
        assert "source_excerpts" not in _mcq().normalized()

class TestPlannerSchemas:
    def test_the_schemas_are_accepted_by_the_structured_output_transform(self):
        import anthropic

        for schema in (CoursePlan, UnitOrder, MaterialCheck, InteractiveExampleSet):
            assert anthropic.transform_schema(schema)

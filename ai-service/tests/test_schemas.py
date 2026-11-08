"""Tests for output schemas: per-question validation and option shuffling."""
import random

import pytest

from app.services.llm.schemas import (
    ChoiceOption,
    GeneratedQuestion,
    QuestionSet,
    rewrite_option_letters,
    strip_exam_header,
    shuffle_choice_options,
)


def _mcq(**overrides):
    fields = dict(
        question_type="multiple_choice",
        question_text="Q",
        options=[ChoiceOption(id=x, text=f"text {x}", misconception="wrong idea") for x in "ABCD"],
        correct_answer="C",
        explanation="E",
        points=2,
    )
    fields.update(overrides)
    return GeneratedQuestion(**fields)


class TestNormalization:
    def test_valid_mcq(self):
        stored = _mcq(correct_answer=" c ").normalized()
        assert stored["correct_answer"] == "C"
        assert stored["options"][2] == {"id": "C", "text": "text C"}

    @pytest.mark.parametrize(
        "overrides",
        [
            {"correct_answer": "E"},
            {"correct_answer": None},
            {"options": [ChoiceOption(id="A", text="a"), ChoiceOption(id="B", text="b")]},
            {"options": [ChoiceOption(id="A", text="same"), ChoiceOption(id="B", text="Same"), ChoiceOption(id="C", text="c")]},
            {"question_text": "  "},
            {"explanation": ""},
        ],
    )
    def test_invalid_mcq_is_dropped(self, overrides):
        assert _mcq(**overrides).normalized() is None

    @pytest.mark.parametrize("value,expected", [(True, True), ("false", False), ("True", True), ("yes", None), (1, None)])
    def test_true_false_answers(self, value, expected):
        question = GeneratedQuestion(question_type="true_false", question_text="Q", correct_answer=value, explanation="E")
        stored = question.normalized()
        assert (stored["correct_answer"] if stored else None) == expected

    @pytest.mark.parametrize("value,expected", [(42, 42.0), ("1,250.5", 1250.5), ("abc", None), (True, None), (float("inf"), None)])
    def test_numerical_answers(self, value, expected):
        question = GeneratedQuestion(
            question_type="numerical", question_text="Q", correct_answer=value, tolerance=-0.5, unit="m", explanation="E"
        )
        stored = question.normalized()
        assert (stored["correct_answer"] if stored else None) == expected
        if stored:
            assert stored["tolerance"] == 0.5 and stored["unit"] == "m"

    def test_short_answer_needs_sample_and_key_points(self):
        base = dict(question_type="short_answer", question_text="Q", explanation="E")
        assert GeneratedQuestion(**base, sample_answer="S", key_points=["k"]).normalized()["key_points"] == ["k"]
        assert GeneratedQuestion(**base, sample_answer="S", key_points=[" "]).normalized() is None
        assert GeneratedQuestion(**base, key_points=["k"]).normalized() is None

    def test_points_are_clamped(self):
        assert _mcq(points=50).normalized()["points"] == 5
        assert _mcq(points=0).normalized()["points"] == 1


class TestShuffle:
    def test_correct_text_survives_shuffle(self):
        for seed in range(20):
            question = _mcq().normalized()
            shuffled = shuffle_choice_options(question, random.Random(seed))
            by_id = {o["id"]: o["text"] for o in shuffled["options"]}
            assert by_id[shuffled["correct_answer"]] == "text C"
            assert [o["id"] for o in shuffled["options"]] == ["A", "B", "C", "D"]

    def test_answer_position_is_spread(self):
        positions = {
            shuffle_choice_options(_mcq().normalized(), random.Random(seed))["correct_answer"]
            for seed in range(40)
        }
        assert positions == {"A", "B", "C", "D"}

    def test_the_same_question_is_always_shuffled_the_same_way(self):
        orders = {
            tuple(o["text"] for o in shuffle_choice_options(_mcq(question_text="Which is a heap?").normalized())["options"])
            for _ in range(10)
        }
        assert len(orders) == 1

    def test_without_a_generator_the_answer_position_is_still_spread(self):
        positions = {
            shuffle_choice_options(_mcq(question_text=f"Question {n}").normalized())["correct_answer"]
            for n in range(40)
        }
        assert positions == {"A", "B", "C", "D"}

    def test_other_types_unchanged(self):
        question = {"question_type": "true_false", "correct_answer": True}
        assert shuffle_choice_options(dict(question)) == question

    def test_question_set_usable_filters(self):
        questions = QuestionSet(questions=[_mcq(), _mcq(correct_answer="Z")]).usable()
        assert len(questions) == 1


class TestOptionLetterReferences:
    def _question(self, explanation, **extra):
        stored = _mcq(correct_answer="D", explanation=explanation).normalized()
        stored.update(extra)
        return stored

    def test_explanation_letters_follow_the_shuffle(self):
        explanation = "Option C describes disjoint events, and D is the addition rule."
        for seed in range(30):
            shuffled = shuffle_choice_options(self._question(explanation), random.Random(seed))
            letter_of = {o["text"]: o["id"] for o in shuffled["options"]}
            expected = (
                f"Option {letter_of['text C']} describes disjoint events, "
                f"and {letter_of['text D']} is the addition rule."
            )
            assert shuffled["explanation"] == expected
            assert shuffled["correct_answer"] == letter_of["text D"]

    def test_the_audit_case(self):
        # Whatever the shuffle does, the key and the explanation must agree.
        question = self._question("Option C describes disjoint events, and D is the addition rule.")
        shuffled = shuffle_choice_options(question, random.Random(0))
        by_id = {o["id"]: o["text"] for o in shuffled["options"]}
        key = shuffled["correct_answer"]
        assert by_id[key] == "text D"
        assert f"and {key} is the addition rule" in shuffled["explanation"]

    def test_swaps_do_not_collide(self):
        mapping = {"A": "C", "B": "B", "C": "A", "D": "D"}
        assert rewrite_option_letters("Option A is wrong; C is right.", mapping) == "Option C is wrong; A is right."
        assert rewrite_option_letters("Options A and C are close.", mapping) == "Options C and A are close."

    @pytest.mark.parametrize(
        "text, expected",
        [
            ("Option A is correct.", "Option D is correct."),
            ("option A is correct.", "option D is correct."),
            ("Choice A fits.", "Choice D fits."),
            ("(A) is the key.", "(D) is the key."),
            ("A) the key\nB) a distractor", "D) the key\nC) a distractor"),
            ("A describes it, B gives the wrong sign.", "D describes it, C gives the wrong sign."),
            ("Options A, B and C are wrong.", "Options D, C and B are wrong."),
        ],
    )
    def test_reference_forms(self, text, expected):
        assert rewrite_option_letters(text, {"A": "D", "B": "C", "C": "B", "D": "A"}) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "Events $A$ and $B$ are independent, so $P(A)=0.4$.",
            "P(A) is 0.4 and P(B) is 0.5.",
            "A fair coin is tossed. A random sample is drawn.",
            "Use `A is B` in the code.",
            "The answer is 42.",
        ],
    )
    def test_math_and_prose_are_left_alone(self, text):
        assert rewrite_option_letters(text, {"A": "D", "B": "C", "C": "B", "D": "A"}) == text

    def test_per_option_feedback_is_rewritten_too(self):
        question = self._question("E", options=[{"id": x, "text": f"text {x}", "feedback": "Option B is wrong, see option C."} for x in "ABCD"])
        shuffled = shuffle_choice_options(question, random.Random(3))
        letter_of = {o["text"]: o["id"] for o in shuffled["options"]}
        for option in shuffled["options"]:
            assert option["feedback"] == f"Option {letter_of['text B']} is wrong, see option {letter_of['text C']}."

    def test_other_question_types_keep_their_explanation(self):
        question = {"question_type": "true_false", "correct_answer": True, "explanation": "Option C is wrong."}
        assert shuffle_choice_options(dict(question)) == question


# ---------------------------------------------------------------- practice hints must not give answers away


def _practice_problem(hints_step1, hints_step2=("Look at the sentence.", "Think of the product rule.", "P = a x b")):
    from app.services.llm.schemas import InteractiveExample, InteractiveStep

    def make(n, question, answer, hints, accepted=()):
        return InteractiveStep(
            step_number=n, question=question, hints=list(hints), answer_type="numeric", correct_answer=answer,
            acceptable_answers=list(accepted), tolerance=0.001, explanation="e", feedback_correct="c", feedback_incorrect="i",
        )

    return InteractiveExample(
        title="Marbles",
        problem_statement="A bag holds 3 red and 5 blue marbles. Two are drawn without replacement.",
        steps=[make(1, "How many marbles are in the bag?", "8", hints_step1, ["eight"]), make(2, "What is P(both red)?", "3/28", hints_step2, ["0.1071"])],
    )


def test_a_problem_whose_hint_states_a_later_answer_is_dropped():
    clean = _practice_problem(["Re-read the first sentence.", "Add the colours.", "total = red + blue"])
    assert clean.stored() is not None
    assert _practice_problem(["Re-read.", "Add the colours.", "total = red + blue"], ["Look.", "The answer is 3/28.", "x"]).stored() is None
    # a hint of step 1 naming step 2's answer in another form (a decimal within tolerance)
    assert _practice_problem(["Re-read.", "It will come out near 0.1071.", "x"]).stored() is None
    # its own step's answer, as a word
    assert _practice_problem(["Re-read.", "There are eight in all.", "x"]).stored() is None


def test_a_hint_may_name_an_earlier_step_answer_and_the_problems_own_numbers():
    ok = _practice_problem(["Re-read.", "Add the colours.", "total = red + blue"], ["You found 8 marbles.", "With 3 red marbles, think of the first draw.", "P = a x b"])
    assert ok.stored() is not None


def test_the_generator_keeps_the_problems_whose_hints_are_clean():
    from app.services.llm.schemas import InteractiveExampleSet

    bad = _practice_problem(["Re-read.", "Answer: eight", "x"])
    good = _practice_problem(["Re-read.", "Add the colours.", "total = red + blue"])
    kept = [s for e in InteractiveExampleSet(examples=[bad, good]).examples if (s := e.stored()) is not None]
    assert len(kept) == 1


class TestPastExamHeader:
    """A past exam's "Problem 3. [5 points]" header must not reach a question: the app numbers and scores them."""

    @pytest.mark.parametrize(
        "text, expected",
        [
            ("**Problem 3. [5 points] Upside-Down Build**\n\nProfessor Quill wants", "**Upside-Down Build**\n\nProfessor Quill wants"),
            ("Problem 4. [4 points] The Coatroom\n\nThe Grand Hotel", "The Coatroom\n\nThe Grand Hotel"),
            ("**Problem 1. [3 points]** Gardener Odalys keeps", "Gardener Odalys keeps"),
            ("Question 2 (3 pts): Which is faster?", "Which is faster?"),
            ("What is Problem 3 about?", "What is Problem 3 about?"),
            ("Consider the cost [5 points] of a scan", "Consider the cost [5 points] of a scan"),
        ],
    )
    def test_strip(self, text, expected):
        assert strip_exam_header(text) == expected

    def test_normalized_question_has_no_header(self):
        stored = _mcq(question_text="Problem 2. [3 points] Which holds?").normalized()
        assert stored["question_text"] == "Which holds?"

"""Tests for output schemas: per-question validation and option shuffling."""
import random

import pytest

from app.services.llm.schemas import (
    ChoiceOption,
    GeneratedQuestion,
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
            {"options": [ChoiceOption(id="A", text="a"), ChoiceOption(id="B", text="b")]},
            {"options": [ChoiceOption(id="A", text="same"), ChoiceOption(id="B", text="Same"), ChoiceOption(id="C", text="c")]},
        ],
    )
    def test_invalid_mcq_is_dropped(self, overrides):
        assert _mcq(**overrides).normalized() is None

    @pytest.mark.parametrize("value,expected", [("false", False), ("yes", None)])
    def test_true_false_answers(self, value, expected):
        question = GeneratedQuestion(question_type="true_false", question_text="Q", correct_answer=value, explanation="E")
        stored = question.normalized()
        assert (stored["correct_answer"] if stored else None) == expected

    def test_short_answer_needs_sample_and_key_points(self):
        base = dict(question_type="short_answer", question_text="Q", explanation="E")
        assert GeneratedQuestion(**base, sample_answer="S", key_points=["k"]).normalized()["key_points"] == ["k"]
        assert GeneratedQuestion(**base, sample_answer="S", key_points=[" "]).normalized() is None
        assert GeneratedQuestion(**base, key_points=["k"]).normalized() is None

class TestShuffle:
    def test_correct_text_survives_shuffle(self):
        for seed in range(20):
            question = _mcq().normalized()
            shuffled = shuffle_choice_options(question, random.Random(seed))
            by_id = {o["id"]: o["text"] for o in shuffled["options"]}
            assert by_id[shuffled["correct_answer"]] == "text C"
            assert [o["id"] for o in shuffled["options"]] == ["A", "B", "C", "D"]

    @pytest.mark.parametrize("seeded", [False], ids=["default_generator"])
    def test_answer_position_is_spread(self, seeded):
        if seeded:
            shuffled = (shuffle_choice_options(_mcq().normalized(), random.Random(seed)) for seed in range(40))
        else:
            shuffled = (shuffle_choice_options(_mcq(question_text=f"Question {n}").normalized()) for n in range(40))
        assert {question["correct_answer"] for question in shuffled} == {"A", "B", "C", "D"}

    def test_the_same_question_is_always_shuffled_the_same_way(self):
        orders = {
            tuple(o["text"] for o in shuffle_choice_options(_mcq(question_text="Which is a heap?").normalized())["options"])
            for _ in range(10)
        }
        assert len(orders) == 1

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

    @pytest.mark.parametrize(
        "text, expected",
        [
            ("Option A is correct.", "Option D is correct."),
            ("A) the key\nB) a distractor", "D) the key\nC) a distractor"),
        ],
    )
    def test_reference_forms(self, text, expected):
        assert rewrite_option_letters(text, {"A": "D", "B": "C", "C": "B", "D": "A"}) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "Events $A$ and $B$ are independent, so $P(A)=0.4$.",
        ],
    )
    def test_math_and_prose_are_left_alone(self, text):
        assert rewrite_option_letters(text, {"A": "D", "B": "C", "C": "B", "D": "A"}) == text

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


class TestPastExamHeader:
    """A past exam's "Problem 3. [5 points]" header must not reach a question: the app numbers and scores them."""

    @pytest.mark.parametrize(
        "text, expected",
        [
            ("**Problem 3. [5 points] Upside-Down Build**\n\nProfessor Quill wants", "**Upside-Down Build**\n\nProfessor Quill wants"),
            ("Question 2 (3 pts): Which is faster?", "Which is faster?"),
            ("What is Problem 3 about?", "What is Problem 3 about?"),
        ],
    )
    def test_strip(self, text, expected):
        assert strip_exam_header(text) == expected

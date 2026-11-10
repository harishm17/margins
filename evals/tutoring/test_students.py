"""Tests for the scripted students, the scenario builder and the committed practice scenarios.
No database, no model, no network."""
import json
import os
import random
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_scenarios  # noqa: E402
import students  # noqa: E402
from answer_check import number_candidates  # noqa: E402
from app_state import Conversation, _within  # noqa: E402

ORIGINAL_FILE = HERE / "scenarios" / "practice-original.jsonl"
PROBLEMS_FILE = HERE / "problems" / "original.json"


def raw_problem(n=0):
    """A generated practice problem as the generation eval stores it: numeric steps, one `hint`."""
    return {
        "title": f"Marbles {n}",
        "problem_statement": f"A bag holds {3 + n} red and 5 blue marbles. Two are drawn without replacement.",
        "steps": [
            {"step_number": 1, "question": "How many marbles are in the bag?", "hint": "Add the colours.", "answer_type": "numeric", "correct_answer": str(8 + n), "acceptable_answers": [str(8 + n)]},
            {"step_number": 2, "question": "What is the chance the first marble is red?", "hint": "Divide red by all.", "answer_type": "numeric", "correct_answer": f"{3 + n}/{8 + n}", "acceptable_answers": []},
            {"step_number": 3, "question": "What is the chance both are red?", "hint": "Multiply the chances.", "answer_type": "numeric", "correct_answer": "0.1071", "acceptable_answers": ["3/28"], "tolerance": 0.001},
            {"step_number": 4, "question": "Which rule did you use?\nA) Bayes\nB) Product", "hint": "Think about both draws.", "answer_type": "multiple_choice", "correct_answer": "B", "acceptable_answers": ["B"], "options": [{"id": "A", "text": "Bayes"}, {"id": "B", "text": "Product"}]},
        ],
    }


# ---------------------------------------------------------------- problem handling


# ---------------------------------------------------------------- patterns


@pytest.mark.parametrize("pattern", students.PATTERNS)
def test_every_pattern_builds_and_plays_through_the_app_mirror(pattern):
    scenario = students.make_scenario(f"s-{pattern}", pattern, raw_problem(), {"run": "r"}, random.Random(0), serial=3)
    assert scenario is not None and scenario["pattern"] == pattern
    conversation = Conversation(scenario)
    decisions = []
    for turn in scenario["turns"]:
        decision = conversation.step(turn)
        if decision.calls_model:
            conversation.commit(decision)
        decisions.append(decision)
    asked = [d for d in decisions if d.calls_model]
    assert asked, "a pattern must reach the tutor at least once"
    assert all(d.rung_allowed <= 5 for d in asked)
    if pattern == "just_tell_me":
        assert decisions[0].blocked == "not_allowed"  # asking before any check is refused
        assert asked[-1].move == "worked_analogue"
    if pattern == "idk3":
        assert any(d.request["ask_what_is_unclear"] for d in asked)
        assert asked[-1].move == "clarify"
    if pattern == "wrong_wrong_right":
        assert [d.move for d in asked][-1] == "confirm" or asked[-1].request["final_allowed"]
        assert asked[0].first_wrong_step is not None
    if pattern == "confident_wrong":
        assert [d.move for d in asked][:2] == ["confront", "confront"]
    if pattern == "right_weak_reasoning":
        assert asked[0].request["final_allowed"] is True
    if pattern == "injection":
        assert scenario["canary"] and any(scenario["canary"] in json.dumps(t) for t in scenario["turns"])


def test_a_check_marked_correct_is_the_authored_answer_and_a_wrong_one_is_not():
    for pattern in students.PATTERNS:
        scenario = students.make_scenario("s", pattern, raw_problem(), {}, random.Random(0), serial=2)
        target = scenario["steps"][scenario["step_index"]]
        keys = [v for a in [target["answer"], *target["acceptable_answers"]] for v in (number_candidates(a) or [])]
        for turn in scenario["turns"]:
            if turn["event"] != "check" or not turn["answer"][0].isdigit():
                continue
            value = number_candidates(turn["answer"])
            if value is None:
                continue
            matches = any(_within(value[-1], key, target.get("tolerance")) for key in keys)
            assert matches == turn["correct"], (pattern, turn)


# ---------------------------------------------------------------- the builder


# ---------------------------------------------------------------- the committed original scenarios


@pytest.fixture(scope="module")
def committed():
    return [json.loads(line) for line in ORIGINAL_FILE.read_text().splitlines() if line.strip()]


def test_the_committed_scenarios_are_what_the_builder_makes(committed):
    assert build_scenarios.build_original() == committed  # rebuild with build_scenarios.py --original when problems change


def test_the_original_problems_hold_no_course_material():
    """The repo is public: the tutoring problems must be our own, never OCW text."""
    text = PROBLEMS_FILE.read_text().lower()
    assert not any(name in text for name in ("ocw", "opencourseware", "orloff", "demaine"))


def test_no_hint_of_the_original_problems_gives_an_answer_away():
    """The generator's own check (schemas.hint_leak) over the committed problems."""
    os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
    sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
    from app.services.llm.schemas import hint_leak

    for problem in json.loads(PROBLEMS_FILE.read_text()):
        steps = [{**s, "correct_answer": s["answer"]} for s in students.problem_steps(problem)]
        assert hint_leak(students.problem_text(problem), steps) is None, problem["title"]


def test_the_answer_checker_can_check_every_step_the_students_work_on(committed):
    for scenario in committed:
        assert students.unsupported(scenario["steps"]) is None, scenario["id"]
        assert students.numeric_run(scenario["steps"]) == scenario["step_index"]


def test_every_committed_scenario_plays_and_reaches_the_tutor(committed):
    for scenario in committed:
        conversation = Conversation(scenario)
        asked = 0
        for turn in scenario["turns"]:
            assert turn["event"] in {"check", "hint", "ask", "clarify", "show_worked", "dont_know"}
            assert "first_wrong_step" not in turn  # the app computes it from the working
            decision = conversation.step(turn)
            if turn["event"] == "check":
                assert decision.correct == turn["correct"], (scenario["id"], turn)
            if decision.calls_model:
                conversation.commit(decision)
                asked += 1
        assert asked >= 2, scenario["id"]
        assert 0 <= scenario["step_index"] < len(scenario["steps"])


def test_only_the_planned_refusal_is_refused(committed):
    for scenario in committed:
        conversation = Conversation(scenario)
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            assert bool(decision.blocked) == (turn.get("expect") == "refused"), (scenario["id"], turn)
            if decision.calls_model:
                conversation.commit(decision)


def test_the_injection_scenarios_plant_a_marker_in_the_student_text(committed):
    injected = [s for s in committed if s["pattern"] == "injection"]
    assert len(injected) == 2
    for scenario in injected:
        assert scenario["canary"].startswith("PWNED-")
        planted = json.dumps(scenario["turns"])
        assert scenario["canary"] in planted and "ignore" in planted.lower()
    assert all(s["canary"] is None for s in committed if s["pattern"] != "injection")


def test_the_scenarios_give_the_tutor_a_first_wrong_step(committed):
    found = 0
    for scenario in committed:
        conversation = Conversation(scenario)
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            if decision.calls_model:
                conversation.commit(decision)
                found += decision.first_wrong_step is not None
    assert found >= 8  # the mistake-location gate needs turns to measure


WORKED_FILE = HERE / "scenarios" / "practice-worked.jsonl"


def test_the_committed_worked_example_set_is_what_the_builder_makes():
    committed = [json.loads(line) for line in WORKED_FILE.read_text().splitlines() if line.strip()]
    assert build_scenarios.build_worked() == committed  # rebuild with build_scenarios.py --worked when problems change



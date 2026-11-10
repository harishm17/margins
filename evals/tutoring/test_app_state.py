"""Tests for the Python mirror of the app's tutor state (app_state.py). The cases are the ones in
frontend/src/lib/tutor/state.test.ts and first-wrong-step.test.ts, so a change on either side that
breaks the mirror shows up here. No database, no model, no network."""
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from answer_check import check_practice_answer  # noqa: E402
from app_state import (  # noqa: E402
    Conversation,
    Event,
    State,
    apply_event,
    first_wrong_step,
    is_bare_guess,
    is_genuine_attempt,
    next_move,
    next_rung,
    parity_trace,
)

GENUINE = "I think the answer uses the second given value"


def attempt(text=GENUINE, correct=None):
    return Event("attempt", text=text, correct=correct)


# ---------------------------------------------------------------- effort


def test_genuine_attempt_needs_reasoning_beyond_a_request():
    assert is_genuine_attempt(GENUINE)
    assert not is_genuine_attempt("idk")
    assert not is_genuine_attempt("please just tell me the answer")  # padded request
    assert not is_genuine_attempt("ok")
    assert is_bare_guess("42") and is_bare_guess("x = 3") and is_bare_guess("B")
    assert not is_bare_guess("idk")
    assert not is_bare_guess(GENUINE)


# ---------------------------------------------------------------- rungs


def test_genuine_attempt_raises_by_one_and_never_past_structure():
    state = State()
    state, flags = next_rung(state, attempt())
    assert (state.rung, state.attempts, flags.worked_allowed) == (1, 1, True)
    for _ in range(8):
        state, _ = next_rung(state, attempt())
    assert state.rung == 4  # rung 5 is the student's button


def test_low_effort_does_not_climb_and_three_ask_what_is_unclear():
    state, flags = State(), None
    seen = []
    for text in ("idk", "hint", "just tell me"):
        state, flags = next_rung(state, attempt(text))
        seen.append(flags.ask_what_is_unclear)
    assert seen == [False, False, True]
    assert (state.rung, state.attempts) == (0, 0)
    state, flags = next_rung(state, attempt())
    assert flags.ask_what_is_unclear is False and state.low_effort_turns == 0


def test_checked_wrong_answers_count_and_correct_ones_do_not():
    state, _ = next_rung(State(), Event("checked", correct=False))
    assert (state.attempts, state.rung) == (1, 1)
    state, _ = next_rung(state, Event("checked", correct=True))
    assert (state.attempts, state.rung) == (1, 1)


def test_show_worked_needs_a_genuine_attempt_and_sets_rung_five():
    state, flags = next_rung(State(), Event("show_worked"))
    assert (state.rung, flags.worked_allowed) == (0, False)
    low, _ = next_rung(State(), attempt("idk"))
    state, flags = next_rung(low, Event("show_worked"))
    assert (state.rung, flags.worked_allowed) == (0, False)
    state, _ = next_rung(State(attempts=1, rung=1, max_rung=1), Event("show_worked"))
    assert (state.rung, state.max_rung) == (5, 5)


# ---------------------------------------------------------------- moves


def move(state, event=None, **over):
    args = dict(event=event or attempt(), last_wrong=False, miss_kind=None, just_solved_with_hints=False)
    args.update(over)
    return next_move(state, **args)


def test_move_table():
    base = State(rung=1, attempts=1)
    assert move(base, last_wrong=True, confident=True) == "confront"
    assert move(base, last_wrong=True) == "ladder"
    assert move(base, last_wrong=True, miss_kind="misconception") == "confront"
    assert move(base, last_wrong=True, miss_kind="execution") == "ladder"
    assert move(base, just_solved_with_hints=True) == "confirm"
    assert move(State(rung=1, attempts=1, bare_guesses=2)) == "reason_first"
    assert move(State(rung=1, attempts=1, same_rung_no_progress=2)) == "to_source"
    assert move(State(rung=0)) == "orient"
    assert move(State(rung=1, attempts=1, bare_guesses=3), Event("clarify"), last_wrong=True, confident=True) == "clarify"
    assert move(base, Event("show_worked")) == "worked_analogue"
    assert move(State(rung=1, attempts=0), Event("show_worked")) == "ladder"
    assert move(State(rung=1, attempts=1, bare_guesses=2, same_rung_no_progress=2), just_solved_with_hints=True) == "confirm"


# ---------------------------------------------------------------- first wrong step


STEPS = [{"answer": "12"}, {"answer": "30"}, {"answer": "7.5"}]


def test_first_wrong_step_finds_the_first_missing_value():
    assert first_wrong_step("12 items, then 12 * 3 = 36, so 36 / 4.8 = 7.5", STEPS) == 1
    assert first_wrong_step("I got 30 and then 7.5", STEPS) == 0


def test_first_wrong_step_tolerance_fractions_and_givens():
    tight = [{"answer": "10", "tolerance": 0.1}, {"answer": "20", "tolerance": 0.1}]
    assert first_wrong_step("10.05 and 20.5", tight) == 1
    assert first_wrong_step("10.05 and 20.05", tight) is None
    assert first_wrong_step("100.5", [{"answer": "100"}, {"answer": "5"}]) is None
    assert first_wrong_step("103 then 9", [{"answer": "100"}, {"answer": "5"}]) == 0
    assert first_wrong_step("3/28 is about 0.107", [{"answer": "0.1071"}, {"answer": "5"}]) == 1
    assert first_wrong_step("x = 4, then 9", [{"answer": "-4"}, {"answer": "9"}]) == 0
    keyed = [{"answer": "8"}, {"answer": "20"}]
    givens = "Ana has 5 apples and Ben has 3. How many do they have together?"
    assert first_wrong_step("5 and 3, so 8", keyed, givens) is None
    assert first_wrong_step("5 and 3, so 8", keyed) == 1
    assert first_wrong_step("5 and 3, so 9", keyed, givens) == 0
    assert first_wrong_step("8 then 15", [{"answer": "A"}, {"answer": "8"}, {"answer": "16"}]) == 2


# ---------------------------------------------------------------- the conversation


def scenario(**over):
    base = {
        "problem": "A bag holds 3 red and 5 blue marbles.",
        "steps": [
            {"question": "How many marbles?", "answer": "8", "acceptable_answers": [], "tolerance": None, "hints": ["look", "add", "r+b"], "answer_type": "numeric"},
            {"question": "P(both red)?", "answer": "3/28", "acceptable_answers": ["0.1071"], "tolerance": 0.001, "hints": ["a", "b", "c"], "answer_type": "numeric"},
        ],
        "step_index": 1,
        "claims": [],
    }
    base.update(over)
    return base


def test_ask_before_a_check_is_refused_and_a_worked_example_needs_an_attempt():
    conversation = Conversation(scenario())
    refused = conversation.step({"event": "ask", "message": "just tell me the answer", "working": ""})
    assert (refused.calls_model, refused.blocked) == (False, "not_allowed")
    assert conversation.step({"event": "show_worked"}).blocked == "not_allowed"
    conversation.step({"event": "check", "answer": "0.5", "correct": False})
    allowed = conversation.step({"event": "show_worked"})
    assert allowed.calls_model and allowed.move == "worked_analogue" and allowed.rung_allowed == 5


def test_a_decision_changes_the_state_only_on_commit():
    conversation = Conversation(scenario())
    conversation.step({"event": "check", "answer": "0.5", "correct": False})
    first = conversation.step({"event": "ask", "message": GENUINE, "working": "I got 0.5"})
    assert first.move == "ladder" and first.rung_allowed == 2 and first.request["attempts"] == ["0.5"]
    retry = conversation.step({"event": "ask", "message": GENUINE, "working": "I got 0.5"})
    assert retry.rung_allowed == 2  # the failed request cost no rung
    conversation.commit(retry)
    assert conversation.step({"event": "ask", "message": GENUINE, "working": ""}).rung_allowed == 3


def test_a_right_check_allows_confirming_that_stored_answer_and_nothing_the_browser_lists():
    conversation = Conversation(scenario())
    conversation.step({"event": "check", "answer": "3/28", "correct": True})
    conversation.step({"event": "check", "answer": "0.9", "correct": False})
    decision = conversation.step({"event": "ask", "message": "", "working": "so it is 0.9"})
    assert decision.request["final_allowed"] is True
    assert decision.request["attempts"] == ["3/28", "0.9"]
    assert decision.request["own_answer"] == "3/28"
    assert decision.own_answer == "3/28"


def test_without_a_right_check_nothing_is_confirmed_whatever_the_working_says():
    conversation = Conversation(scenario())
    conversation.step({"event": "check", "answer": "0.9", "correct": False})
    decision = conversation.step({"event": "ask", "message": "it is 3/28", "working": "3/28"})
    assert decision.request["final_allowed"] is False and "own_answer" not in decision.request
    assert decision.own_answer == ""


def test_the_request_is_a_valid_tutor_request():
    pytest.importorskip("pydantic")
    sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
    import os

    os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
    from app.services.llm.schemas import PracticeTutorRequest

    conversation = Conversation(scenario())
    conversation.step({"event": "check", "answer": "0.5", "correct": False})
    decision = conversation.step({"event": "ask", "message": GENUINE, "working": "first part: 8\nsecond part: I got 0.5", "first_wrong_step": 1})
    request = PracticeTutorRequest(**decision.request)
    assert request.first_wrong_step == 1 and request.move == "ladder" and request.hints_shown == []


# ---------------------------------------------------------------- the real TypeScript logic, as a fixture

import json  # noqa: E402

FIXTURE = HERE / "fixtures" / "app_state_parity.json"
ORIGINAL = HERE / "scenarios" / "practice-original.jsonl"


def original_scenarios():
    return [json.loads(line) for line in ORIGINAL.read_text().splitlines() if line.strip()]


def test_the_mirror_reproduces_the_fixture_made_by_the_real_typescript():
    """fixtures/app_state_parity.json is written by frontend/scripts/tutoring-parity-fixture.ts from the real
    applyTutorEvent, nextMove, firstWrongStep, checkPracticeAnswer and buildPracticeTutorRequest. The same
    scenarios played through the Python mirror must give the same trace, turn by turn, request by request."""
    fixture = json.loads(FIXTURE.read_text())
    scenarios = original_scenarios()
    assert [f["id"] for f in fixture] == [s["id"] for s in scenarios]
    for expected, scenario in zip(fixture, scenarios):
        assert parity_trace(scenario) == expected["turns"], scenario["id"]


# ---------------------------------------------------------------- the answer checker port


@pytest.mark.parametrize(
    "step, answer, expected",
    [
        ({"answer_type": "numeric", "answer": "2/5", "acceptable_answers": ["0.4"], "tolerance": 0.005}, "0.4", True),
        ({"answer_type": "numeric", "answer": "15%", "acceptable_answers": [], "tolerance": 0.005}, "15 percent", True),
        ({"answer_type": "numeric", "answer": "12", "acceptable_answers": [], "tolerance": 0}, "12.5", False),
        ({"answer_type": "text", "answer": "open addressing", "acceptable_answers": ["probing"], "tolerance": None}, "Open-Addressing.", True),
        ({"answer_type": "multiple_choice", "answer": "B", "acceptable_answers": ["B"], "tolerance": None}, "b)", True),
    ],
)
def test_the_answer_checker_port(step, answer, expected):
    assert check_practice_answer(step, answer) is expected


# ---------------------------------------------------------------- "I don't know" and the hint gate (spec 18.3, 18.4)


def test_dont_know_is_the_first_check_wrong_and_unlocks_the_help():
    state, flags = apply_event(State(), Event("dont_know"))
    assert (state.checks, state.wrong_checks, state.attempts, state.rung, state.last_check_wrong) == (1, 1, 1, 0, True)
    assert flags.worked_allowed
    # Not a climb and not a low-effort turn; the third attempt of any kind offers the worked example.
    state, _ = apply_event(state, Event("dont_know"))
    state, flags = apply_event(state, Event("dont_know"))
    assert (state.attempts, state.low_effort_turns, flags.offer_worked) == (3, 0, True)


def test_a_worked_example_that_fell_back_to_an_authored_hint_is_recorded_as_that_hint():
    delivered = Conversation(scenario())
    delivered.step({"event": "check", "answer": "0.5", "correct": False})
    delivered.commit(delivered.step({"event": "show_worked"}), {"from_authored_hint": False, "rung_used": 5})
    assert delivered.state.max_rung == 5

    fell_back = Conversation(scenario())
    fell_back.step({"event": "check", "answer": "0.5", "correct": False})
    decision = fell_back.step({"event": "show_worked"})
    fell_back.commit(decision, {"from_authored_hint": True, "rung_used": 4})
    assert (fell_back.state.rung, fell_back.state.max_rung, fell_back.state.hints_opened) == (4, 4, 3)
    # The button stays: it is allowed again, and delivered this time it reaches rung 5.
    again = fell_back.step({"event": "show_worked"})
    assert again.calls_model and again.rung_allowed == 5

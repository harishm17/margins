"""The Python mirror of Ask's server side against the real TypeScript (fixtures/ask_state_parity.json)."""
import json
from pathlib import Path

import pytest

from app_state import State
from ask_state import (
    EXAM_GUARD_NOTE,
    EXAM_GUARD_REPLY,
    WORKED_EXAMPLE_REQUEST,
    Conversation,
    exam_guard,
    parity_trace,
    plan_ask_turn,
    reply_taught,
    tokens,
    tutor_event_for,
)

HERE = Path(__file__).resolve().parent
SCENARIOS = HERE / "scenarios" / "ask-original.jsonl"
FIXTURE = HERE / "fixtures" / "ask_state_parity.json"


def scenarios():
    return [json.loads(line) for line in SCENARIOS.read_text().splitlines() if line.strip()]


def test_the_mirror_reproduces_the_fixture_made_by_the_real_typescript():
    """The fixture is written by frontend/scripts/ask-parity-fixture.ts from the real examGuard, planAskTurn,
    tutorEventFor, rungUsed, replyTaught and applyTutorEvent. The same scenarios played through the Python
    mirror, with each turn's scripted route standing in for the router, give the same trace turn by turn."""
    fixture = json.loads(FIXTURE.read_text())
    items = scenarios()
    assert [f["id"] for f in fixture] == [s["id"] for s in items]
    for expected, scenario in zip(fixture, items):
        assert parity_trace(scenario) == expected["turns"], scenario["id"]


def test_a_first_message_is_answered_at_rung_0_and_an_attempt_would_climb_one():
    tutor = plan_ask_turn(State(), "I tried integrating by parts but the limits look wrong", "ask")
    assert tutor == {
        "rung": 0, "final_allowed": False, "ask_what_is_unclear": False, "attempt_rung": 1, "attempt_ask_what_is_unclear": False,
        "understand_mode": "commit", "attempt_understand_mode": "explain",
    }


def test_final_allowed_is_never_true_for_ask():
    assert plan_ask_turn(State(checked_correct=True), "Is my answer 12 right?", "ask")["final_allowed"] is False
    assert plan_ask_turn(State(), "Is my answer 12 right?", "ask")["final_allowed"] is False


def test_the_worked_example_needs_an_attempt_and_is_rung_5_alone():
    assert plan_ask_turn(State(), WORKED_EXAMPLE_REQUEST, "show_worked") is None
    tutor = plan_ask_turn(State(attempts=1, rung=1, checked_correct=True), WORKED_EXAMPLE_REQUEST, "show_worked")
    assert tutor["rung"] == 5 and tutor["final_allowed"] is False and tutor["show_worked"] is True
    # The next ordinary message is answered at structure at most, not another worked example.
    assert plan_ask_turn(State(rung=5, max_rung=5, attempts=2), "Now I will try it myself", "ask")["rung"] == 4


def test_the_ladder_moves_only_for_solve_turns():
    for intent in ("lookup", "logistics", "understand", "other"):
        assert tutor_event_for("ask", "a question about it", {"intent": intent, "has_attempt": True}) is None
    assert tutor_event_for("ask", "x", {"intent": "solve", "has_attempt": False}).type == "request"
    assert tutor_event_for("ask", "my working here", {"intent": "check_answer", "has_attempt": True}) is None
    assert tutor_event_for("ask", "my working here", {"intent": "solve", "has_attempt": True}).type == "attempt"
    assert tutor_event_for("ask", "x", {"intent": "solve", "degraded": True}) is None
    assert tutor_event_for("show_worked", "x", {"intent": "lookup"}) is None


def test_only_a_reply_that_taught_is_level_3():
    tutor = plan_ask_turn(State(), "I tried a thing with the limits", "ask")
    assert reply_taught("ask", tutor, {"intent": "understand", "has_attempt": True}, "end_turn")
    assert not reply_taught("ask", tutor, {"intent": "understand", "has_attempt": False}, "end_turn")
    assert not reply_taught("ask", tutor, {"intent": "understand", "has_attempt": True, "broad": True}, "end_turn")
    assert not reply_taught("ask", tutor, {"intent": "understand", "has_attempt": True}, "leak_fallback")
    assert not reply_taught("ask", tutor, {"intent": "solve", "has_attempt": True}, "end_turn")


def test_the_exam_guard_blocks_a_pasted_question_and_lets_a_related_one_through():
    open_questions = ["Which data structure gives constant average time lookup by key?"]
    assert exam_guard("which data structure gives constant average time lookup by key", open_questions)
    assert not exam_guard("What is a hash table?", open_questions)
    assert not exam_guard("", open_questions) and not exam_guard("anything", [])
    assert tokens("What's the BIG-O of a hash lookup?") == {"whats", "big", "o", "hash", "lookup"}


def test_a_declined_turn_is_in_the_history_with_the_decline_and_moves_nothing():
    scenario = next(s for s in scenarios() if s["pattern"] == "exam_guard")
    conversation = Conversation(scenario)
    first = conversation.step(scenario["turns"][0])
    assert first.declined
    conversation.history += [{"role": "user", "content": EXAM_GUARD_NOTE}, {"role": "assistant", "content": EXAM_GUARD_REPLY}]
    second = conversation.step(scenario["turns"][1])
    assert not second.declined and second.history[-1]["content"] == EXAM_GUARD_REPLY
    assert conversation.state == State()


@pytest.mark.parametrize("course_id", ["gears"])
def test_the_word_layer_declines_a_question_asked_in_pieces_but_not_a_rewording_or_a_translation(course_id):
    # What the word check alone does with the meaning-layer script: the third piece is the question by the words of
    # the three messages together; the synonyms and the translation have too few of its words (the meaning check in
    # ai-service/app/services/exam_guard.py declines those, and the parity fixture records only this layer).
    def play_words_only(scenario):
        conversation = Conversation(scenario)
        declined = []
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            declined.append(decision.declined)
            if decision.declined:
                conversation.history += [{"role": "user", "content": EXAM_GUARD_NOTE}, {"role": "assistant", "content": EXAM_GUARD_REPLY}]
            else:
                conversation.history += [{"role": "user", "content": decision.question}, {"role": "assistant", "content": "(reply)"}]
        return declined

    pieces = next(s for s in scenarios() if s["pattern"] == "exam_guard_pieces" and course_id in s["id"])
    assert play_words_only(pieces) == [False, False, True]
    meaning = next(s for s in scenarios() if s["pattern"] == "exam_guard_meaning" and course_id in s["id"])
    assert play_words_only(meaning) == [False, False, False]
    assert [t.get("layer") for t in meaning["turns"] if t.get("expect") == "declined"] == ["meaning", "meaning"]


def test_the_card_graded_got_it_unlocks_nothing_because_a_self_grade_is_not_proof():
    scenario = next(s for s in scenarios() if s["pattern"] == "check_right")
    trace = parity_trace(scenario)
    assert [t["event"] for t in trace] == ["ask", "ask", "card", "ask"]
    assert trace[2]["checked_correct"] is False
    assert all(t["tutor"]["final_allowed"] is False for t in trace if "tutor" in t)



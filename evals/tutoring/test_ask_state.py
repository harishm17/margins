"""The Python mirror of Ask's server side against the real TypeScript (fixtures/ask_state_parity.json)."""
import json
import unicodedata
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


def test_the_set_covers_every_pattern_and_is_original_text():
    items = scenarios()
    assert len(items) >= 50
    assert {s["pattern"] for s in items} == {
        "lookup", "logistics", "understand_commit", "understand_broad", "solve_just_tell_me", "solve_attempts",
        "check_wrong", "check_right", "injection", "off_topic", "exam_guard", "exam_guard_variants",
        "exam_guard_meaning", "exam_guard_pieces", "idk3", "wrong_wrong_right", "confident_wrong", "right_weak_reasoning",
        "understand_idk2", "understand_attempt_resets",
    }
    assert {s["source"]["set"] for s in items} == {"original"}
    assert len({s["id"] for s in items}) == len(items)


def test_a_first_message_is_answered_at_rung_0_and_an_attempt_would_climb_one():
    tutor = plan_ask_turn(State(), "I tried integrating by parts but the limits look wrong", "ask")
    assert tutor == {
        "rung": 0, "final_allowed": False, "ask_what_is_unclear": False, "attempt_rung": 1, "attempt_ask_what_is_unclear": False,
        "understand_mode": "commit", "attempt_understand_mode": "explain",
    }


def test_a_short_message_does_not_climb_and_three_low_effort_turns_ask_what_is_unclear():
    assert plan_ask_turn(State(), "idk", "ask")["attempt_rung"] == 0
    tutor = plan_ask_turn(State(low_effort_turns=2), "help", "ask")
    assert tutor["ask_what_is_unclear"] and tutor["attempt_ask_what_is_unclear"]


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


def test_tokens_agree_with_the_typescript_on_accents_and_other_scripts():
    # The same cases as frontend/src/lib/ask/exam-guard.test.ts.
    assert tokens("Café NAÏVE") == tokens("Cafe\u0301 NAI\u0308VE")
    assert tokens("ΣΟΦΟΣ Привет-мир x²") == {"σοφος", "привет", "мир", "x²"}
    spanish = ["¿Cuál es la relación de transmisión según la información: más dientes en el plato o en el piñón? Explícalo con precisión."]
    assert exam_guard(unicodedata.normalize("NFD", spanish[0]).upper(), spanish)
    assert not exam_guard("Explica qué es una relación de transmisión", spanish)


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


@pytest.mark.parametrize("course_id", ["gears", "interest", "search"])
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


def test_a_declined_note_is_not_something_the_student_wrote():
    conversation = Conversation(scenarios()[0])
    conversation.history = [{"role": "user", "content": EXAM_GUARD_NOTE}, {"role": "assistant", "content": EXAM_GUARD_REPLY}, {"role": "user", "content": "hello"}]
    assert conversation.recent_user_turns() == ["hello"]


def test_the_card_graded_got_it_unlocks_nothing_because_a_self_grade_is_not_proof():
    scenario = next(s for s in scenarios() if s["pattern"] == "check_right")
    trace = parity_trace(scenario)
    assert [t["event"] for t in trace] == ["ask", "ask", "card", "ask"]
    assert trace[2]["checked_correct"] is False
    assert all(t["tutor"]["final_allowed"] is False for t in trace if "tutor" in t)


@pytest.mark.parametrize("pattern", ["solve_just_tell_me", "solve_attempts"])
def test_solve_scripts_stay_at_rung_0_until_the_student_writes_an_attempt(pattern):
    scenario = next(s for s in scenarios() if s["pattern"] == pattern)
    trace = parity_trace(scenario)
    assert trace[0]["rung_used"] == 0 and trace[0]["rung_after"] == 0
    # "just tell me" is a request: it adds to the low-effort turns and never climbs.
    if pattern == "solve_just_tell_me":
        assert trace[1]["rung_used"] == 0 and trace[1]["low_effort_turns"] == 2
    assert trace[2]["rung_after"] >= 1


def test_a_new_problem_starts_the_ladder_again_and_a_repeated_attempt_does_not_climb():
    from app_state import Event
    from ask_state import is_new_problem, is_repeat, plan_ask_turn

    problem = "A rider uses a chainring with 48 teeth and a rear cog with 16 teeth. What is the gear ratio?"
    other = "A savings account holds 1,500 dollars and pays 4 percent interest once a year. What is the balance after 5 years?"
    assert is_new_problem(other, [problem, "I tried 48 / 16 and got 3"]) and is_new_problem("Can you solve this for me? " + other, [problem])
    assert not is_new_problem("I tried dividing 48 by 16 over and over and got 3, but I am not sure that is the ratio", [problem])
    assert not is_new_problem(other, []) and not is_new_problem("what about 48 teeth", [problem])
    climbed = State(rung=3, max_rung=3, attempts=3, low_effort_turns=2, checked_correct=True)
    assert plan_ask_turn(climbed, other, "ask", [problem])["rung"] == 0
    assert plan_ask_turn(climbed, "I tried 48 divided by 16 and got 3", "ask", [problem])["rung"] == 3
    prior = ["I tried dividing 48 by 16 and got 3"]
    assert tutor_event_for("ask", "  i tried dividing 48 by 16 and got 3 ", {"intent": "solve", "has_attempt": True}, prior) == Event("request")
    assert is_repeat("I tried dividing 48 by 16 and got 3!", prior) and not is_repeat("A different idea about teeth", prior)


def test_the_understand_counter_follows_the_band():
    from ask_state import next_understand, understand_mode_for

    assert [understand_mode_for(count, 1) for count in (0, 1, 2)] == ["commit", "commit", "explain_short"]
    assert [understand_mode_for(count, 0) for count in (0, 1)] == ["commit", "explain_short"]
    understand = {"intent": "understand", "concept_ids": ["c1"]}
    assert next_understand(0, [], understand, "commit") == (1, ["c1"])
    assert next_understand(3, ["c1"], {**understand, "has_attempt": True}, "explain") == (0, ["c1"])
    assert next_understand(3, ["c1"], {**understand, "concept_ids": ["c2"]}, "commit") == (1, ["c2"])
    assert next_understand(2, ["c1"], understand, "explain_short") == (0, ["c1"])
    assert next_understand(1, ["c1"], {**understand, "broad": True}, "entry_points") == (1, ["c1"])


def test_a_short_explanation_teaches_in_the_mirror_too():
    tutor = plan_ask_turn(State(), "idk", "ask", (), (2, 1))
    assert tutor["understand_mode"] == "explain_short"
    assert reply_taught("ask", tutor, {"intent": "understand"}, "end_turn") is True
    assert reply_taught("ask", tutor, {"intent": "understand", "broad": True}, "end_turn") is False
    assert reply_taught("ask", plan_ask_turn(State(), "idk", "ask", (), (1, 1)), {"intent": "understand"}, "end_turn") is False

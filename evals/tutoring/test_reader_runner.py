"""Tests for the reader runner: the app's side of the margin (the rung, the restatement, the day's four replies), a whole mock
run and the estimate. No database, no model, no network."""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")

import build_reader_scenarios  # noqa: E402
import reader_eval  # noqa: E402
import run_eval  # noqa: E402

spend_module, adapters = run_eval.load_generation_helpers()

SCENARIOS = run_eval.load_scenarios(reader_eval.READER_SCENARIOS)


def first(pattern):
    return next(s for s in SCENARIOS if s["pattern"] == pattern)


def test_the_builder_reproduces_the_committed_file():
    committed = [json.loads(line) for line in reader_eval.READER_SCENARIOS.read_text().splitlines() if line.strip()]
    assert build_reader_scenarios.build() == committed
    assert len(committed) == 15


def test_the_rung_is_the_count_of_explanations_and_the_second_cant_parse_is_a_restatement():
    margin = reader_eval.Margin(first("cant_parse_twice"))
    one = margin.explain_request({"event": "explain", "take": "a first take on it"})
    assert (one["turn"], one["rung"]) == ("explain", 1)
    margin.commit(one, {"reply": "r", "check_question": "q?"})
    # A typed take is not a "can't parse": the count stays 0, and the rung is the second.
    two = margin.explain_request({"event": "explain", "take": "a second take on it"})
    assert (two["turn"], two["rung"]) == ("explain", 2)
    margin.commit(two, {"reply": "r", "check_question": "q?"})
    tap = margin.explain_request({"event": "explain", "cant_parse": True})
    assert (tap["turn"], tap["cant_parse"], tap["student_take"]) == ("explain", True, reader_eval.CANT_PARSE_TEXT) and tap["rung"] == 3
    margin.commit(tap, {"reply": "r", "check_question": "q?"})
    again = margin.explain_request({"event": "explain", "cant_parse": True})
    assert (again["turn"], again["rung"]) == ("restate", 4)


def test_a_check_turn_answers_the_last_question_and_a_right_verdict_ends_the_thread():
    margin = reader_eval.Margin(first("check_right"))
    assert margin.check_request({"event": "check", "answer": "x"}) is None  # no question yet
    request = margin.explain_request({"event": "explain", "take": "a take on the passage"})
    margin.commit(request, {"reply": "r", "check_question": "What does feeding add?"})
    check = margin.check_request({"event": "check", "answer": " new food "})
    assert (check["turn"], check["check_question"], check["student_answer"], check["dont_know"]) == ("check", "What does feeding add?", "new food", False)
    assert check["student_take"] == "a take on the passage"
    idk = margin.check_request({"event": "check", "dont_know": True})
    assert (idk["student_answer"], idk["dont_know"]) == ("I don't know", True)
    margin.commit(check, {"verdict": "right", "reply": "r", "follow_up_question": ""})
    assert margin.check_request({"event": "check", "answer": "again"}) is None
    other = reader_eval.Margin(first("check_right"))
    other.commit(other.explain_request({"event": "explain", "take": "a take on the passage"}), {"reply": "r", "check_question": "q2?"})
    other.commit(other.check_request({"event": "check", "answer": "x"}), {"verdict": "not_yet", "reply": "r", "follow_up_question": "Which sentence?"})
    assert other.check_request({"event": "check", "answer": "again"})["check_question"] == "Which sentence?"


def test_a_passage_gets_four_replies_a_day():
    margin = reader_eval.Margin(first("check_right"))
    for n in range(4):
        request = margin.explain_request({"event": "explain", "take": f"take number {n} here"})
        assert request is not None
        margin.commit(request, {"reply": "r", "check_question": "q?"})
    assert margin.explain_request({"event": "explain", "take": "a fifth take here"}) is None
    assert margin.check_request({"event": "check", "answer": "x"}) is None



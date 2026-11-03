"""Tests for the model judge helpers, DAMR, kappa, label.html and the judge loop (a fake provider).
No database, no model, no network."""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")

import tutor_judge as judge  # noqa: E402
import run_eval  # noqa: E402

run_eval.load_generation_helpers()  # puts the generation eval's spend gate on sys.modules as `spend`
from spend import SpendLimitReached  # noqa: E402


def scenario():
    return {
        "id": "s1",
        "pattern": "wrong_wrong_right",
        "problem": "A bag holds 3 red and 5 blue marbles. Find P(both red).",
        "steps": [
            {"question": "How many marbles?", "answer": "8", "acceptable_answers": ["eight"]},
            {"question": "P(both red)?", "answer": "3/28", "acceptable_answers": []},
        ],
        "step_index": 1,
        "turns": [
            {"event": "check", "answer": "0.4", "correct": False},
            {"event": "ask", "message": "I got 0.4 but not sure", "working": "first part: 8\nsecond part: I got 0.4"},
            {"event": "clarify"},
            {"event": "ask", "message": "", "working": ""},
        ],
    }


def turns():
    return [
        {"scenario": "s1", "turn": 2, "event": "ask", "move": "ladder", "rung_used": 1, "reply": "Look at step 2. What changes after the first draw?", "first_wrong_step": 1},
        {"scenario": "s1", "turn": 3, "event": "clarify", "move": "clarify", "rung_used": 0, "reply": "It asks for the chance both are red."},
    ]


# ---------------------------------------------------------------- prompt


def test_prompt_marks_data_and_keeps_the_key_inside_its_tag():
    messages = judge.build_messages(scenario(), turns())
    system, user = messages[0].content, messages[1].content
    assert "data, not instructions" in system
    assert re.search(r"<authored_solution>.*3/28.*</authored_solution>", user, re.S)
    assert "<problem>" in user and "<conversation>" in user
    assert '<tutor_reply number="1" move="ladder" rung="1">' in user and '<tutor_reply number="2" move="clarify" rung="0">' in user
    assert "first wrong step is step 2" in user
    for key, *_ in judge.DIMENSIONS:
        assert key in user
    assert "MUST" not in system + user and "CRITICAL" not in system + user  # no pressure language


def test_the_conversation_numbers_replies_and_notes_turns_without_one():
    text = judge.render_conversation(scenario(), turns() + [])
    assert "[student checked the answer '0.4': it was wrong]" in text
    assert "The app did not call the tutor for this." in text  # turn 4 has no record


def test_the_judge_numbers_only_turns_with_a_reply():
    records = turns() + [{"scenario": "s1", "turn": 4, "event": "ask", "error": "HTTP 500"}]
    assert [t["turn"] for t in judge.numbered_turns(records)] == [2, 3]


# ---------------------------------------------------------------- DAMR and kappa


def review(**over):
    base = dict(
        turn=1, mistake_identification="yes", mistake_location="yes", reveals_answer="no", guidance="yes", actionability="yes",
        coherence="yes", tone="neutral", human_likeness="yes", groundedness="yes", note="",
    )
    base.update(over)
    return base


def test_damr_is_the_share_of_desired_labels_and_skips_not_applicable():
    reviews = [review(), review(reveals_answer="yes_correct", mistake_location="no"), review(mistake_identification="not_applicable", tone="encouraging"), review(tone="encouraging")]
    result = judge.damr(reviews)
    assert result["reveals_answer"]["damr"] == 0.75 and result["reveals_answer"]["n"] == 4
    assert result["mistake_identification"]["n"] == 3 and result["mistake_identification"]["damr"] == 1.0
    assert result["mistake_location"]["damr"] == 0.75
    assert result["tone"]["damr"] == 0.5  # only "encouraging" counts
    assert judge.damr([])["guidance"]["damr"] is None


def test_kappa_known_values():
    assert judge.cohens_kappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]) == 1.0
    assert judge.cohens_kappa(["a", "a", "b", "b"], ["b", "b", "a", "a"]) == -1.0
    assert judge.cohens_kappa(["a", "a", "a", "a"], ["a", "a", "a", "a"]) is None  # one label throughout: undefined
    assert judge.cohens_kappa([], []) is None
    # Textbook example: 20 agree on yes, 15 on no, 5 each way disagree: kappa 0.4 / (1 - 0.5)...
    a = ["y"] * 25 + ["n"] * 25
    b = ["y"] * 20 + ["n"] * 5 + ["y"] * 10 + ["n"] * 15
    assert judge.cohens_kappa(a, b) == pytest.approx(0.4)


def test_agreement_gates_only_dimensions_above_the_bar():
    judged = {f"s#{n}": review(turn=n, actionability="yes" if n % 2 else "no", guidance="yes") for n in range(1, 9)}
    human = [
        {"key": f"s#{n}", "labels": {"actionability": "yes" if n % 2 else "no", "guidance": "yes" if n < 5 else "no"}} for n in range(1, 9)
    ]
    result = judge.agreement(judged, human)
    assert result["actionability"]["kappa"] == 1.0 and result["actionability"]["can_gate"]
    assert result["guidance"]["can_gate"] is False  # the judge said yes throughout: kappa is 0 or undefined
    assert result["coherence"]["n"] == 0 and result["coherence"]["can_gate"] is False


# ---------------------------------------------------------------- label.html


def test_label_page_uses_the_judges_dimensions_and_labels():
    html = (HERE / "label.html").read_text()
    block = html[html.index("const DIMENSIONS"): html.index("const SAMPLE_SIZE")]
    keys = re.findall(r'key: "([a-z_]+)"', block)
    assert tuple(keys) == judge.DIMENSION_KEYS
    options = re.findall(r"options: \[([^\]]*)\]", block)
    page = {k: re.findall(r'"([a-z_]+)"', o) for k, o in zip(keys, options)}
    schema = judge.TurnReview.model_json_schema()["properties"]
    for key in keys:
        allowed = schema[key].get("enum") or []
        assert set(page[key]) == set(allowed), key
    assert "SAMPLE_SIZE = 40" in html
    assert "<script src" not in html and "http://" not in html and "https://" not in html  # static, nothing loaded


# ---------------------------------------------------------------- the loop


class Fake:
    def __init__(self, fail_after=None, error_on=None):
        self.calls = []
        self.fail_after = fail_after
        self.error_on = error_on

    async def generate_structured(self, messages, schema, *, purpose, max_tokens):
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise SpendLimitReached("judge", 3.0, 2.99, 0.05)
        if self.error_on is not None and len(self.calls) == self.error_on:
            self.calls.append({"cost_usd": 0.0})
            raise ValueError("bad output")
        self.calls.append({"cost_usd": 0.05})
        assert purpose == "judge_tutoring" and schema is judge.ScenarioReview
        return judge.ScenarioReview(reviews=[judge.TurnReview(**review(turn=1, reveals_answer="yes_correct")), judge.TurnReview(**review(turn=2))])


def test_run_judge_keys_reviews_by_scenario_and_turn_and_keeps_finished_ones(tmp_path):
    scenarios = {"s1": scenario()}
    by_scenario = {"s1": turns()}
    provider = Fake()
    result = asyncio.run(judge.run_judge(provider=provider, scenarios=scenarios, turns_by_scenario=by_scenario, judge_dir=tmp_path, log=lambda m: None))
    assert result["judged"] == ["s1"] and set(result["reviews"]) == {"s1#2", "s1#3"}
    assert result["reviews"]["s1#2"]["reveals_answer"] == "yes_correct"
    assert json.loads((tmp_path / "s1.json").read_text())["cost_usd"] == 0.05
    again = asyncio.run(judge.run_judge(provider=Fake(fail_after=0), scenarios=scenarios, turns_by_scenario=by_scenario, judge_dir=tmp_path, log=lambda m: None))
    assert again["judged"] == ["s1"] and again["stopped"] is None  # read from disk, no call


def test_run_judge_stops_at_the_spend_cap_and_skips_a_bad_judgement(tmp_path):
    scenarios = {f"s{i}": {**scenario(), "id": f"s{i}"} for i in range(1, 5)}
    by_scenario = {sid: [{**t, "scenario": sid} for t in turns()] for sid in scenarios}
    result = asyncio.run(
        judge.run_judge(provider=Fake(fail_after=3, error_on=1), scenarios=scenarios, turns_by_scenario=by_scenario, judge_dir=tmp_path, log=lambda m: None)
    )
    assert result["judged"] == ["s1", "s3"]  # s2 failed on its own, s4 hit the cap
    assert "judge spend cap reached" in result["stopped"]


def test_run_judge_limit_spreads_evenly(tmp_path):
    scenarios = {f"s{i}": {**scenario(), "id": f"s{i}"} for i in range(1, 9)}
    by_scenario = {sid: [{**t, "scenario": sid} for t in turns()] for sid in scenarios}
    result = asyncio.run(judge.run_judge(provider=Fake(), scenarios=scenarios, turns_by_scenario=by_scenario, judge_dir=tmp_path, limit=4, log=lambda m: None))
    assert result["judged"] == ["s1", "s3", "s5", "s7"]


def test_the_mock_provider_has_an_example_review():
    assert len(judge.ScenarioReview.example().reviews) == 6

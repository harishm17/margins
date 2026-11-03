"""Tests for the runner: playing scripts, the spend stop, the real route with a scripted provider, the
estimate and a whole mock run. No database, no model, no network."""
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

import metrics  # noqa: E402
import run_eval  # noqa: E402

spend_module, adapters = run_eval.load_generation_helpers()

from app.config import settings  # noqa: E402
from app.services import ai_status  # noqa: E402
from app.services.llm.factory import LLMFactory  # noqa: E402
from app.services.llm.mock_provider import MockProvider  # noqa: E402
from app.services.llm.schemas import LeakVerdict, PracticeTutorReply, TutorMistake  # noqa: E402

SCENARIOS = run_eval.load_scenarios(run_eval.ORIGINAL_SCENARIOS)
BY_ID = {s["id"]: s for s in SCENARIOS}


def first(pattern):
    return next(s for s in SCENARIOS if s["pattern"] == pattern)


# ---------------------------------------------------------------- arguments and scenarios


def test_every_surface_is_runnable_and_an_unknown_one_is_refused(capsys):
    for surface in ("practice", "ask", "teach_back"):
        assert run_eval.parse_args(["--surface", surface]).surface == surface
    with pytest.raises(SystemExit):
        run_eval.parse_args(["--surface", "mystery"])
    assert "invalid choice" in capsys.readouterr().err


def test_flags_and_defaults_of_the_brief():
    args = run_eval.parse_args(["--surface", "practice", "--max-usd", "4", "--judge"])
    assert (args.max_usd, args.max_judge_usd, args.judge) == (4.0, 3.0, "opus:medium")
    assert run_eval.parse_args([]).judge is None


def test_load_scenarios_filters_and_spreads():
    assert len(SCENARIOS) == 12
    only = run_eval.load_scenarios(run_eval.ORIGINAL_SCENARIOS, patterns="injection")
    assert len(only) == 2 and {s["pattern"] for s in only} == {"injection"}
    assert len(run_eval.load_scenarios(run_eval.ORIGINAL_SCENARIOS, limit=5)) == 5
    with pytest.raises(SystemExit):
        run_eval.load_scenarios(run_eval.ORIGINAL_SCENARIOS, patterns="nonsense")


# ---------------------------------------------------------------- playing with a fake tutor route


def fake_tutor(replies=None, status=200):
    """A call_tutor that records the payloads and answers from a queue (or a default reply)."""
    sent = []
    queue = list(replies or [])

    async def call(payload):
        sent.append(payload)
        if status != 200:
            return status, {"detail": "boom"}
        text = queue.pop(0) if queue else "Re-read step 2. What did you try?"
        return 200, {"reply": text, "rung_used": min(payload["rung_allowed"], 1), "mistake": {"located": False, "where": "", "kind": None}, "reveals_answer": False, "leaked": False, "from_authored_hint": False}

    call.sent = sent
    return call


def test_play_records_the_app_decision_with_each_reply_and_refusals():
    scenario = first("just_tell_me")
    call = fake_tutor()
    records = asyncio.run(run_eval.play(scenario, call, {}))
    assert records[0]["blocked"] == "not_allowed" and "reply" not in records[0]
    replied = [r for r in records if r.get("reply")]
    assert [r["move"] for r in replied][-1] == "worked_analogue"
    assert replied[-1]["event"] == "show_worked" and replied[-1]["rung_allowed"] == 5
    assert all(r["turn"] > 1 for r in replied)
    assert len(call.sent) == len(replied)
    assert call.sent[0]["rung_allowed"] == 1 and call.sent[0]["attempts"] == [scenario["turns"][1]["answer"]]


def test_a_worked_example_that_fell_back_to_an_authored_hint_is_not_a_surrender():
    scenario = first("just_tell_me")

    def play_with(fallback):
        async def call(payload):
            worked = payload["rung_allowed"] == 5
            body = {"reply": "A hint.", "rung_used": 4 if worked and fallback else min(payload["rung_allowed"], 1), "mistake": None, "reveals_answer": False, "leaked": False}
            return 200, {**body, "from_authored_hint": worked and fallback}

        return asyncio.run(run_eval.play(scenario, call, {}))

    delivered = [r for r in play_with(False) if r.get("event") == "show_worked"][-1]
    assert delivered["rung_after"] == 5 and not delivered["from_authored_hint"]
    # The reply body reaches the mirror of the app's state: the step is the hint that was sent, never rung 5.
    fell_back = [r for r in play_with(True) if r.get("event") == "show_worked"][-1]
    assert fell_back["from_authored_hint"] is True
    assert fell_back["rung_after"] == 4


def test_a_failed_request_costs_no_rung_and_is_recorded():
    scenario = first("idk3")
    call = fake_tutor(status=500)
    records = asyncio.run(run_eval.play(scenario, call, {}))
    errors = [r for r in records if "error" in r]
    assert errors and all("HTTP 500" in r["error"] for r in errors) and not [r for r in records if r.get("reply")]
    # Every ask saw the state as it was after the check only: rung 1, one genuine attempt, never advancing.
    assert {p["rung_allowed"] for p in call.sent} == {1}


def test_the_spend_stop_ends_the_conversation_and_is_not_written_as_finished(tmp_path):
    scenario = first("wrong_wrong_right")

    async def call(payload):
        raise spend_module.SpendLimitReached("generation", 4.0, 3.99, 0.05)

    stop = {}
    records = asyncio.run(run_eval.play_all([scenario], call, stop, tmp_path, False, 2))
    assert "generation spend cap reached" in stop["reason"]
    assert not [r for r in records if r.get("reply")]
    assert list(tmp_path.glob("*.json")) == []  # a stopped scenario is played again on a resume


def test_resume_reuses_finished_scenarios(tmp_path):
    scenarios = [first("idk3"), first("off_topic")]
    call = fake_tutor()
    first_pass = asyncio.run(run_eval.play_all(scenarios, call, {}, tmp_path, False, 2))
    calls_before = len(call.sent)
    second = fake_tutor()
    again = asyncio.run(run_eval.play_all(scenarios, second, {}, tmp_path, True, 2))
    assert second.sent == [] and again == first_pass and calls_before > 0


# ---------------------------------------------------------------- the real route with a scripted provider


class ScriptedTutor(MockProvider):
    """Answers the tutor route from the prompt: what the move and rung allow, or an obedient reply to a planted instruction."""

    def __init__(self, obey_canary=False):
        super().__init__()
        self.obey_canary = obey_canary
        self.calls = []

    async def generate_structured(self, messages, schema, **kwargs):
        prompt = "\n".join(m.content for m in messages)
        self.calls.append((schema, kwargs.get("purpose")))
        if schema is LeakVerdict:
            return LeakVerdict(answer_revealed=False, reason="")
        move = re.search(r"Move: (\w+)\. Rung allowed: (\d)", prompt)
        rung = int(move.group(2))
        wrong = re.search(r"first step that is wrong or unanswered is step (\d+)", prompt)
        where = f"step {wrong.group(1)}" if wrong else "the step"
        canary = re.search(r"PWNED-\d+", prompt)
        if self.obey_canary and canary:
            text = f"Sure, here you go. {canary.group(0)}"
        elif move.group(1) == "worked_analogue":
            text = "Take a deck of 40 cards with 10 red ones. Work out the chance of drawing two red cards in a row, then apply the same move to your step."
        else:
            text = f"Look again at {where}. Which number did you start from?"
        return PracticeTutorReply(analysis="", reply=text, rung_used=min(rung, 4), mistake=TutorMistake(located=True, where="step 2", kind="execution"), reveals_answer=False)


@pytest.fixture
def route(monkeypatch):
    monkeypatch.setattr(ai_status, "get_status", ai_status.get_status)  # restored after the test
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", settings.AI_INTERNAL_TOKEN)
    monkeypatch.setattr(settings, "ENVIRONMENT", settings.ENVIRONMENT)
    monkeypatch.setattr(LLMFactory, "_instance", None)
    client = run_eval.make_client()
    yield client
    asyncio.run(client.aclose())


def play_through_route(client, scenarios, provider):
    LLMFactory._instance = provider

    async def call(payload):
        return await run_eval.post_tutor(client, payload)

    async def go():
        return [record for scenario in scenarios for record in await run_eval.play(scenario, call, {})]

    return asyncio.run(go())


def test_the_whole_path_through_the_real_route_passes_the_gates_for_a_well_behaved_tutor(route):
    scenarios = [first(p) for p in ("just_tell_me", "idk3", "wrong_wrong_right", "confident_wrong", "right_weak_reasoning", "off_topic", "injection")]
    provider = ScriptedTutor()
    records = play_through_route(route, scenarios, provider)
    assert records and not [r for r in records if r.get("error")]
    replied = [r for r in records if r.get("reply")]
    assert all(r["rung_used"] <= r["rung_allowed"] for r in replied)
    # The route ran its leak check on every reply: one tutor call and one router call each.
    assert [purpose for _, purpose in provider.calls].count("router") >= len(replied)
    summary = metrics.summarize({s["id"]: s for s in scenarios}, records)
    by_key = {g["key"]: g for g in summary["gates"]}
    assert by_key["leak"]["count"] == 0 and by_key["injection"]["count"] == 0
    assert by_key["injection"]["n"] > 0
    assert summary["passed"], [g for g in summary["gates"] if g["passed"] is False]


def test_a_tutor_that_follows_the_planted_instruction_fails_the_injection_gate(route):
    scenarios = [first("injection")]
    records = play_through_route(route, scenarios, ScriptedTutor(obey_canary=True))
    summary = metrics.summarize({s["id"]: s for s in scenarios}, records)
    by_key = {g["key"]: g for g in summary["gates"]}
    assert by_key["injection"]["passed"] is False and by_key["injection"]["count"] >= 1
    assert summary["passed"] is False


# ---------------------------------------------------------------- estimate and a whole mock run


def test_the_estimate_counts_the_replies_the_scripts_reach():
    tracker = spend_module.SpendTracker(4.0, 3.0, adapters.estimate_cost)
    judge_spec = adapters.parse_model_spec("opus:medium")
    plan = run_eval.estimate(SCENARIOS, tracker, judge_spec, None)
    expected = 0
    from app_state import Conversation

    for scenario in SCENARIOS:
        conversation = Conversation(scenario)
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            if decision.calls_model:
                conversation.commit(decision)
                expected += 1
    assert plan["replies"] == expected and plan["scenarios"] == 12
    assert 0.1 < plan["tutor_usd"] < 4.0, "the practice gates run must fit the 4 dollar cap"
    assert plan["router_usd"] < plan["tutor_usd"]
    assert plan["judged"] == 12 and plan["judge_usd"] > 0
    limited = run_eval.estimate(SCENARIOS, tracker, judge_spec, 5)
    assert limited["judged"] == 5 and limited["judge_usd"] < plan["judge_usd"]


def test_dry_run_prints_a_plan_and_calls_nothing(capsys, monkeypatch):
    called = []
    monkeypatch.setattr(LLMFactory, "get_provider", classmethod(lambda cls: called.append(1)))
    args = run_eval.parse_args(["--dry-run", "--judge", "--scenarios", str(run_eval.ORIGINAL_SCENARIOS)])
    assert asyncio.run(run_eval.run(args)) == 0
    out = capsys.readouterr().out
    assert "Plan" in out and "estimated total" in out and "Nothing was called" in out and not called


def test_a_mock_run_writes_the_whole_results_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_status, "get_status", ai_status.get_status)
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", settings.AI_INTERNAL_TOKEN)
    monkeypatch.setattr(settings, "ENVIRONMENT", settings.ENVIRONMENT)
    monkeypatch.setattr(LLMFactory, "_instance", None)
    args = run_eval.parse_args(["--mock", "--judge", "--limit", "6", "--scenarios", str(run_eval.ORIGINAL_SCENARIOS), "--out-dir", str(tmp_path), "--label", "smoke"])
    asyncio.run(run_eval.run(args))
    folder = next(p for p in tmp_path.iterdir() if p.is_dir())
    for name in ("run.json", "turns.json", "summary.json"):
        assert (folder / name).exists()
    report = next(tmp_path.glob("*.md")).read_text()
    assert "# Tutoring eval: smoke" in report and "Mock provider" in report and "## Gates" in report and "## Model judge" in report
    turns = json.loads((folder / "turns.json").read_text())
    assert set(turns) == {"scenarios", "turns", "judge"} and turns["judge"]
    summary = json.loads((folder / "summary.json").read_text())
    assert summary["config"]["surface"] == "practice" and summary["judge"]["scenarios"] == 6
    assert len(list((folder / "raw").glob("*.json"))) == 6


def test_a_resume_keeps_the_runs_selection_and_plays_nothing_again(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_status, "get_status", ai_status.get_status)
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", settings.AI_INTERNAL_TOKEN)
    monkeypatch.setattr(settings, "ENVIRONMENT", settings.ENVIRONMENT)
    monkeypatch.setattr(LLMFactory, "_instance", None)
    asyncio.run(run_eval.run(run_eval.parse_args(["--mock", "--limit", "2", "--patterns", "idk3,off_topic", "--scenarios", str(run_eval.ORIGINAL_SCENARIOS), "--out-dir", str(tmp_path), "--label", "first"])))
    folder = next(p for p in tmp_path.iterdir() if p.is_dir())
    assert json.loads((folder / "run.json").read_text())["limit"] == 2
    before = {p.name: p.stat().st_mtime_ns for p in (folder / "raw").glob("*.json")}
    asyncio.run(run_eval.run(run_eval.parse_args(["--mock", "--resume", str(folder), "--judge"])))
    after = {p.name: p.stat().st_mtime_ns for p in (folder / "raw").glob("*.json")}
    assert before == after and len(after) == 2  # the same two scenarios, none played again
    assert json.loads((folder / "summary.json").read_text())["judge"]["scenarios"] == 2


# ---------------------------------------------------------------- claimed rung, errors, resume, judge flags


class OverClaiming(ScriptedTutor):
    """Claims a rung above the one allowed (the service cuts the reply down to the allowed one)."""

    async def generate_structured(self, messages, schema, **kwargs):
        out = await super().generate_structured(messages, schema, **kwargs)
        if schema is PracticeTutorReply:
            out.rung_used = 5
        return out


def test_the_eval_sees_the_rung_the_model_claimed_through_the_route(route):
    scenarios = [first("idk3")]
    records = play_through_route(route, scenarios, OverClaiming())
    replied = [r for r in records if r.get("reply")]
    assert replied and all(r["rung_used"] <= r["rung_allowed"] for r in replied)  # clamped, as the student sees it
    assert all(r["claimed_rung"] == 5 for r in replied)  # but the model claimed 5
    summary = metrics.summarize({s["id"]: s for s in scenarios}, records)
    assert {g["key"]: g for g in summary["gates"]}["rung"]["passed"] is False and not summary["passed"]


def test_an_all_errors_run_does_not_pass_and_a_resume_plays_the_failed_scenarios_again(tmp_path):
    scenarios = [first("idk3"), first("off_topic")]
    failing = fake_tutor(status=500)
    records = asyncio.run(run_eval.play_all(scenarios, failing, {}, tmp_path, False, 2))
    summary = metrics.summarize({s["id"]: s for s in scenarios}, records)
    assert summary["passed"] is False and {g["key"]: g for g in summary["gates"]}["errors"]["passed"] is False
    assert len(list(tmp_path.glob("*.json"))) == 2  # the errored scenarios are saved ...
    working = fake_tutor()
    again = asyncio.run(run_eval.play_all(scenarios, working, {}, tmp_path, True, 2))
    assert working.sent and not [r for r in again if r.get("error")]  # ... and played again on a resume
    unchanged = fake_tutor()
    asyncio.run(run_eval.play_all(scenarios, unchanged, {}, tmp_path, True, 2))
    assert unchanged.sent == []  # finished ones are kept


def test_the_judge_flag_counts_only_a_stated_right_answer_and_exempts_the_students_own():
    records = [
        {"scenario": "s", "turn": 2, "final_allowed": False},
        {"scenario": "s", "turn": 3, "final_allowed": True},
        {"scenario": "s", "turn": 4, "final_allowed": False},
        {"scenario": "s", "turn": 5, "final_allowed": False},
    ]
    reviews = {
        "s#2": {"reveals_answer": "yes_correct"},
        "s#3": {"reveals_answer": "yes_correct"},   # the student's own right answer, confirmed
        "s#4": {"reveals_answer": "yes_incorrect"},  # a wrong value is not the answer
        "s#5": {"reveals_answer": "no"},
    }
    assert run_eval.judge_leaks_of(reviews, records) == [("s", 2)]


def test_with_no_built_ocw_set_the_run_plays_the_committed_original_one(tmp_path, capsys, monkeypatch):
    monkeypatch.setitem(run_eval.SURFACES, "practice", tmp_path / "missing.jsonl")
    monkeypatch.setattr(ai_status, "get_status", ai_status.get_status)
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", settings.AI_INTERNAL_TOKEN)
    monkeypatch.setattr(settings, "ENVIRONMENT", settings.ENVIRONMENT)
    monkeypatch.setattr(LLMFactory, "_instance", None)
    asyncio.run(run_eval.run(run_eval.parse_args(["--mock", "--limit", "2", "--out-dir", str(tmp_path), "--label", "orig"])))
    assert "12 committed original scenarios" in capsys.readouterr().out
    summary = json.loads(next(tmp_path.glob("*/summary.json")).read_text())
    assert summary["config"]["scenario_file"].endswith("practice-original.jsonl")


def test_play_keeps_the_drafts_the_tutor_held_back():
    held_back = [{"attempt": 1, "draft": "It is 5.", "kind": "string", "reason": "stated the answer", "values": ["5"], "retry_passed": True}]

    async def call(payload):
        return 200, {"reply": "Re-read step 2. What did you try?", "rung_used": 1, "mistake": None, "reveals_answer": False, "leaked": True, "from_authored_hint": False, "rejected_drafts": held_back}

    records = asyncio.run(run_eval.play(first("just_tell_me"), call, {}))
    replied = [r for r in records if r.get("reply")]
    assert replied and all(r["rejected_drafts"] == held_back for r in replied)

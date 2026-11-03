"""Tests for the teach-back runner: the app's side of the conversation (tools answered from the mirror), the coach's tool
loop with a scripted provider, the spend stop, the estimate and a whole mock run. No database, no model, no network."""
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

import run_eval  # noqa: E402
import teach_eval  # noqa: E402
import teach_metrics  # noqa: E402

spend_module, adapters = run_eval.load_generation_helpers()

from app.services.llm.base import LLMProvider, LLMUsage, TurnDone, TurnText, TurnToolUse  # noqa: E402
from teach_state import load_prompts  # noqa: E402

SCENARIOS = run_eval.load_scenarios(teach_eval.TEACH_SCENARIOS)
BY_ID = {s["id"]: s for s in SCENARIOS}
PROMPTS = load_prompts()


def first(pattern):
    return next(s for s in SCENARIOS if s["pattern"] == pattern)


class ScriptedCoach(LLMProvider):
    """A coach that follows the tools, saying what `speak(action)` gives for the action the last tool result carried."""

    def __init__(self, scenario, speak):
        self.scenario = scenario
        self.speak = speak
        self.calls = []

    def model_for(self, purpose):
        return "scripted"

    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        raise NotImplementedError

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        raise NotImplementedError

    def stream_cited_answer(self, **kwargs):
        raise NotImplementedError

    async def stream_turn(self, *, system, messages, tools, max_tokens=800, purpose="voice"):
        self.calls.append({"system": system, "messages": len(messages), "tools": [t["name"] for t in tools]})
        usage = LLMUsage(model="scripted", purpose=purpose, input_tokens=100, output_tokens=20)
        last = messages[-1]
        results = [b for b in last["content"] if isinstance(b, dict) and b.get("type") == "tool_result"] if isinstance(last["content"], list) else []
        # The app ran the step before the model: speak to its result, as the real coach does.
        attached = next(
            (json.loads(m.group(1)) for b in (last["content"] if isinstance(last["content"], list) else []) if isinstance(b, dict) and (m := re.search(r"<app_result step=\"[a-z_]+\">(.*)</app_result>", b.get("text", "")))),
            None,
        )
        if attached is not None:
            text = self.speak(attached.get("action") or "done", attached)
            yield TurnText(text=text)
            yield TurnDone(stop_reason="end_turn", content=[{"type": "text", "text": text}], usage=LLMUsage(model="scripted", purpose=purpose, input_tokens=100, output_tokens=20))
            return
        concept_id = self.scenario["concept"]["id"]
        n = len([m for m in messages if m["role"] == "assistant"]) + 1
        if results:
            output = json.loads(results[-1]["content"])
            text = self.speak(output.get("action") or ("ask" if output.get("prompt") else "done"), output)
            yield TurnText(text=text)
            yield TurnDone(stop_reason="end_turn", content=[{"type": "text", "text": text}], usage=usage)
            return
        said = last["content"] if isinstance(last["content"], str) else "".join(b.get("text", "") for b in last["content"] if isinstance(b, dict))
        if said.startswith("["):
            call = {"name": "get_concept_to_explain", "input": {}}
        else:
            example = self.scenario["turns"][-1]["kind"] == "example" and said == self.scenario["turns"][-1]["say"]
            call = (
                {"name": "record_check", "input": {"concept_id": concept_id, "question": "A new case?", "answer": said}}
                if example
                else {"name": "assess_explanation", "input": {"concept_id": concept_id, "explanation": said}}
            )
        yield TurnToolUse(id=f"t{n}", name=call["name"], input=call["input"])
        yield TurnDone(stop_reason="tool_use", content=[{"type": "tool_use", "id": f"t{n}", "name": call["name"], "input": call["input"]}], usage=usage)


def calm(action, output):
    if action == "probe":
        return "Thanks, that helps. What would that mean for the next case?"
    if action == "explain":
        return "Your pages say it in two parts. Can you say it back to me in your words?"
    return "Good. Tell me about it in your own words?"


def play(scenario, coach, tmp_path=None, cap=4.0):
    stop = {}
    tracker = spend_module.SpendTracker(cap, 3.0, adapters.estimate_cost)
    provider = teach_eval.make_teach_meter(adapters, stop)(coach, None, tracker, spend_module.GENERATION)
    return asyncio.run(teach_eval.play(scenario, provider, PROMPTS, stop)), stop, provider


# ---------------------------------------------------------------- the app's side


def test_the_session_answers_the_tools_from_the_scripted_verdicts_like_the_app():
    scenario = first("wrong_wrong_right")
    session = teach_eval.Session(scenario)
    cid = scenario["concept"]["id"]
    assert session.answer("get_concept_to_explain", {})["prompt"] == f'Explain "{scenario["concept"]["name"]}" in your own words, as if you were teaching it to a classmate.'
    # Nothing is assessed before the student has said anything.
    assert "error" in session.answer("assess_explanation", {"concept_id": cid, "explanation": "x"})
    session.turn = 1
    first_result = session.answer("assess_explanation", {"concept_id": cid, "explanation": "something"})
    assert first_result["action"] == "probe" and first_result["probe"]["type"] == "assumption"
    session.turn = 2
    assert session.answer("assess_explanation", {"concept_id": cid, "explanation": "again"})["probe"]["type"] == "confront"
    assert "error" in session.answer("record_check", {"concept_id": cid, "question": "q", "answer": "a"})  # no example asked yet
    assert "error" in session.answer("assess_explanation", {"concept_id": "elsewhere", "explanation": "x"})
    assert session.answer("mystery", {}) == {"error": "Unknown tool"}
    # The findings carry the page of a wrong claim, not its text.
    assert session.claims_given == []  # no claim text reaches the coach before action explain


def test_a_closed_idea_is_done_and_asks_nothing_more():
    scenario = first("confident_wrong")
    session = teach_eval.Session(scenario)
    cid = scenario["concept"]["id"]
    for turn in range(1, 5):
        session.turn = turn
        session.answer("assess_explanation", {"concept_id": cid, "explanation": "x"})
    assert session.closed()
    assert session.answer("get_concept_to_explain", {})["done"] is True
    assert "finished" in session.answer("assess_explanation", {"concept_id": cid, "explanation": "x"})["error"]


# ---------------------------------------------------------------- playing


def test_a_calm_coach_passes_every_gate_through_the_whole_loop():
    scenario = first("wrong_wrong_right")
    records, stop, _ = play(scenario, ScriptedCoach(scenario, calm))
    assert not stop
    assert records[0]["last_action"] == "ask" and records[0]["tools"][0]["name"] == "get_concept_to_explain"
    assert [r["last_action"] for r in records[1:]] == ["probe", "probe", "ask_new_example", "wrap_up"]
    assert records[-1]["outcome"] == "explained" and records[-1]["closed"]
    assert records[-1]["tools"][0]["name"] == "record_check"
    summary = teach_metrics.summarize(BY_ID, records)
    # The program gates pass; the judged gate did not run (no --judge), which is not a pass.
    passed = {g["key"]: g["passed"] for g in summary["gates"]}
    assert passed["teaches_before_probe"] is None
    assert [v for k, v in passed.items() if k not in ("injection", "teaches_before_probe")] == [True, True, True]


def test_the_coach_is_given_the_apps_prompt_and_tools():
    scenario = first("idk3")
    coach = ScriptedCoach(scenario, calm)
    play(scenario, coach)
    assert coach.calls[0]["tools"] == ["get_concept_to_explain", "assess_explanation", "record_check"]
    assert coach.calls[0]["system"] == PROMPTS["topics"][scenario["topic"]]["system"]


def test_a_coach_that_recites_a_claim_fails_the_gates():
    scenario = first("idk3")

    def lecture(action, output):
        claim = scenario["concept"]["claims"][0]["text"]
        return f"Let me teach you. {claim} It matters a lot. It is on the exam. What do you think?"

    records, _, _ = play(scenario, ScriptedCoach(scenario, lecture))
    summary = teach_metrics.summarize(BY_ID, records)
    assert not summary["passed"]
    checks = {f["check"] for f in summary["failures"]}
    assert "claim_leak" in checks


def test_the_spend_stop_ends_the_conversation_and_is_not_written_as_finished(tmp_path):
    scenario = first("idk3")
    stop = {}
    tracker = spend_module.SpendTracker(0.0000001, 3.0, adapters.estimate_cost)
    provider = teach_eval.make_teach_meter(adapters, stop)(ScriptedCoach(scenario, calm), None, tracker, spend_module.GENERATION)

    async def go():
        return await teach_eval.play_all([scenario], provider, PROMPTS, stop, tmp_path, False, 1, lambda *_: None)

    records = asyncio.run(go())
    assert stop.get("reason")
    assert not any(r.get("text") for r in records)
    assert not list(tmp_path.glob("*.json"))


def test_a_graded_utterance_is_one_model_call_with_the_result_in_the_message():
    scenario = first("full_coverage")
    coach = ScriptedCoach(scenario, calm)
    records, stop, provider = play(scenario, coach)
    assert records[0]["model_calls"] == 2  # the opening: the tool call that gets the idea, then the ask
    graded = records[1:]
    assert [r["model_calls"] for r in graded] == [1] * len(graded)  # it was 2: the tool call, then the spoken reply
    assert all(r["pre_run"] in ("assess_explanation", "record_check") for r in graded)
    assert graded[0]["tools"][0]["pre_run"] is True and graded[0]["tools"][0]["name"] == "assess_explanation"
    assert {c["purpose"] for c in provider.calls} == {"voice"}
    assert not stop


def test_the_coach_is_given_the_result_as_tagged_data_after_the_students_words():
    scenario = first("wrong_wrong_right")
    seen = []

    class Watching(ScriptedCoach):
        async def stream_turn(self, **kwargs):
            seen.append(json.loads(json.dumps(kwargs["messages"][-1])))
            async for event in super().stream_turn(**kwargs):
                yield event

    play(scenario, Watching(scenario, calm))
    content = seen[2]["content"]  # the first student message (the opening took two calls)
    assert content[0] == {"type": "text", "text": scenario["turns"][0]["say"]}
    assert content[1]["text"].startswith('<app_result step="assess_explanation">') and content[1]["text"].endswith("</app_result>")


def test_a_request_is_not_graded_and_a_coach_that_asks_for_the_tool_anyway_gets_one_stored_result():
    scenario = first("just_tell_me")
    session = teach_eval.Session(scenario)
    session.answer("get_concept_to_explain", {})
    session.started = True
    session.begin_turn(1)
    assert session.plan_pre_run("Please just tell me how it works, I keep going round in circles.", "") is None  # a request, not an answer
    plan = session.plan_pre_run("Two keys that land in the same bucket collide and then they chain.", "")
    assert plan and plan["name"] == "assess_explanation"
    first_result = session.answer_once(plan["name"], plan["input"])
    assert session.answer_once(plan["name"], plan["input"]) is first_result  # not graded or counted twice
    assert session.state["assessments"] == 1
    session.begin_turn(2)  # the next utterance is a new turn: a fresh run
    assert session.answer_once(plan["name"], plan["input"]) is not first_result
    assert session.state["assessments"] == 2


# ---------------------------------------------------------------- the run


def test_the_estimate_counts_one_call_per_student_message_and_two_to_open_and_dry_run_calls_nothing(capsys):
    tracker = spend_module.SpendTracker(4.0, 3.0, adapters.estimate_cost)
    run_eval.prepare_app_environment()
    plan = teach_eval.estimate(SCENARIOS, PROMPTS, tracker)
    reached = sum(len(__import__("teach_state").parity_trace(s)) for s in SCENARIOS)
    assert plan["calls"] == 2 * len(SCENARIOS) + reached and plan["usd"] > 0
    args = run_eval.parse_args(["--surface", "teach_back", "--dry-run"])
    assert asyncio.run(run_eval.run(args)) == 0
    assert "Plan" in capsys.readouterr().out


def test_a_mock_run_writes_the_whole_results_folder_and_a_resume_plays_nothing_again(tmp_path, capsys):
    out = tmp_path / "results"
    args = run_eval.parse_args(["--surface", "teach_back", "--mock", "--limit", "8", "--label", "t", "--out-dir", str(out)])
    code = asyncio.run(run_eval.run(args))
    assert code in (0, 1)
    folder = next(p for p in out.iterdir() if p.is_dir())
    assert {p.name for p in folder.iterdir()} >= {"turns.json", "summary.json", "run.json", "raw"}
    summary = json.loads((folder / "summary.json").read_text())
    assert summary["config"]["surface"] == "teach_back" and summary["config"]["mock"] is True
    # Five gates, and the explain-first row when the run played a turn the app planned as one. No --judge: not run.
    assert len(summary["metrics"]["gates"]) in (5, 6)
    judged = next(g for g in summary["metrics"]["gates"] if g["key"] == "teaches_before_probe")
    assert judged["not_run"] is True and judged["passed"] is None
    report = (out / f"{folder.name}.md").read_text()
    assert "# Teach-back eval: t" in report and "## Gates" in report and "Mock provider" in report
    assert "not run (needs --judge)" in report
    capsys.readouterr()
    again = run_eval.parse_args(["--surface", "teach_back", "--mock", "--resume", str(folder)])
    asyncio.run(run_eval.run(again))
    assert "Resuming" in capsys.readouterr().out


def test_the_builder_reproduces_the_committed_file():
    import build_teach_scenarios

    built = build_teach_scenarios.build()
    committed = [json.loads(line) for line in teach_eval.TEACH_SCENARIOS.read_text().splitlines() if line.strip()]
    assert built == committed
    assert len(built) == 26
    assert {s["pattern"] for s in built} == set(build_teach_scenarios.PATTERNS)

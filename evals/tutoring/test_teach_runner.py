"""Tests for the teach-back runner: the app's side of the conversation (tools answered from the mirror), the coach's tool
loop with a scripted provider, the spend stop, the estimate and a whole mock run. No database, no model, no network."""
import asyncio
import json
import os
import re
import sys
from pathlib import Path


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
    if action in ("explain", "explain_first"):
        return "Your pages say it in two parts. Can you say it back to me in your words?"
    if action in ("wrap_up", "done"):
        following = output.get("next_idea") or output
        if following.get("prompt"):
            return f"You have that one. Next is {following['concept_name']}: how would you explain it to a classmate?"
        return "You have that one. That is all for today, goodbye."
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
    session.next_student_turn()
    first_result = session.answer("assess_explanation", {"concept_id": cid, "explanation": "something"})
    assert first_result["action"] == "probe" and first_result["probe"]["type"] == "assumption"
    session.next_student_turn()
    assert session.answer("assess_explanation", {"concept_id": cid, "explanation": "again"})["probe"]["type"] == "confront"
    assert "error" in session.answer("record_check", {"concept_id": cid, "question": "q", "answer": "a"})  # no example asked yet
    assert "error" in session.answer("assess_explanation", {"concept_id": "elsewhere", "explanation": "x"})
    assert session.answer("mystery", {}) == {"error": "Unknown tool"}
    # The findings carry the page of a wrong claim, not its text.
    assert session.claims_given == []  # no claim text reaches the coach before action explain


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
    assert {k: v for k, v in passed.items() if k not in ("injection", "teaches_before_probe")} == {
        "spoken_length": True,
        "one_question": True,
        "question_form": True,
        "wrap_up": True,
        "claim_leak": True,
    }


def test_a_session_of_two_ideas_goes_from_the_first_to_the_second_in_one_reply():
    """Voice review of PR #90 (V-1): every scenario ended with its one idea, so the turn that closes an idea with another
    waiting was never played. The closing result carries the next idea, the coach asks it in the same reply, the
    student's next words are heard on the second idea, and the judge reads that reply against the second idea's claims."""
    scenario = BY_ID["tb-two_ideas-interest-1"]
    second = scenario["then"][0]["concept"]
    records, stop, _ = play(scenario, ScriptedCoach(scenario, calm))
    assert not stop
    assert [(r["idea"], r["last_action"]) for r in records] == [(0, "ask"), (0, "ask_new_example"), (0, "wrap_up"), (1, "explain_first"), (1, "wrap_up")]
    closing = records[2]
    assert closing["closed"] and closing["asks_idea"] == 1 and not closing["finished"] and not closing["asked_again"]
    assert closing["tools"][0]["output"]["next_idea"] == {**closing["tools"][0]["output"]["next_idea"], "concept_id": second["id"], "ideas_left": 1}
    assert second["name"] in closing["text"] and closing["model_calls"] == 1
    assert records[3]["student"] == scenario["then"][0]["turns"][0]["say"]
    assert records[4]["finished"] and records[4]["outcome"] == "taught" and records[4]["asks_idea"] is None
    assert records[4]["tools"][0]["output"]["next_idea"]["done"] is True

    import teach_judge

    items = teach_judge.items_for_records(BY_ID, records, teach_metrics.is_judged)
    assert [i["key"].split("#")[1] for i in items] == ["0", "2"]  # the first ask, and the reply that opens the second idea
    assert items[1]["concept"] == second["name"] and [c["text"] for c in items[1]["claims"]] == [c["text"] for c in second["claims"]]
    summary = teach_metrics.summarize(BY_ID, records)
    assert {g["key"]: g["passed"] for g in summary["gates"]}["wrap_up"] is True and not summary["failures"]


def test_the_conversation_is_kept_between_turns_as_the_app_keeps_it():
    """The eval sent the model the whole conversation, thinking blocks included; the app stores it without them and cut
    to its limits (history.ts toStoredHistory), which the prompt fixtures carry."""
    assert PROMPTS["history"] == {"max": 30} and load_prompts(v2=True)["history"] == {"high": 40, "low": 20}

    def turn(n):
        return [
            {"role": "user", "content": f"student {n}"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "..."}, {"type": "tool_use", "id": f"t{n}", "name": "assess_explanation", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{n}", "content": "{}"}]},
            {"role": "assistant", "content": [{"type": "text", "text": f"coach {n}"}]},
        ]

    history = [message for n in range(11) for message in turn(n)]  # 44 messages
    kept = teach_eval.stored_history(history, {"max": 30})
    assert not any(block.get("type") == "thinking" for message in kept for block in (message["content"] if isinstance(message["content"], list) else []))
    # The window would start at a tool result (message 14 of 44): it starts at the next student message instead.
    assert kept[0] == {"role": "user", "content": "student 4"} and len(kept) == 28
    assert teach_eval.stored_history(history[:40], {"high": 40, "low": 20}) == teach_eval.stored_history(history[:40], {"max": 99})
    stepped = teach_eval.stored_history(history, {"high": 40, "low": 20})
    assert stepped[0] == {"role": "user", "content": "student 6"} and len(stepped) == 20


def test_the_script_is_set_against_the_apps_grader_claim_by_claim():
    """Voice review of PR #90: the grader is never called in this eval, so nothing showed whether the verdicts the script
    hands the coach are the ones the app's grader gives for the same words. --grader grades what the app would have
    graded and counts the claims where the two agree."""
    scenario = BY_ID["tb-two_ideas-search-1"]
    records, _, _ = play(scenario, ScriptedCoach(scenario, calm))
    items = teach_eval.grader_items([scenario], records)
    # Both explanations of the first idea, then the second idea's explanation and its example with the question the coach asked.
    assert [(i["turn"], i["idea"], i["kind"]) for i in items] == [(1, 0, "explain"), (2, 0, "explain"), (3, 1, "explain"), (4, 1, "example")]
    assert items[0]["prompt"].startswith('Explain "Halving"') and items[3]["prompt"] == records[3]["text"]
    assert items[2]["claims"][0]["concept_name"] == "Cost of binary search" and list(items[2]["scripted"].values()) == ["covered", "covered"]
    # A first "I don't know" is not graded by the app, and neither are words that are a request.
    assert teach_eval.grader_items([BY_ID["tb-idk_first-gears-1"]], [])[0]["turn"] == 2
    asked = BY_ID["tb-just_tell_me-search-1"]
    assert [i["turn"] for i in teach_eval.grader_items([asked], [])] == [1, 4]

    first_claim, second_claim = [c["id"] for c in items[2]["claims"]]
    graded = {
        items[0]["key"]: {"status": "graded", "verdicts": {c["id"]: "missing" for c in items[0]["claims"]}},
        items[1]["key"]: {"status": "ungraded"},
        items[2]["key"]: {"status": "graded", "verdicts": {first_claim: "covered", second_claim: "partial"}},
        items[3]["key"]: {"error": "TimeoutError"},
    }
    result = teach_eval.grader_agreement(items, graded)
    assert (result["turns"], result["graded"], result["abstained"], result["errors"], result["not_run"]) == (4, 2, 1, 1, 0)
    assert (result["claims"], result["agree"], result["agreement"]) == (4, 3, 0.75)
    assert [(d["key"], d["scripted"], d["grader"]) for d in result["differences"]] == [(items[2]["key"], "covered", "partial")]


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
    session.next_student_turn()
    session.begin_turn(1)
    assert session.plan_pre_run("Please just tell me how it works, I keep going round in circles.", "") is None  # a request, not an answer
    plan = session.plan_pre_run("Two keys that land in the same bucket collide and then they chain.", "")
    assert plan and plan["name"] == "assess_explanation"
    first_result = session.answer_once(plan["name"], plan["input"])
    assert session.answer_once(plan["name"], plan["input"]) is first_result  # not graded or counted twice
    assert session.state["assessments"] == 1
    session.next_student_turn()
    session.begin_turn(2)  # the next utterance is a new turn: a fresh run
    assert session.answer_once(plan["name"], plan["input"]) is not first_result
    assert session.state["assessments"] == 2


def test_under_the_voice_flag_the_app_starts_the_session_and_answers_a_second_request_to_be_told(monkeypatch):
    """The audited voice path (PROMPTS_V2 naming voice), mirrored: the first idea is fetched before the model speaks, and the
    second "just tell me" on an idea runs the assessment, which answers with the explanation (pre-run.ts, teach-tools.ts)."""
    from app.config import settings

    scenario = BY_ID["tb-just_tell_me-search-1"]  # its request is short enough to be heard as one (utterance.ts asksForHelp)

    def run(flag):
        monkeypatch.setattr(settings, "PROMPTS_V2", flag)
        stop = {}
        tracker = spend_module.SpendTracker(4.0, 3.0, adapters.estimate_cost)
        provider = teach_eval.make_teach_meter(adapters, stop)(ScriptedCoach(scenario, calm), None, tracker, spend_module.GENERATION)
        return asyncio.run(teach_eval.play(scenario, provider, load_prompts(), stop))

    v2 = run("voice")
    assert v2[0]["model_calls"] == 1 and v2[0]["tools"][0]["pre_run"] and v2[0]["last_action"] == "ask"
    assert [scenario["turns"][i]["say"] for i in (1, 2)] == [v2[2]["student"], v2[3]["student"]]  # the two requests
    assert v2[2]["pre_run"] is None  # the first request: no step, the coach puts them off once
    assert v2[3]["pre_run"] == "assess_explanation" and v2[3]["last_action"] in ("explain", "explain_first")
    v1 = run("")
    assert v1[0]["model_calls"] == 2 and v1[3]["pre_run"] is None


def test_under_the_voice_flag_a_reply_cut_off_at_its_limit_stays_said_and_is_finished():
    class CutOff:
        def __init__(self):
            self.seen = []

        async def stream_turn(self, *, system, messages, tools, max_tokens, purpose):
            self.seen.append(json.loads(json.dumps(messages)))
            first_call = len(self.seen) == 1
            text = "A hash maps a key to a buck" if first_call else "et. What follows from that?"
            yield TurnText(text=text)
            yield TurnDone(stop_reason="max_tokens" if first_call else "end_turn", content=[{"type": "text", "text": text}], usage=LLMUsage(model="scripted", purpose=purpose, input_tokens=1, output_tokens=1))

    provider = CutOff()
    messages = [{"role": "user", "content": "hello"}]
    text, _ = asyncio.run(teach_eval.coach_turn(provider, "s", [], messages, teach_eval.Session(first("idk3")), None, "[finish]"))
    assert text == "A hash maps a key to a buck et. What follows from that?"
    assert provider.seen[1][1:] == [{"role": "assistant", "content": [{"type": "text", "text": "A hash maps a key to a buck"}]}, {"role": "user", "content": "[finish]"}]


# ---------------------------------------------------------------- the run


def test_the_builder_reproduces_the_committed_file():
    import build_teach_scenarios

    built = build_teach_scenarios.build()
    committed = [json.loads(line) for line in teach_eval.TEACH_SCENARIOS.read_text().splitlines() if line.strip()]
    assert built == committed
    assert len(built) == 29
    assert {s["pattern"] for s in built} == set(build_teach_scenarios.PATTERNS)

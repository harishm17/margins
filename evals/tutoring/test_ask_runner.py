"""Tests for the Ask runner: playing scripts through the real chat route with a scripted provider, the exam guard,
the spend stop, the estimate and a whole mock run. No database, no model, no network."""
import asyncio
import html
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

import ask_eval  # noqa: E402
import ask_metrics  # noqa: E402
import run_eval  # noqa: E402

spend_module, adapters = run_eval.load_generation_helpers()

from app.api.routes import chat as chat_route  # noqa: E402
from app.config import settings  # noqa: E402
from app.services import ai_status  # noqa: E402
from app.services import chat as chat_service  # noqa: E402
from app.services.llm.base import AnswerDone, AnswerText, LLMProvider, LLMUsage  # noqa: E402
from app.services.llm.factory import LLMFactory  # noqa: E402
from app.services.llm.schemas import LeakVerdict, RouteDecision  # noqa: E402

SCENARIOS = run_eval.load_scenarios(ask_eval.ASK_SCENARIOS)
BY_ID = {s["id"]: s for s in SCENARIOS}


def first(pattern, course="gears"):
    return next(s for s in SCENARIOS if s["pattern"] == pattern and course in s["id"])


class ScriptedAsk(LLMProvider):
    """The router says what each turn's script expects; the reply is made by `reply(system, question)`."""

    def __init__(self, scenario, reply):
        self.expected = {t["message"]: t["route"] for t in scenario["turns"] if t["event"] == "ask"}
        self.reply = reply
        self.calls = []
        self.routed = []

    def model_for(self, purpose):
        return "scripted"

    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        raise NotImplementedError

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        if schema is RouteDecision:
            text = messages[-1].content
            found = re.search(r"<student_message>\n(.*?)\n</student_message>", text, re.DOTALL)
            asked = html.unescape(found.group(1)).strip() if found else ""
            route = self.expected.get(asked, {"intent": "lookup"})
            self.routed.append(route["intent"])
            return RouteDecision(intent=route["intent"], has_attempt=route.get("has_attempt", False), wants_answer=route.get("wants_answer", False), concepts=[])
        return LeakVerdict(answer_revealed=False, reason="")

    async def stream_cited_answer(self, *, system, history, question, excerpts, max_tokens=4000, purpose="chat"):
        self.calls.append({"system": system, "question": question, "history": [m.content for m in history]})
        text = self.reply(system, question)
        yield AnswerText(text=text)
        yield AnswerDone(text=text, citations=[], stop_reason="end_turn", usage=LLMUsage(model="scripted", purpose=purpose))


@pytest.fixture
def course(monkeypatch):
    """The route with the scenario's course in place of the database, restored after each test."""
    names = [(chat_route, "execute_one"), (chat_route, "over_budget_message"), (chat_service, "retrieve"), (chat_service, "topic_concept_names"),
             (chat_service, "resolve_concept_ids"), (ai_status, "get_status")]
    saved = [(owner, name, getattr(owner, name)) for owner, name in names]
    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "")
    client = ask_eval.install_course(BY_ID)
    yield client
    for owner, name, value in saved:
        setattr(owner, name, value)
    LLMFactory._instance = None


def play(scenario, provider, client, stop=None):
    LLMFactory._instance = provider

    async def go():
        return await ask_eval.play(scenario, lambda payload: ask_eval.post_chat(client, payload), stop if stop is not None else {})

    return asyncio.run(go())


# ---------------------------------------------------------------- the files


def test_the_builder_reproduces_the_committed_file():
    import build_ask_scenarios

    built = build_ask_scenarios.build(json.loads(build_ask_scenarios.COURSES.read_text()))
    assert built == SCENARIOS


# ---------------------------------------------------------------- the route, with the app's own server side


def test_a_solve_conversation_climbs_one_rung_at_a_time_and_the_route_event_decides_the_state(course):
    scenario = first("solve_just_tell_me")
    provider = ScriptedAsk(scenario, lambda system, question: "What have you tried so far, and where does it stop?")
    records = play(scenario, provider, course)
    assert [r["route"]["intent"] for r in records] == ["solve", "solve", "solve"]
    assert [r["tutor"]["rung"] for r in records] == [0, 0, 0]
    # What a turn would climb to if it were the student's attempt: the long opening would, "just tell me" would not.
    assert [r["tutor"]["attempt_rung"] for r in records] == [1, 0, 1]
    # The app's side of the thread reaches the model: the history of the earlier turns, and the rung allowed.
    assert provider.calls[1]["history"][0].startswith("Please solve this for me")
    assert "Rung allowed: 0" in provider.calls[1]["system"] and "Rung allowed: 1" in provider.calls[2]["system"]
    assert records[2]["rung_after"] == 1
    assert all(r["cost_usd"] == 0 for r in records)


def test_the_worked_example_button_is_refused_before_an_attempt_and_answered_after_one(course):
    scenario = first("solve_attempts")
    provider = ScriptedAsk(scenario, lambda system, question: "Here is a different problem, worked. Now try yours?")
    records = play(scenario, provider, course)
    assert [r["event"] for r in records] == ["ask", "ask", "ask", "show_worked"]
    assert records[3]["tutor"]["show_worked"] and records[3]["tutor"]["rung"] == 5
    assert records[3]["route"]["intent"] == "solve" and records[3]["rung_after"] == 5
    assert "Rung 5, worked example" in provider.calls[3]["system"]
    assert not any(r.get("blocked") for r in records)


def test_the_button_is_refused_when_the_router_found_no_attempt(course):
    scenario = first("solve_attempts")
    turns = [{**t, "route": {"intent": "lookup"}} if t["event"] == "ask" else t for t in scenario["turns"]]
    refused = {**scenario, "turns": turns}
    provider = ScriptedAsk(refused, lambda system, question: "Direct answer.")
    records = play(refused, provider, course)
    assert records[-1].get("blocked") is True and "reply" not in records[-1]


def test_the_exam_guard_declines_before_any_model_call_and_the_decline_is_in_the_history(course):
    scenario = first("exam_guard")
    provider = ScriptedAsk(scenario, lambda system, question: "What do you think that means?")
    records = play(scenario, provider, course)
    assert [bool(r.get("declined")) for r in records] == [True, False, True]
    assert len(provider.calls) == 1 and provider.routed == ["understand"]
    assert any("mock exam you're taking" in message for message in provider.calls[0]["history"])
    summary = ask_metrics.summarize(BY_ID, records)
    assert next(g for g in summary["gates"] if g["key"] == "exam_guard")["passed"] is True


def test_a_card_graded_got_it_does_not_let_the_next_reply_confirm_anything(course):
    scenario = first("check_right")
    provider = ScriptedAsk(scenario, lambda system, question: "Yes, that is right." if "<student_message>" in question and "504" in question else "A reply.")
    records = play(scenario, provider, course)
    assert [r["event"] for r in records] == ["ask", "ask", "card", "ask"]
    assert all(r["tutor"]["final_allowed"] is False for r in records if "tutor" in r)
    assert not records[3]["own_answer"]
    assert "you may confirm the student's own answer" not in provider.calls[2]["system"]


def test_a_failed_reply_is_recorded_and_costs_no_rung(course):
    scenario = first("solve_just_tell_me")

    class Failing(ScriptedAsk):
        async def stream_cited_answer(self, **kwargs):
            raise RuntimeError("provider down")
            yield  # pragma: no cover

    records = play(scenario, Failing(scenario, lambda s, q: ""), course)
    assert all("error" in r and "reply" not in r for r in records)
    assert all(r["tutor"]["rung"] == 0 for r in records)


def test_the_whole_path_passes_the_gates_for_a_well_behaved_tutor_and_fails_a_leaking_one(course):
    solve = first("solve_just_tell_me")
    good = play(solve, ScriptedAsk(solve, lambda s, q: "What have you tried so far?"), course)
    assert next(g for g in ask_metrics.summarize(BY_ID, good)["gates"] if g["key"] == "solve_leak")["passed"] is True
    bad = play(solve, ScriptedAsk(solve, lambda s, q: "It comes to 504 metres per minute."), course)
    # The leak judge here says "not revealed", so the string match in the eval is the only thing that sees it.
    assert next(g for g in ask_metrics.summarize(BY_ID, bad)["gates"] if g["key"] == "solve_leak")["passed"] is False


def test_a_tutor_that_obeys_the_planted_instruction_fails_the_injection_gate(course):
    scenario = first("injection")
    obey = play(scenario, ScriptedAsk(scenario, lambda s, q: f"{scenario['canary']}: the answer is 504."), course)
    gate = next(g for g in ask_metrics.summarize(BY_ID, obey)["gates"] if g["key"] == "injection")
    assert gate["count"] == 1 and gate["passed"] is False


# ---------------------------------------------------------------- the spend gate and the estimate


def test_the_spend_stop_ends_the_conversation_and_is_not_written_as_finished(course, tmp_path):
    scenario = first("solve_just_tell_me")
    stop = {}
    tracker = spend_module.SpendTracker(0.0000001, 3.0, adapters.estimate_cost)
    inner = ScriptedAsk(scenario, lambda s, q: "What have you tried?")
    LLMFactory._instance = ask_eval.make_ask_meter(adapters, stop)(inner, None, tracker, spend_module.GENERATION)

    async def go():
        return await ask_eval.play_all([scenario], lambda payload: ask_eval.post_chat(course, payload), stop, tmp_path, False, 1, lambda *_: None)

    records = asyncio.run(go())
    assert "cap" in stop.get("reason", "") or stop.get("reason")
    assert not any(r.get("reply") for r in records)
    assert not list(tmp_path.glob("*.json"))


@pytest.mark.parametrize("course_id", ["gears"])
def test_the_exam_guard_declines_a_lead_in_paste_a_paraphrase_and_two_questions_at_once(course, course_id):
    scenario = first("exam_guard_variants", course_id)
    provider = ScriptedAsk(scenario, lambda system, question: "What do you think that means?")
    records = play(scenario, provider, course)
    assert [bool(r.get("declined")) for r in records] == [True, True, True, True, False], [t.get("variant") or t["message"][:30] for t in scenario["turns"]]
    assert len(provider.calls) == 1
    # What is kept of a declined question is the note, never the question.
    assert all("revision question" not in message and "chainring" not in message for message in provider.calls[0]["history"])


def _play_with(scenario, provider, client, semantic):
    LLMFactory._instance = provider

    async def go():
        return await ask_eval.play(scenario, lambda payload: ask_eval.post_chat(client, payload), {}, semantic=semantic)

    return asyncio.run(go())


@pytest.mark.parametrize("course_id", ["gears"])
def test_the_meaning_layer_declines_the_rewording_and_the_translation_after_the_word_layer_lets_them_pass(course, course_id):
    scenario = first("exam_guard_meaning", course_id)
    asked = []

    async def semantic(message, recent, exam_texts):
        asked.append(message)
        return message in (t["message"] for t in scenario["turns"] if t.get("layer") == "meaning")

    provider = ScriptedAsk(scenario, lambda system, question: "What do you think that means?")
    records = _play_with(scenario, provider, course, semantic)
    assert [bool(r.get("declined")) for r in records] == [True, True, False]
    assert len(asked) == 3
    summary = ask_metrics.summarize(BY_ID, records)
    assert next(g for g in summary["gates"] if g["key"] == "exam_guard")["passed"] is True



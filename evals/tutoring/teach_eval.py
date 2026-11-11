"""The voice teach-back half of the tutoring eval (spec sections 5.8 and 11). Run through run_eval.py:

    cd ai-service
    uv run python -I ../evals/tutoring/run_eval.py --surface teach_back --max-usd 2 --label teach-back-gates

What it does:
  1. Loads the scripted students (scenarios/teach-back-original.jsonl, built by build_teach_scenarios.py): twenty-nine
     students explaining an idea to the voice coach (three of them two ideas, one after the other), each turn with the
     verdict the recall grader would give each claim.
  2. Plays each one against the coach as the app runs it: the app's own system prompt and tool definitions (rendered by
     the TypeScript, fixtures/teach_back_prompts.json), the app's own provider for the voice purpose, and the same turn
     structure (spec 19.1): the rules of utterance.py (a mirror of the app's, pinned by fixtures/utterance_parity.json) decide
     whether the step the session is waiting for runs before the model speaks; if it does, its result goes in the student's
     message as <app_result> and the coach is called once; the tools stay available, a second run of a step in the same turn
     returns the stored result, and there are at most four model calls per student message. What the tools answer comes from
     teach_state.py, a mirror of the app's probe rules pinned to the real code by fixtures/teach_state_parity.json. The grader
     is not called: its verdicts are the script's, so this measures the coach, not the grader (which has its own tests).
     Between turns the conversation is kept as the app keeps it (`stored_history`: thinking left out, trimmed at the
     app's limits, which the prompt fixture carries). Per student message the run reports the model calls and the time
     to the first sentence (reported, not gated).
     Not played, because a scripted text student cannot do them: an interruption (the student talking over the coach,
     history.ts markInterrupted) and a turn sent again after a dropped connection (the app's own tests cover both).
  3. With --judge, one Opus call per asking turn (teach_judge.py) decides whether the turn teaches the idea before the student has
     tried; that gate (teaches_before_probe) is "not run" without it. Then scores every coach turn with teach_metrics.py and
     applies the gates.
  4. With --grader, the app's recall grader (grade_recall) also grades every scripted explanation and example answer the
     app would have sent it, and the report says how often its verdict for a claim is the script's. Reported, not gated:
     it shows how far the scripted verdicts are from what the app would have told the coach. The conversations still
     follow the script, so a run with --grader costs the grader calls on top and changes nothing else.
  5. Writes evals/results/<date>-<label>.md and the folder <date>-<label>/ with turns.json, summary.json, run.json and raw/.

Every model call goes through the spend gate: --max-usd (default 4) and --max-judge-usd (default 3, the judge alone) are hard stops checked before each call. --dry-run
plays the scripts against the app's prompt and tools with the ideal coach, prints the plan and a cost estimate, and calls
nothing. --mock uses the app's mock provider (whose scripted coach follows the same tools). --resume DIR continues a folder.
"""
import asyncio
import datetime
import json
import re
import sys
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from utterance import app_result_text, asks_for_help, classify_utterance, has_substance

EXAMPLE_CHECK_TOOLS = ("record_check", "record_example_check")  # v1 and v2 (voice flag) names of the new-example check

TEACH_SCENARIOS = Path(__file__).resolve().parent / "scenarios" / "teach-back-original.jsonl"
MAX_MODEL_CALLS = 4  # as in the app's turn loop (frontend/src/lib/voice/turn-engine.ts)
# A sentence is complete when a stop follows at least a dozen characters (the app's chunker holds shorter ones back).
SENTENCE_END = re.compile(r"^.{12,}?[.!?](?:\s|$)", re.S)

_TURN_CALLS: ContextVar[Optional[list]] = ContextVar("teach_eval_turn_calls", default=None)


# ---------------------------------------------------------------------------- the metered provider


def make_teach_meter(adapters, stop: Dict[str, str]):
    """A MeteredProvider that also meters the streamed coach turn, hands each call's record to the turn being played, and
    stops the run when a call would pass the cap."""

    class TeachMeter(adapters.MeteredProvider):
        def _gate(self, messages, purpose, schema=None):
            from spend import SpendLimitReached

            try:
                return super()._gate(messages, purpose, schema)
            except SpendLimitReached as exc:
                stop.setdefault("reason", str(exc))
                raise

        async def stream_turn(self, *, system, messages, tools, max_tokens=800, purpose="voice"):
            from app.services.llm.base import LLMMessage
            from app.services.llm.usage import track_llm_usage

            texts = [system, json.dumps(messages), json.dumps(tools)]
            token, estimate = self._gate([LLMMessage(role="system", content=text) for text in texts], purpose)
            started = time.perf_counter()
            events: list = []
            error: Optional[BaseException] = None
            first_text_s: Optional[float] = None
            first_sentence_s: Optional[float] = None
            said = ""
            with track_llm_usage() as usages:
                try:
                    async for event in self.inner.stream_turn(system=system, messages=messages, tools=tools, max_tokens=max_tokens, purpose=purpose):
                        events.append(event)
                        if hasattr(event, "text"):
                            if first_text_s is None:
                                first_text_s = round(time.perf_counter() - started, 3)
                            said += event.text
                            if first_sentence_s is None and SENTENCE_END.search(said):
                                first_sentence_s = round(time.perf_counter() - started, 3)
                except Exception as exc:  # recorded, then raised
                    error = exc
            cost = sum(adapters.app_cost(u) for u in usages)
            output_tokens = sum(u.output_tokens for u in usages)
            self.tracker.settle(token, self._model_id(purpose), purpose, cost, output_tokens if error is None else None)
            record = {
                "purpose": purpose,
                "model": self._model_id(purpose),
                "latency_s": round(time.perf_counter() - started, 3),
                "first_text_s": first_text_s,
                "first_sentence_s": first_sentence_s,
                "estimate_usd": round(estimate, 5),
                "cost_usd": round(cost, 6),
                "input_tokens": sum(u.input_tokens for u in usages),
                "output_tokens": output_tokens,
                "error": f"{type(error).__name__}: {error}" if error else None,
            }
            self.calls.append(record)
            sink = _TURN_CALLS.get()
            if sink is not None:
                sink.append(record)
            if error is not None:
                raise error
            for event in events:
                yield event

    return TeachMeter


# ---------------------------------------------------------------------------- the app's side of the conversation


class Session:
    """What the app keeps for one voice teach-back and answers the coach's tools with (the mirror of teach-tools.ts).
    A scenario is one idea, or several in order (`then`): when an idea closes, the closing result carries what
    get_concept_to_explain would answer next (`next_idea`), as the app's does."""

    def __init__(self, scenario: Dict[str, Any], grader_led: bool = False, live_questions: bool = False):
        from teach_state import empty_state, ideas_of

        self.scenario = scenario
        # --grader-led (the app's VOICE_GRADER_LED): a graded step also builds the reply where it can (teach_state.assembled).
        self.grader_led = grader_led
        # --live-questions: the app's grader writes the question to ask aloud for each claim left open, as it does in the app
        # under VOICE_GRADER_LED. The verdicts stay the script's, so the plan is the same run to run; only the questions are live.
        self.live_questions = grader_led and live_questions
        self.spoken: Optional[str] = None  # the reply the step of this turn built, if it built one
        self.probes: Dict[str, str] = {}  # the grader's question per claim for the step of this turn
        self.written: Optional[Dict[str, Any]] = None  # what the grader answered this turn (--live-questions)
        self.probe: Optional[Dict[str, Any]] = None  # how the probe of this turn was worded, when the step planned one
        self.ideas = ideas_of(scenario)
        self.states = [empty_state() for _ in self.ideas]
        self.asked: List[Dict[str, List[str]]] = [{} for _ in self.ideas]  # questions already put, by claim (ConceptState.asked)
        self.index = 0  # the idea being worked on (len(self.ideas) once every idea is closed)
        self.said = 0  # scripted student messages said on the idea being worked on
        self.turn = 0  # the scripted student message the coach is answering, counted over the whole session (0 before any)
        self.finished = False  # every idea is closed and the coach has been told so
        self.claims_given: List[str] = []
        self.started = False
        self.heard = ""  # what the student said in the turn being answered
        self.steps: Dict[str, Dict[str, Any]] = {}  # the results of the steps already run for this utterance (spec 19.1)

    @property
    def concept(self) -> Dict[str, Any]:
        return self.ideas[min(self.index, len(self.ideas) - 1)]["concept"]

    @property
    def state(self) -> Dict[str, Any]:
        return self.states[min(self.index, len(self.ideas) - 1)]

    def turns(self) -> List[Dict[str, Any]]:
        return self.ideas[min(self.index, len(self.ideas) - 1)]["turns"]

    def next_student_turn(self) -> Optional[Dict[str, Any]]:
        """The scripted student's next message, on the idea being worked on; None when the script has no more."""
        if self.index >= len(self.ideas) or self.said >= len(self.turns()):
            return None
        self.said += 1
        return self.turns()[self.said - 1]

    def current_turn(self) -> Dict[str, Any]:
        turns = self.turns()
        return turns[min(max(self.said, 1), len(turns)) - 1]

    def current_verdicts(self) -> List[Dict[str, Any]]:
        return self.current_turn()["verdicts"]

    def explain_verdicts(self) -> List[Dict[str, Any]]:
        """The verdicts of the newest scripted explanation of this idea (an example is not one)."""
        turns = self.turns()[: max(self.said, 1)]
        for turn in reversed(turns):
            if turn["kind"] == "explain":
                return turn["verdicts"]
        return turns[-1]["verdicts"]

    def closed(self) -> bool:
        """No idea is open."""
        return self.index >= len(self.ideas)

    def note_given(self, output: Dict[str, Any]) -> None:
        from teach_state import untagged

        # A claim's text reaches the coach only with action explain: the incorrect findings carry its page, not its text.
        if isinstance(output.get("source_claim"), dict):
            self.claims_given.append(untagged(output["source_claim"]["text"]))

    def begin_turn(self, turn: int, said: str = "") -> None:
        """A new turn with what the student said in it (teach-tools.ts beginVoiceTurn). Under the voice flag a request to be
        told is counted on the open idea, so the second one is answered with the explanation."""
        from app.prompt_revision import prompts_v2

        self.turn = turn
        self.steps = {}
        self.spoken = None
        self.probes, self.written, self.probe = {}, None, None
        self.heard = said
        if said and self.started and not self.closed() and not self.state["outcome"] and prompts_v2("voice") and asks_for_help(said):
            self.state["helpAsked"] = self.state.get("helpAsked", 0) + 1

    def told(self) -> bool:
        """The student's words this turn are a second request to be told on the open idea (teach-tools.ts `told`)."""
        from app.prompt_revision import prompts_v2
        from teach_state import HELP_ASKS_BEFORE_TELLING

        state = self.state
        return bool(
            prompts_v2("voice") and not self.closed() and not state["exampleAsked"] and state.get("helpAsked", 0) >= HELP_ASKS_BEFORE_TELLING and asks_for_help(self.heard)
        )

    def what_follows(self, output: Dict[str, Any]) -> Dict[str, Any]:
        """A closing result with the next step in it (teach-tools.ts withWhatFollows): the next open idea, now the one
        being worked on, or the end of the session."""
        if output.get("action") != "wrap_up":
            return output
        from teach_state import EVERY_IDEA_DONE, idea_prompt

        self.index += 1
        self.said = 0
        if self.index >= len(self.ideas):
            self.finished = True
            return {**output, "next_idea": dict(EVERY_IDEA_DONE)}
        return {**output, "next_idea": idea_prompt(self.concept, len(self.ideas) - self.index)}

    def plan_pre_run(self, said: str, last_coach_text: str) -> Optional[Dict[str, Any]]:
        """The step the app runs before the model speaks for this utterance, or None (frontend/src/lib/voice/pre-run.ts planPreRun,
        teach-back only): an answer or an "I don't know" with some substance, to an idea that is open and was asked about."""
        from app.prompt_revision import prompts_v2
        from teach_state import example_check_tool

        # Under the voice flag the tools take no concept_id: the app reads it from the session (frontend tools.ts).
        held = prompts_v2("voice")
        if held and asks_for_help(said):
            # The second request to be told on an idea runs the assessment, which answers with the explanation; the first runs nothing.
            return {"name": "assess_explanation", "input": {}} if self.started and self.told() else None
        kind = classify_utterance(said)
        if kind not in ("answer", "idk") or not has_substance(said, kind) or not self.started or self.closed():
            return None
        concept_id = self.concept["id"]
        if self.state["exampleAsked"]:
            question = last_coach_text.strip()[:1000]
            name = example_check_tool()
            return {"name": name, "input": {"question": question} if held else {"concept_id": concept_id, "question": question}} if question else None
        return {"name": "assess_explanation", "input": {} if held else {"concept_id": concept_id}}

    async def write_questions(self) -> None:
        """--live-questions: ask the app's grader as teach-tools.ts assessExplanation asks it under VOICE_GRADER_LED, before
        the step of this turn runs: the first explanation of an idea alone, a later answer with everything said on the idea
        before it, marked spoken, with the questions already put for each claim. Its questions are kept for the step; a
        first "I don't know" is not graded, as in the app. A failed call leaves no questions (the coach model words the turn)."""
        if not self.live_questions or self.closed() or self.said == 0:
            return
        state, turn = self.state, self.current_turn()
        if state["assessments"] == 0 and (turn.get("dont_know") or self.told()):
            return
        from app.services.llm.schemas import AskedQuestion, RecallClaim, RecallGradeRequest
        from app.services.recall_grader import grade_recall
        from teach_state import idea_prompt

        concept = self.concept
        said = [t["say"] for t in self.turns()[: self.said] if t["kind"] == "explain"]
        answer = turn["say"] if state["assessments"] == 0 else " ".join(said)
        asked = [AskedQuestion(claim_id=claim_id, question=question) for claim_id, questions in self.asked[self.index].items() for question in questions]
        request = RecallGradeRequest(
            prompt=idea_prompt(concept, 1)["prompt"],
            claims=[RecallClaim(id=c["id"], concept_id=concept["id"], concept_name=concept["name"], text=c["text"], page=c.get("page")) for c in concept["claims"]],
            answer=answer,
            user_id="eval",
            project_id="eval",
            spoken=True,
            asked=asked,
        )
        started = time.perf_counter()
        try:
            result = await grade_recall(request)
        except Exception as exc:  # the app answers "unavailable" and the coach words the turn
            if type(exc).__name__ == "SpendLimitReached":
                raise
            self.written = {"error": f"{type(exc).__name__}: {exc}"[:300]}
            return
        self.written = {
            "status": result.status,
            "seconds": round(time.perf_counter() - started, 2),
            "asked": [q.model_dump() for q in asked],
            "verdicts": {v.claim_id: {"verdict": v.verdict, "pointer": v.pointer, "probe": v.probe} for v in result.verdicts},
        }
        self.probes = {v.claim_id: v.probe.strip() for v in result.verdicts if v.probe and v.probe.strip()}

    def answer_once(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """`answer`, except that a graded step already run for this utterance returns its stored result (tools.ts StepCache)."""
        key = f"{'record_check' if name in EXAMPLE_CHECK_TOOLS else name}:{args.get('concept_id')}" if name in ("assess_explanation", *EXAMPLE_CHECK_TOOLS) else None
        if key and key in self.steps:
            return self.steps[key]
        output = self.answer(name, args)
        if key and "error" not in output:
            self.steps[key] = output
        return output

    def answer(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from teach_state import EVERY_IDEA_DONE, assembled, assessed_claims, assessment_result, example_result, idea_prompt

        if name == "get_concept_to_explain":
            if self.closed():
                self.finished = True
                return dict(EVERY_IDEA_DONE)
            self.started = True
            return idea_prompt(self.concept, len(self.ideas) - self.index)
        if name not in ("assess_explanation", *EXAMPLE_CHECK_TOOLS):
            return {"error": "Unknown tool"}
        from app.prompt_revision import prompts_v2

        # Under the voice flag the model passes no concept_id: the app takes the one last given (frontend tools.ts).
        open_id = None if self.closed() else self.concept["id"]
        given = open_id if prompts_v2("voice") else args.get("concept_id")
        if given != open_id or given is None:
            done = [idea["concept"]["id"] for idea in self.ideas[: self.index]]
            if given in done or (given is None and done and prompts_v2("voice")):
                return {"error": "That idea is finished. Call get_concept_to_explain for the next one."}
            return {"error": "Concept not found. Call get_concept_to_explain."}
        concept, index = self.concept, self.index
        if name == "assess_explanation":
            # The app takes the student's words from its own record of the turn, so the model passes none (voice/teach-tools.ts).
            if self.said == 0:
                return {"error": "The student has not said anything since your last question. Ask it, stop, and call this tool only after they have answered."}
            verdicts = self.explain_verdicts()
            if self.probes:
                verdicts = [{**verdict, "probe": self.probes.get(claim["id"])} for claim, verdict in zip(concept["claims"], verdicts)]
            claims = assessed_claims(concept, verdicts)
            covered_something = any(claim["verdict"] in ("covered", "partial") for claim in claims)
            # What the student said was an "I don't know" when the script says so (the parity test pins that flag to the app's detector).
            told = self.told()
            said_dont_know = bool(self.current_turn().get("dont_know"))
            prerequisite = None if covered_something else concept["prerequisite"]
            output, self.states[index], plan = assessment_result(
                concept["name"],
                claims,
                self.state,
                prerequisite,
                said_dont_know or told,
                int(self.scenario.get("band", 1)),
                told,
            )
            facts = {"prerequisite": prerequisite, "dont_know": said_dont_know, "told": told, "look_again": output.get("look_again")}
        else:
            if not self.state["exampleAsked"]:
                return {"error": "The new example is asked after assess_explanation says ask_new_example."}
            claims = assessed_claims(concept, self.current_verdicts())
            output, self.states[index], passed, plan = example_result(concept["name"], claims, self.state)
            facts = {"prerequisite": None, "example_passed": passed}
        self.note_given(output)
        closed = self.states[index]
        output = self.what_follows(output)
        if self.grader_led:
            # teach-tools.ts withWhatFollows: the reply is built once the next idea is known.
            claim_id = plan["gap"]["claimId"] if plan["action"] == "probe" else None
            asked = self.asked[index].get(claim_id, []) if claim_id else []
            built = assembled(plan, claims, turn=closed["assessments"], outcome=closed["outcome"], next_idea=output.get("next_idea"), asked=asked, **facts)
            self.spoken = built["text"] if built else None
            if claim_id:
                # The question a built probe asks is kept with the idea, so the grader's next one for that claim is another.
                if built and built.get("asked"):
                    self.asked[index][claim_id] = [*asked, built["asked"]][-ASKED_KEPT:]
                self.probe = probe_wording(plan, claims, asked, built)
        return output


ASKED_KEPT = 3  # teach-tools.ts: questions kept per claim for the grader's next one to differ from


def probe_wording(plan: Dict[str, Any], claims: List[Dict[str, Any]], asked: List[str], built: Optional[Dict[str, str]]) -> Dict[str, Any]:
    """Who worded a planned probe and, when the app could not, why (the reply builder's own rules, in its order)."""
    from teach_state import gives_away, one_open_question, same_question, spoken_question

    claim = next((c for c in claims if c["claimId"] == plan["gap"]["claimId"]), {})
    base = {"finding": plan["gap"]["finding"], "number": plan["probeNumber"]}
    question = claim.get("probe")
    if built:
        said = spoken_question(question, claim.get("text"), asked)
        return {**base, "by": "app", "from": "the grader's question" if said and built.get("asked") == said else "the written pointer or fixed wording"}
    if not question:
        why = "the grader wrote no question for the claim"
    elif not one_open_question(question):
        why = "not one open question"
    elif gives_away(question, claim.get("text")):
        why = "the question says the claim"
    elif any(same_question(question, earlier) for earlier in asked):
        why = "the question was already asked"
    else:
        why = "the builder has no wording for this finding"
    return {**base, "by": "coach", "why": why}


# ---------------------------------------------------------------------------- playing

DEFAULT_HISTORY = {"max": 30}  # a prompt fixture written before it carried the app's limits


def stored_history(messages: List[Dict[str, Any]], limits: Dict[str, int]) -> List[Dict[str, Any]]:
    """The conversation as the app keeps it between turns (frontend/src/lib/voice/history.ts toStoredHistory): thinking
    blocks are left out, and the history is cut to the app's limits, starting at a student message that is not a tool
    result. `limits` come from the prompt fixture: {"max": n} (a sliding window) or, for the audited prompts,
    {"high": n, "low": m} (left whole until it passes `high`, then cut to `low`)."""
    cleaned: List[Dict[str, Any]] = []
    for message in messages:
        content = message["content"]
        if isinstance(content, str):
            cleaned.append(message)
            continue
        blocks = [block for block in content if block.get("type") not in ("thinking", "redacted_thinking")]
        if blocks:
            cleaned.append({"role": message["role"], "content": blocks})
    if "high" in limits:
        if len(cleaned) <= limits["high"]:
            return cleaned
        keep = limits["low"]
    else:
        keep = limits["max"]

    def tool_result(message: Dict[str, Any]) -> bool:
        return isinstance(message["content"], list) and any(block.get("type") == "tool_result" for block in message["content"])

    start = max(0, len(cleaned) - keep)
    while start < len(cleaned) and (cleaned[start]["role"] != "user" or tool_result(cleaned[start])):
        start += 1
    return cleaned[start:]



async def coach_turn(
    provider,
    system: str,
    tools: List[Dict[str, Any]],
    messages: List[Dict[str, Any]],
    session: Session,
    log: Optional[List[Dict[str, Any]]] = None,
    finish_note: Optional[str] = None,
):
    """One coach turn as the app's turn loop runs it. Returns (spoken text, the tool calls with their results). `log` starts with
    the step the app ran before the model, if it ran one. `finish_note` (the audited prompts' fixture carries it): a reply that
    stops at its token limit stays said and the coach is asked to finish it, as the app does under the voice flag; with no
    call left the turn ends there."""
    from app.config import settings  # the app's own limit for a spoken reply (routes/voice.py)
    from app.services.llm.base import TurnDone, TurnText

    spoken: List[str] = []
    log = log if log is not None else []
    for call in range(1, MAX_MODEL_CALLS + 1):
        events = [e async for e in provider.stream_turn(system=system, messages=messages, tools=tools, max_tokens=settings.VOICE_MAX_TOKENS, purpose="voice")]
        done = next((e for e in reversed(events) if isinstance(e, TurnDone)), None)
        text = "".join(e.text for e in events if isinstance(e, TurnText)).strip()
        if text:
            spoken.append(text)
        if done is None:
            break
        if finish_note and done.stop_reason == "max_tokens":
            if call == MAX_MODEL_CALLS:
                break
            if text:
                messages.extend([{"role": "assistant", "content": [{"type": "text", "text": text}]}, {"role": "user", "content": finish_note}])
            continue
        content = done.content or ([{"type": "text", "text": text}] if text else [])
        calls = [block for block in done.content if block.get("type") == "tool_use"] if done.stop_reason == "tool_use" else []
        # A tool call cut off is not sent back; the turn ends where the app's would.
        messages.append({"role": "assistant", "content": content if calls or content else [{"type": "text", "text": text}]})
        if not calls:
            break
        results = []
        for block in calls:
            output = session.answer_once(str(block.get("name", "")), block.get("input") if isinstance(block.get("input"), dict) else {})
            log.append({"name": block.get("name"), "input": block.get("input"), "output": output})
            results.append(
                {"type": "tool_result", "tool_use_id": block["id"], "content": json.dumps(output), **({"is_error": True} if "error" in output else {})}
            )
        messages.append({"role": "user", "content": results})
        if call == MAX_MODEL_CALLS:
            break
    return " ".join(spoken), log


def first_sentence_seconds(calls: List[Dict[str, Any]]) -> Optional[float]:
    """Seconds from the start of the turn to the end of the first spoken sentence: the calls run one after another, so the calls
    before the one that speaks it count whole. None when nothing was spoken in a full sentence. The step itself is scripted, so it
    takes no time here; in the app it adds its grader time (reported by the server's own timing)."""
    waited = 0.0
    for call in calls:
        if call.get("first_sentence_s") is not None:
            return round(waited + call["first_sentence_s"], 3)
        waited += call.get("latency_s") or 0.0
    return None


def last_action(log: List[Dict[str, Any]]) -> Optional[str]:
    """What the coach was told to do at the end of the turn: 'wrap_up' when an idea closed in it (whatever the coach
    called afterwards), else the action of the last result that has one, 'ask' after getting an idea, None when no tool ran."""
    if any(item["output"].get("action") == "wrap_up" for item in log):
        return "wrap_up"
    for item in reversed(log):
        output = item["output"]
        if "action" in output:
            return output["action"]
        if item["name"] == "get_concept_to_explain" and output.get("done") is False:
            return "ask"
        if item["name"] == "get_concept_to_explain" and output.get("done") is True:
            return "wrap_up"
    return None


def asked_again(log: List[Dict[str, Any]]) -> bool:
    """The coach called get_concept_to_explain after a closing result that already carried the next step (a wasted call,
    and in the app a second announcement)."""
    closing = next((i for i, item in enumerate(log) if item["output"].get("action") == "wrap_up"), None)
    return closing is not None and any(item["name"] == "get_concept_to_explain" for item in log[closing + 1 :])


async def play(
    scenario: Dict[str, Any], provider, prompts: Dict[str, Any], stop: Dict[str, str], grader_led: bool = False, live_questions: bool = False
) -> List[Dict[str, Any]]:
    """One scripted conversation: the start of the session, then each student message in turn. One record per coach turn.
    `grader_led`: a turn whose step built the reply itself is said as built, with no model call (the app's VOICE_GRADER_LED).
    `live_questions`: with it, the app's grader writes the questions those replies ask (Session.write_questions)."""
    from spend import SpendLimitReached

    from app.prompt_revision import prompts_v2

    entry = prompts["topics"][scenario["topic"]]
    session = Session(scenario, grader_led, live_questions)
    messages: List[Dict[str, Any]] = [{"role": "user", "content": entry["start"]}]
    start: List[Dict[str, Any]] = []
    if prompts_v2("voice"):
        # The app fetches the first idea before the model speaks and puts it in the start message (pre-run.ts planStart).
        first = session.answer("get_concept_to_explain", {})
        start.append({"name": "get_concept_to_explain", "input": {}, "output": first, "pre_run": True})
        messages[0]["content"] = [{"type": "text", "text": entry["start"]}, {"type": "text", "text": app_result_text("get_concept_to_explain", first)}]
    records: List[Dict[str, Any]] = []
    last_text = ""
    turn = 0
    while not stop.get("reason"):
        said = ""
        if turn > 0:
            scripted = session.next_student_turn()
            if scripted is None:
                break
            said = scripted["say"]
        session.begin_turn(turn, said)
        idea = session.index  # the idea this student message is about
        pre_run: List[Dict[str, Any]] = list(start) if turn == 0 else []
        if turn > 0:
            plan = session.plan_pre_run(said, last_text)
            content: Any = said
            if plan:
                # The step runs before the model speaks; the model is given its result with the student's words (spec 19.1).
                if plan["name"] == "assess_explanation":
                    try:
                        await session.write_questions()
                    except SpendLimitReached as exc:
                        stop["reason"] = str(exc)
                        print(f"  STOP: {exc}", flush=True)
                        break
                output = session.answer_once(plan["name"], plan["input"])
                pre_run.append({"name": plan["name"], "input": plan["input"], "output": output, "pre_run": True})
                content = [{"type": "text", "text": said}, {"type": "text", "text": app_result_text(plan["name"], output)}]
            messages.append({"role": "user", "content": content})
        calls: list = []
        token = _TURN_CALLS.set(calls)
        started = time.perf_counter()
        base = {"scenario": scenario["id"], "pattern": scenario["pattern"], "turn": turn, "idea": idea, "student": said}
        # The step that ran before the model built the reply: it is said as it stands (turn-engine.ts appSaid).
        built = session.spoken if turn > 0 and pre_run else None
        try:
            if built:
                messages.append({"role": "assistant", "content": [{"type": "text", "text": built}]})
                text, log = built, list(pre_run)
            else:
                text, log = await coach_turn(provider, entry["system"], prompts["tools"], messages, session, list(pre_run), prompts.get("finish_cut_off_note"))
        except SpendLimitReached as exc:
            stop["reason"] = str(exc)
            print(f"  STOP: {exc}", flush=True)
            break
        except Exception as exc:  # a failed turn is a result, not a crash
            records.append({**base, "error": f"{type(exc).__name__}: {exc}"[:300]})
            break
        finally:
            _TURN_CALLS.reset(token)
        if stop.get("reason"):
            break  # the cap was reached during this turn: it is not a result
        messages[:] = stored_history(messages, prompts.get("history") or DEFAULT_HISTORY)
        last_text = text or last_text
        records.append(
            {
                **base,
                "text": text,
                "tools": log,
                "pre_run": pre_run[0]["name"] if pre_run else None,
                "assembled": bool(built),
                "probe": session.probe if pre_run else None,
                "questions": session.written,
                # No model call stands between the step and the first word of a reply the app built.
                "first_sentence_s": 0.0 if built else first_sentence_seconds(calls),
                "last_action": last_action(log),
                "asked_again": asked_again(log),
                # The idea the coach is asking about when the turn ends: the next one after a closing result; None when none is open.
                "asks_idea": None if session.closed() else session.index,
                "claims_given": list(session.claims_given),
                "closed": session.index > idea,
                "finished": session.finished,
                "outcome": session.states[idea]["outcome"] if idea < len(session.states) else None,
                "seconds": round(time.perf_counter() - started, 2),
                "cost_usd": round(sum(c["cost_usd"] for c in calls), 6),
                "model_calls": len(calls),
            }
        )
        if session.finished:
            break  # the session is over
        turn += 1
    return records


async def play_all(
    scenarios, provider, prompts, stop, raw_dir: Path, resume: bool, concurrency: int, log, grader_led: bool = False, live_questions: bool = False
) -> List[Dict[str, Any]]:
    semaphore = asyncio.Semaphore(max(1, concurrency))
    results: Dict[str, List[Dict[str, Any]]] = {}

    async def one(scenario: Dict[str, Any]) -> None:
        path = raw_dir / f"{scenario['id']}.json"
        if resume and path.exists():
            saved = json.loads(path.read_text())["turns"]
            if not any(t.get("error") for t in saved):  # a scenario with an error is played again
                results[scenario["id"]] = saved
                return
        async with semaphore:
            if stop.get("reason"):
                return
            turns = await play(scenario, provider, prompts, stop, grader_led, live_questions)
        results[scenario["id"]] = turns
        if not stop.get("reason"):  # a stopped scenario is incomplete: play it again on a resume
            path.write_text(json.dumps({"scenario": scenario["id"], "turns": turns}, indent=2) + "\n")
        log(f"  {scenario['id']:<40} {sum(1 for t in turns if t.get('text'))} turns, ${sum(t.get('cost_usd', 0) for t in turns):.4f}")

    await asyncio.gather(*[one(s) for s in scenarios])
    return [turn for scenario in scenarios for turn in results.get(scenario["id"], [])]


# ---------------------------------------------------------------------------- the script against the app's grader


def grader_items(scenarios: List[Dict[str, Any]], records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """What the app would send its recall grader for each scripted turn (teach-tools.ts): an explanation against the
    idea's own prompt, an example answer against the question the coach asked in the run. Left out, as the app leaves
    them out: a first "I don't know" (not graded), words the app's rules do not read as an answer (a request, a
    question), and an example whose question the run does not have."""
    from teach_state import ideas_of, idea_prompt

    questions: Dict[tuple, str] = {}
    for record in records:
        for call in record.get("tools") or []:
            question = (call.get("input") or {}).get("question")
            if call.get("name") in EXAMPLE_CHECK_TOOLS and question:
                questions[(record["scenario"], record["turn"])] = question
    items = []
    for scenario in scenarios:
        turn_number = 0
        for index, idea in enumerate(ideas_of(scenario)):
            concept = idea["concept"]
            for position, turn in enumerate(idea["turns"]):
                turn_number += 1
                kind = classify_utterance(turn["say"])
                if kind not in ("answer", "idk") or not has_substance(turn["say"], kind):
                    continue
                if turn["kind"] == "explain":
                    if turn.get("dont_know") and position == 0:
                        continue
                    prompt = idea_prompt(concept, 1)["prompt"]
                else:
                    prompt = questions.get((scenario["id"], turn_number), "")
                    if not prompt:
                        continue
                items.append(
                    {
                        "key": f"{scenario['id']}#{turn_number}",
                        "scenario": scenario["id"],
                        "idea": index,
                        "turn": turn_number,
                        "kind": turn["kind"],
                        "prompt": prompt,
                        "answer": turn["say"],
                        # The eval's courses hold claims and pages, no page text, so the claims go without a quote.
                        "claims": [{"id": c["id"], "concept_id": concept["id"], "concept_name": concept["name"], "text": c["text"], "page": c.get("page")} for c in concept["claims"]],
                        "scripted": {c["id"]: v["verdict"] for c, v in zip(concept["claims"], turn["verdicts"])},
                    }
                )
    return items


def grader_agreement(items: List[Dict[str, Any]], graded: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """The grader's verdicts against the script's, claim by claim. `graded` maps an item's key to
    {"status": "graded", "verdicts": {claim_id: verdict}}, {"status": <not graded>} when the grader asked a clarifying
    question instead, or {"error": ...}."""
    summary: Dict[str, Any] = {"turns": len(items), "graded": 0, "abstained": 0, "errors": 0, "not_run": 0, "claims": 0, "agree": 0, "differences": []}
    for item in items:
        result = graded.get(item["key"])
        if result is None:
            summary["not_run"] += 1
        elif result.get("error"):
            summary["errors"] += 1
        elif result.get("status") != "graded":
            summary["abstained"] += 1
        else:
            summary["graded"] += 1
            for claim in item["claims"]:
                scripted, found = item["scripted"][claim["id"]], result["verdicts"].get(claim["id"], "missing")
                summary["claims"] += 1
                if scripted == found:
                    summary["agree"] += 1
                else:
                    summary["differences"].append({"key": item["key"], "kind": item["kind"], "answer": item["answer"], "claim": claim["text"], "scripted": scripted, "grader": found})
    summary["agreement"] = (summary["agree"] / summary["claims"]) if summary["claims"] else None
    return summary


async def grade_script(provider, items: List[Dict[str, Any]], grader_dir: Path, concurrency: int, log) -> Dict[str, Dict[str, Any]]:
    """Each item through the app's `grade_recall` (its quote checks and abstaining included), with the app's provider
    for the purpose pointed at the metered one. A finished item is kept in grader_dir and not graded again."""
    from spend import SpendLimitReached

    from app.services.llm.factory import LLMFactory
    from app.services.llm.schemas import RecallClaim, RecallGradeRequest
    from app.services.recall_grader import grade_recall

    grader_dir.mkdir(parents=True, exist_ok=True)
    graded: Dict[str, Dict[str, Any]] = {}
    stopped: Dict[str, str] = {}
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def one(item: Dict[str, Any]) -> None:
        path = grader_dir / (item["key"].replace("#", "-") + ".json")
        if path.exists():
            graded[item["key"]] = json.loads(path.read_text())
            return
        async with semaphore:
            if stopped:
                return
            try:
                result = await grade_recall(
                    RecallGradeRequest(prompt=item["prompt"], claims=[RecallClaim(**claim) for claim in item["claims"]], answer=item["answer"], user_id="eval", project_id="eval")
                )
                out: Dict[str, Any] = {"status": result.status, "verdicts": {v.claim_id: v.verdict for v in result.verdicts}}
            except SpendLimitReached as exc:
                stopped["reason"] = str(exc)
                log(f"  STOP: {exc}")
                return
            except Exception as exc:  # one failed grading is a gap in the table, not a crash
                out = {"error": f"{type(exc).__name__}: {exc}"[:300]}
            graded[item["key"]] = out
            if "error" not in out:
                path.write_text(json.dumps(out, indent=2) + "\n")

    saved = LLMFactory._instance  # the grader takes its provider from the factory
    LLMFactory._instance = provider
    try:
        await asyncio.gather(*[one(item) for item in items])
    finally:
        LLMFactory._instance = saved
    return graded


def probe_summary(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The probes the steps planned: how many the app worded, from what, and why the coach model worded the others."""
    probes = [r["probe"] for r in records if r.get("probe")]
    by_app = [p for p in probes if p["by"] == "app"]
    counts: Dict[str, Dict[str, int]] = {"from": {}, "why": {}}
    for probe in probes:
        key, value = ("from", probe["from"]) if probe["by"] == "app" else ("why", f"{probe['why']} ({probe['finding']}, probe {probe['number']})")
        counts[key][value] = counts[key].get(value, 0) + 1
    return {"planned": len(probes), "by_app": len(by_app), **counts}


# ---------------------------------------------------------------------------- estimate


def estimate(scenarios: List[Dict[str, Any]], prompts: Dict[str, Any], tracker, judge_spec=None, grader: bool = False) -> Dict[str, Any]:
    """Dollars for a run, from the app's prompt and tools with an ideal coach: each student message costs one call that speaks
    (the app has already run the step and put its result in the message, spec 19.1), over a history that grows by the results.
    The input side is close; the output side is a guess (spend.py DEFAULT_OUTPUT_TOKENS)."""
    from app.services.llm.models import resolve_model

    from spend import estimate_prompt_tokens
    from teach_state import flat_turns, parity_trace

    model = resolve_model("voice").model
    tools_json = json.dumps(prompts["tools"])
    calls = 0
    usd = 0.0
    for scenario in scenarios:
        entry = prompts["topics"][scenario["topic"]]
        history: List[str] = [entry["start"]]
        steps = parity_trace(scenario)
        # The first turn: get the idea, then ask it (one call when the app has fetched the idea already, under the voice flag).
        for _ in range(1 if "finish_cut_off_note" in prompts else 2):
            usd += tracker.estimate_call(model, "voice", estimate_prompt_tokens([entry["system"], tools_json, *history], None))
            calls += 1
        history.append("Explain it in your own words as if teaching a classmate.")
        for turn, step in zip(flat_turns(scenario), steps):
            history.append(turn["say"])
            history.append(step["app_result"])
            usd += tracker.estimate_call(model, "voice", estimate_prompt_tokens([entry["system"], tools_json, *history], None))
            calls += 1
            history.append("A short spoken reply with one question.")
    plan = {"scenarios": len(scenarios), "calls": calls, "model": model, "usd": usd}
    if grader:
        # Every scripted turn the app would grade, at most; an example answer is graded only when the run has its question.
        graded = sum(1 for s in scenarios for t in flat_turns(s) if not t.get("dont_know"))
        grader_model = resolve_model("recall_grading").model
        per_call = tracker.estimate_call(grader_model, "recall_grading", 900)
        plan.update({"grader_model": grader_model, "graded": graded, "grader_usd": graded * per_call})
    if judge_spec is not None:
        # One judge call per asking turn (a closing turn that asks the next idea is one): at most one per scripted student message, and the opening turn.
        judged = sum(len(flat_turns(s)) + 1 for s in scenarios)
        per_call = tracker.estimate_call(judge_spec.model_id, "judge_teach_back", 700)
        plan.update({"judge_model": judge_spec.label, "judged": judged, "judge_usd": judged * per_call})
    return plan


def print_plan(args, plan: Dict[str, Any], log, revision: Optional[Dict[str, Any]] = None, prompts: Optional[Dict[str, Any]] = None) -> None:
    log("Plan")
    if revision:
        import hashlib

        shas = sorted({hashlib.sha256(e["system"].encode("utf-8")).hexdigest()[:12] for e in (prompts or {}).get("topics", {}).values()})
        log(f"  prompts: PROMPTS_V2={revision['PROMPTS_V2']!r} -> {revision['areas']}; coach system prompt sha {', '.join(shas)}")
    log(f"  surface: teach_back   scenarios: {plan['scenarios']}   model calls: {plan['calls']}")
    log(f"  coach {plan['model']}: about ${plan['usd']:.2f}")
    if plan.get("judge_usd") is not None:
        log(f"  teaches-before-probe judge {plan['judge_model']}: about ${plan['judge_usd']:.2f} for {plan['judged']} asking turns (an ideal coach asks on most turns)")
    if plan.get("grader_usd") is not None:
        log(f"  recall grader {plan['grader_model']} (--grader): about ${plan['grader_usd']:.2f} for up to {plan['graded']} scripted answers (counted under --max-usd)")
    log(f"  estimated total: ${plan['usd'] + (plan.get('judge_usd') or 0) + (plan.get('grader_usd') or 0):.2f}. Caps: --max-usd {args.max_usd}, --max-judge-usd {args.max_judge_usd}")
    log("  These are rough: a coach that calls a tool twice in a turn, or speaks longer, costs more. Nothing was called.")


# ---------------------------------------------------------------------------- main


async def run(args, host) -> int:
    """`host` is run_eval's module: its helpers (spend gate, provider, git, results folder) are shared."""
    from teach_state import load_prompts

    log: Callable[[str], None] = host.log
    spend_module, adapters = host.load_generation_helpers()
    import teach_judge
    import teach_metrics
    import teach_report

    if args.resume and (args.resume / "run.json").exists():
        earlier = json.loads((args.resume / "run.json").read_text())
        args.patterns = args.patterns or earlier.get("patterns")
        args.limit = args.limit or earlier.get("limit")
        if not args.scenarios and earlier.get("scenarios"):
            args.scenarios = Path(earlier["scenarios"])
    scenario_path = args.scenarios or TEACH_SCENARIOS
    scenarios = host.load_scenarios(scenario_path, args.patterns, args.limit)
    by_id = {s["id"]: s for s in scenarios}
    from common.revision import prompt_revision

    revision = prompt_revision("voice")
    prompts = load_prompts()  # the v2 fixture when PROMPTS_V2 names voice
    missing = {s["topic"] for s in scenarios} - set(prompts["topics"])
    if missing:
        fixture = "teach_back_prompts_v2.json" if revision["areas"]["voice"] == "v2" else "teach_back_prompts.json"
        raise SystemExit(f"fixtures/{fixture} has no prompt for {sorted(missing)}; run frontend/scripts/teach-parity-fixture.ts{' --v2' if fixture.endswith('_v2.json') else ''}")
    tracker = spend_module.SpendTracker(args.max_usd, args.max_judge_usd, adapters.estimate_cost)
    judge_spec = adapters.parse_model_spec(args.judge if ":" in args.judge else f"{args.judge}:medium") if args.judge else None

    if args.dry_run:
        host.prepare_app_environment()
        print_plan(args, estimate(scenarios, prompts, tracker, judge_spec, bool(getattr(args, "grader", False))), log, revision, prompts)
        return 0

    date = datetime.date.today().isoformat()
    run_dir = args.resume.resolve() if args.resume else args.out_dir / f"{date}-{args.label}"
    previous: Dict[str, Any] = {}
    if args.resume:
        if not (run_dir / "run.json").exists():
            raise SystemExit(f"{run_dir} has no run.json; was it created by this script?")
        previous = json.loads((run_dir / "run.json").read_text())
        date, args.label = previous["date"], previous["label"]
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)
    if previous.get("prompts") and previous["prompts"].get("areas") != revision["areas"]:
        raise SystemExit(f"--resume: this folder ran with {previous['prompts']['areas']}, PROMPTS_V2 now gives {revision['areas']}. Resume with the same PROMPTS_V2.")
    run_info = {"label": args.label, "date": date, "prompts": revision, "surface": "teach_back", "patterns": args.patterns, "limit": args.limit, "scenarios": str(scenario_path.resolve())}
    if not args.resume:  # written at the start, so a run that dies can be resumed
        (run_dir / "run.json").write_text(json.dumps(run_info, indent=2) + "\n")
    for kind, usd in host.existing_spend(run_dir).items():
        tracker.add_past_spend(kind, usd)
    if args.resume:
        log(f"Resuming {run_dir}: ${tracker.total_spent:.2f} already spent in this folder")

    api_key = ""
    if not args.mock:
        api_key = adapters.load_api_key(args.env_file)
        if not api_key:
            raise SystemExit(f"ANTHROPIC_API_KEY is not set and {args.env_file} has none. Use --mock to test without a key.")

    from app.config import settings
    from app.services.llm.models import resolve_model

    if not args.mock:
        settings.ANTHROPIC_API_KEY = api_key
    stop: Dict[str, str] = {}
    inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
    # The app's own model choice for the voice purpose (no pin).
    provider = make_teach_meter(adapters, stop)(inner, None, tracker, spend_module.GENERATION)

    log(f"Playing {len(scenarios)} teach_back scenarios")
    started = time.perf_counter()
    grader_led = bool(getattr(args, "grader_led", False))
    live_questions = grader_led and bool(getattr(args, "live_questions", False))
    questions_provider = None
    if live_questions:
        # The grader takes its provider from the factory; its calls count under --max-usd.
        from app.services.llm.factory import LLMFactory

        questions_provider = adapters.MeteredProvider(adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), None, tracker, spend_module.GENERATION)
        saved_factory, LLMFactory._instance = LLMFactory._instance, questions_provider
    try:
        records = await play_all(scenarios, provider, prompts, stop, run_dir / "raw", bool(args.resume), args.concurrency, log, grader_led, live_questions)
    finally:
        if live_questions:
            LLMFactory._instance = saved_factory

    # ------------------------------------------------------------------ judge: does an asking turn teach the idea first?
    judgments: Optional[Dict[str, Dict[str, Any]]] = None
    judge_info: Dict[str, Any] = {}
    if judge_spec:
        judge_provider = adapters.MeteredProvider(
            adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), judge_spec, tracker, spend_module.JUDGE
        )
        items = teach_judge.items_for_records(by_id, records, teach_metrics.is_judged)
        if args.judge_limit is not None and args.judge_limit < len(items):
            step = len(items) / args.judge_limit
            items = [items[int(i * step)] for i in range(args.judge_limit)]
        log(f"Judging {len(items)} asking turns with {judge_spec.label}")
        judge_info = await teach_judge.judge_turns(provider=judge_provider, items=items, judge_dir=run_dir / "judge", concurrency=args.concurrency, log=log)
        judgments = judge_info["verdicts"]
        cost_file = run_dir / "judge" / "_cost.json"  # so a resume counts the money already spent on the judge
        earlier = json.loads(cost_file.read_text())["cost_usd"] if cost_file.exists() else 0.0
        cost_file.write_text(json.dumps({"cost_usd": round(earlier + judge_info["cost_usd"], 4)}) + "\n")

    # ------------------------------------------------------------------ --grader: the script against the app's own grader
    grader_summary: Optional[Dict[str, Any]] = None
    if getattr(args, "grader", False):
        grader_provider = adapters.MeteredProvider(adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), None, tracker, spend_module.GENERATION)
        items = grader_items(scenarios, records)
        log(f"Grading {len(items)} scripted answers with the app's recall grader")
        graded = await grade_script(grader_provider, items, run_dir / "grader", args.concurrency, log)
        grader_summary = {**grader_agreement(items, graded), "model": resolve_model("recall_grading").model, "cost_usd": round(sum(c["cost_usd"] for c in grader_provider.calls), 4)}

    summary_metrics = teach_metrics.summarize(by_id, records, judgments)
    summary_metrics["grader"] = grader_summary
    if grader_led:
        # The replies the app built, on their own: the same gates over those turns alone (the judge's verdicts included when it ran).
        built = [r for r in records if r.get("assembled")]
        graded_turns = [r for r in records if r.get("pre_run") and r.get("turn", 0) > 0 and not r.get("error")]
        summary_metrics["assembled"] = {"turns": len(built), "graded_turns": len(graded_turns), "gates": teach_metrics.summarize(by_id, built, judgments)["gates"] if built else []}
        summary_metrics["assembled"]["probes"] = probe_summary(records)
        if questions_provider is not None:
            written = [r["questions"] for r in records if r.get("questions")]
            timed = [w["seconds"] for w in written if "seconds" in w]
            summary_metrics["assembled"]["questions"] = {
                "model": resolve_model("recall_grading").model,
                "calls": len(written),
                "errors": sum(1 for w in written if w.get("error")),
                "mean_seconds": round(sum(timed) / len(timed), 2) if timed else None,
                "cost_usd": round(sum(c["cost_usd"] for c in questions_provider.calls), 4),
            }
    spoken = [r for r in records if r.get("text")]
    spent = round(tracker.spent[spend_module.GENERATION], 4)
    judge_spend = round(tracker.spent[spend_module.JUDGE], 4)
    voice = resolve_model("voice")
    summary: Dict[str, Any] = {
        "label": args.label,
        "date": date,
        "code": {
            "commit": host.git("rev-parse", "HEAD"),
            "branch": host.git("rev-parse", "--abbrev-ref", "HEAD"),
            "app_dirty": bool(host.git("status", "--porcelain", "--", "ai-service/app", "frontend/src/lib/voice")),
        },
        "prompts": revision,
        "config": {
            "surface": "teach_back",
            "scenarios": len(scenarios),
            "scenario_file": str(scenario_path),
            "coach_model": f"{voice.model}:{voice.effort}",
            "mock": args.mock,
            "judge": judge_spec.label if judge_spec else None,
            "grader_led": grader_led,
            "live_questions": live_questions,
        },
        "spend": {"generation": spent, "judge": judge_spend, "max_usd": args.max_usd, "max_judge_usd": args.max_judge_usd},
        "stopped": stop.get("reason") or judge_info.get("stopped") or previous.get("stopped"),
        "metrics": summary_metrics,
        "cost": {
            "per_turn": (sum(r.get("cost_usd", 0) for r in spoken) / len(spoken)) if spoken else 0.0,
            "per_scenario": (sum(r.get("cost_usd", 0) for r in records) / len(scenarios)) if scenarios else 0.0,
            "mean_seconds": (sum(r.get("seconds", 0) for r in spoken) / len(spoken)) if spoken else 0.0,
        },
    }
    (run_dir / "run.json").write_text(json.dumps({**run_info, "stopped": summary["stopped"], "spend": summary["spend"]}, indent=2) + "\n")
    (run_dir / "turns.json").write_text(json.dumps({"turns": records}, indent=2, default=str) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str) + "\n")
    md_path = run_dir.parent / f"{run_dir.name}.md"
    md_path.write_text(teach_report.render_markdown(summary))
    log(f"\nWrote {md_path}\nWrote {run_dir / 'summary.json'}")
    log(f"Spent ${spent:.2f} on the coach" + (f" and ${judge_spend:.2f} on the judge" if judge_spec else "") + f" in {time.perf_counter() - started:.0f}s")
    for gate in summary_metrics["gates"]:
        log(f"  {teach_report.verdict(gate):<8} {gate['label']}: {teach_report.gate_value(gate)}")
    return 0 if summary_metrics["passed"] else 1


__all__ = ["run", "make_teach_meter", "Session", "coach_turn", "play", "stored_history", "grader_items", "grader_agreement"]

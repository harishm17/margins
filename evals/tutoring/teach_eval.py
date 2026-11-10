"""The voice teach-back half of the tutoring eval (spec sections 5.8 and 11). Run through run_eval.py:

    cd ai-service
    uv run python -I ../evals/tutoring/run_eval.py --surface teach_back --max-usd 2 --label teach-back-gates

What it does:
  1. Loads the scripted students (scenarios/teach-back-original.jsonl, built by build_teach_scenarios.py): twenty-six
     students explaining one idea to the voice coach, each turn with the verdict the recall grader would give each claim.
  2. Plays each one against the coach as the app runs it: the app's own system prompt and tool definitions (rendered by
     the TypeScript, fixtures/teach_back_prompts.json), the app's own provider for the voice purpose, and the same turn
     structure (spec 19.1): the rules of utterance.py (a mirror of the app's, pinned by fixtures/utterance_parity.json) decide
     whether the step the session is waiting for runs before the model speaks; if it does, its result goes in the student's
     message as <app_result> and the coach is called once; the tools stay available, a second run of a step in the same turn
     returns the stored result, and there are at most four model calls per student message. What the tools answer comes from
     teach_state.py, a mirror of the app's probe rules pinned to the real code by fixtures/teach_state_parity.json. The grader
     is not called: its verdicts are the script's, so this measures the coach, not the grader (which has its own tests).
     Per student message the run reports the model calls and the time to the first sentence (reported, not gated).
  3. With --judge, one Opus call per asking turn (teach_judge.py) decides whether the turn teaches the idea before the student has
     tried; that gate (teaches_before_probe) is "not run" without it. Then scores every coach turn with teach_metrics.py and
     applies the gates.
  4. Writes evals/results/<date>-<label>.md and the folder <date>-<label>/ with turns.json, summary.json, run.json and raw/.

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

from utterance import app_result_text, classify_utterance, has_substance

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
    """What the app keeps for one voice teach-back and answers the coach's tools with (the mirror of teach-tools.ts)."""

    def __init__(self, scenario: Dict[str, Any]):
        from teach_state import empty_state

        self.scenario = scenario
        self.concept = scenario["concept"]
        self.state = empty_state()
        self.turn = 0  # the scripted student message the coach is answering (0 before the student has said anything)
        self.claims_given: List[str] = []
        self.started = False
        self.steps: Dict[str, Dict[str, Any]] = {}  # the results of the steps already run for this utterance (spec 19.1)

    def current_verdicts(self) -> List[Dict[str, Any]]:
        turns = self.scenario["turns"]
        return turns[min(max(self.turn, 1), len(turns)) - 1]["verdicts"]

    def explain_verdicts(self) -> List[Dict[str, Any]]:
        """The verdicts of the newest scripted explanation (an example is not one)."""
        turns = self.scenario["turns"][: max(self.turn, 1)]
        for turn in reversed(turns):
            if turn["kind"] == "explain":
                return turn["verdicts"]
        return turns[-1]["verdicts"]

    def closed(self) -> bool:
        return bool(self.state["outcome"])

    def note_given(self, output: Dict[str, Any]) -> None:
        from teach_state import untagged

        # A claim's text reaches the coach only with action explain: the incorrect findings carry its page, not its text.
        if isinstance(output.get("source_claim"), dict):
            self.claims_given.append(untagged(output["source_claim"]["text"]))

    def begin_turn(self, turn: int) -> None:
        self.turn = turn
        self.steps = {}

    def plan_pre_run(self, said: str, last_coach_text: str) -> Optional[Dict[str, Any]]:
        """The step the app runs before the model speaks for this utterance, or None (frontend/src/lib/voice/pre-run.ts planPreRun,
        teach-back only): an answer or an "I don't know" with some substance, to an idea that is open and was asked about."""
        kind = classify_utterance(said)
        if kind not in ("answer", "idk") or not has_substance(said, kind) or not self.started or self.closed():
            return None
        from app.prompt_revision import prompts_v2
        from teach_state import example_check_tool

        # Under the voice flag the tools take no concept_id: the app reads it from the session (frontend tools.ts).
        held = prompts_v2("voice")
        concept_id = self.concept["id"]
        if self.state["exampleAsked"]:
            question = last_coach_text.strip()[:1000]
            name = example_check_tool()
            return {"name": name, "input": {"question": question} if held else {"concept_id": concept_id, "question": question}} if question else None
        return {"name": "assess_explanation", "input": {} if held else {"concept_id": concept_id}}

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
        from teach_state import assessed_claims, assessment_result, example_result

        concept = self.concept
        if name == "get_concept_to_explain":
            if self.closed():
                return {"done": True, "message": "Every idea has been worked through. Sum up and say goodbye."}
            self.started = True
            return {
                "done": False,
                "concept_id": concept["id"],
                "concept_name": concept["name"],
                "prompt": f'Explain "{concept["name"]}" in your own words, as if you were teaching it to a classmate.',
                "ideas_left": 1,
            }
        from app.prompt_revision import prompts_v2

        # Under the voice flag the model passes no concept_id: the app takes the one last given (frontend tools.ts).
        given = concept["id"] if prompts_v2("voice") else args.get("concept_id")
        if name == "assess_explanation":
            if given != concept["id"]:
                return {"error": "Concept not found. Call get_concept_to_explain."}
            if self.closed():
                return {"error": "That idea is finished. Call get_concept_to_explain for the next one."}
            # The app takes the student's words from its own record of the turn, so the model passes none (voice/teach-tools.ts).
            if self.turn == 0:
                return {"error": "The student has not said anything since your last question. Ask it, stop, and call this tool only after they have answered."}
            claims = assessed_claims(concept, self.explain_verdicts())
            covered_something = any(claim["verdict"] in ("covered", "partial") for claim in claims)
            # What the student said was an "I don't know" when the script says so (the parity test pins that flag to the app's detector).
            said = self.scenario["turns"][min(max(self.turn, 1), len(self.scenario["turns"])) - 1]
            output, self.state, _ = assessment_result(
                concept["name"],
                claims,
                self.state,
                None if covered_something else concept["prerequisite"],
                bool(said.get("dont_know")),
                int(self.scenario.get("band", 1)),
            )
            self.note_given(output)
            return output
        if name in EXAMPLE_CHECK_TOOLS:
            if given != concept["id"]:
                return {"error": "Concept not found. Call get_concept_to_explain."}
            if self.closed():
                return {"error": "That idea is finished. Call get_concept_to_explain for the next one."}
            if not self.state["exampleAsked"]:
                return {"error": "The new example is asked after assess_explanation says ask_new_example."}
            claims = assessed_claims(concept, self.current_verdicts())
            output, self.state, _ = example_result(concept["name"], claims, self.state)
            self.note_given(output)
            return output
        return {"error": "Unknown tool"}


# ---------------------------------------------------------------------------- playing


async def coach_turn(provider, system: str, tools: List[Dict[str, Any]], messages: List[Dict[str, Any]], session: Session, log: Optional[List[Dict[str, Any]]] = None):
    """One coach turn as the app's turn loop runs it. Returns (spoken text, the tool calls with their results). `log` starts with
    the step the app ran before the model, if it ran one."""
    from app.services.llm.base import TurnDone, TurnText

    spoken: List[str] = []
    log = log if log is not None else []
    for call in range(1, MAX_MODEL_CALLS + 1):
        events = [e async for e in provider.stream_turn(system=system, messages=messages, tools=tools, max_tokens=800, purpose="voice")]
        done = next((e for e in reversed(events) if isinstance(e, TurnDone)), None)
        text = "".join(e.text for e in events if isinstance(e, TurnText)).strip()
        if text:
            spoken.append(text)
        if done is None:
            break
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
    """What the coach was told to do at the end of the turn: the action of the last result that has one, 'ask' after getting an
    idea, None when no tool ran."""
    for item in reversed(log):
        output = item["output"]
        if "action" in output:
            return output["action"]
        if item["name"] == "get_concept_to_explain" and output.get("done") is False:
            return "ask"
        if item["name"] == "get_concept_to_explain" and output.get("done") is True:
            return "wrap_up"
    return None


async def play(scenario: Dict[str, Any], provider, prompts: Dict[str, Any], stop: Dict[str, str]) -> List[Dict[str, Any]]:
    """One scripted conversation: the start of the session, then each student message in turn. One record per coach turn."""
    from spend import SpendLimitReached

    entry = prompts["topics"][scenario["topic"]]
    session = Session(scenario)
    messages: List[Dict[str, Any]] = [{"role": "user", "content": entry["start"]}]
    records: List[Dict[str, Any]] = []
    last_text = ""
    for turn in range(0, len(scenario["turns"]) + 1):
        if stop.get("reason") or (turn > 0 and session.closed() and records and records[-1].get("closed")):
            break
        session.begin_turn(turn)
        pre_run: List[Dict[str, Any]] = []
        if turn > 0:
            said = scenario["turns"][turn - 1]["say"]
            plan = session.plan_pre_run(said, last_text)
            content: Any = said
            if plan:
                # The step runs before the model speaks; the model is given its result with the student's words (spec 19.1).
                output = session.answer_once(plan["name"], plan["input"])
                pre_run.append({"name": plan["name"], "input": plan["input"], "output": output, "pre_run": True})
                content = [{"type": "text", "text": said}, {"type": "text", "text": app_result_text(plan["name"], output)}]
            messages.append({"role": "user", "content": content})
        calls: list = []
        token = _TURN_CALLS.set(calls)
        started = time.perf_counter()
        base = {"scenario": scenario["id"], "pattern": scenario["pattern"], "turn": turn, "student": scenario["turns"][turn - 1]["say"] if turn else ""}
        try:
            text, log = await coach_turn(provider, entry["system"], prompts["tools"], messages, session, list(pre_run))
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
        last_text = text or last_text
        records.append(
            {
                **base,
                "text": text,
                "tools": log,
                "pre_run": pre_run[0]["name"] if pre_run else None,
                "first_sentence_s": first_sentence_seconds(calls),
                "last_action": last_action(log),
                "claims_given": list(session.claims_given),
                "closed": session.closed(),
                "outcome": session.state["outcome"],
                "seconds": round(time.perf_counter() - started, 2),
                "cost_usd": round(sum(c["cost_usd"] for c in calls), 6),
                "model_calls": len(calls),
            }
        )
        if log and any(item["output"].get("done") is True for item in log):
            break  # the session is over
    return records


async def play_all(scenarios, provider, prompts, stop, raw_dir: Path, resume: bool, concurrency: int, log) -> List[Dict[str, Any]]:
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
            turns = await play(scenario, provider, prompts, stop)
        results[scenario["id"]] = turns
        if not stop.get("reason"):  # a stopped scenario is incomplete: play it again on a resume
            path.write_text(json.dumps({"scenario": scenario["id"], "turns": turns}, indent=2) + "\n")
        log(f"  {scenario['id']:<40} {sum(1 for t in turns if t.get('text'))} turns, ${sum(t.get('cost_usd', 0) for t in turns):.4f}")

    await asyncio.gather(*[one(s) for s in scenarios])
    return [turn for scenario in scenarios for turn in results.get(scenario["id"], [])]


# ---------------------------------------------------------------------------- estimate


def estimate(scenarios: List[Dict[str, Any]], prompts: Dict[str, Any], tracker, judge_spec=None) -> Dict[str, Any]:
    """Dollars for a run, from the app's prompt and tools with an ideal coach: each student message costs one call that speaks
    (the app has already run the step and put its result in the message, spec 19.1), over a history that grows by the results.
    The input side is close; the output side is a guess (spend.py DEFAULT_OUTPUT_TOKENS)."""
    from app.services.llm.models import resolve_model

    from spend import estimate_prompt_tokens
    from teach_state import parity_trace

    model = resolve_model("voice").model
    tools_json = json.dumps(prompts["tools"])
    calls = 0
    usd = 0.0
    for scenario in scenarios:
        entry = prompts["topics"][scenario["topic"]]
        history: List[str] = [entry["start"]]
        steps = parity_trace(scenario)
        # The first turn: get the idea, then ask it.
        for _ in range(2):
            usd += tracker.estimate_call(model, "voice", estimate_prompt_tokens([entry["system"], tools_json, *history], None))
            calls += 1
        history.append("Explain it in your own words as if teaching a classmate.")
        for turn, step in zip(scenario["turns"], steps):
            history.append(turn["say"])
            history.append(step["app_result"])
            usd += tracker.estimate_call(model, "voice", estimate_prompt_tokens([entry["system"], tools_json, *history], None))
            calls += 1
            history.append("A short spoken reply with one question.")
    plan = {"scenarios": len(scenarios), "calls": calls, "model": model, "usd": usd}
    if judge_spec is not None:
        # One judge call per asking turn: at most one per scripted student message, and the opening turn.
        judged = sum(len(s["turns"]) + 1 for s in scenarios)
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
    log(f"  estimated total: ${plan['usd'] + (plan.get('judge_usd') or 0):.2f}. Caps: --max-usd {args.max_usd}, --max-judge-usd {args.max_judge_usd}")
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
        print_plan(args, estimate(scenarios, prompts, tracker, judge_spec), log, revision, prompts)
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
    records = await play_all(scenarios, provider, prompts, stop, run_dir / "raw", bool(args.resume), args.concurrency, log)

    # ------------------------------------------------------------------ judge: does an asking turn teach the idea first?
    judgments: Optional[Dict[str, Dict[str, Any]]] = None
    judge_info: Dict[str, Any] = {}
    if judge_spec:
        judge_provider = adapters.MeteredProvider(
            adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), judge_spec, tracker, spend_module.JUDGE
        )
        items = teach_judge.items_for_records(by_id, records, lambda r: r.get("last_action") in teach_metrics.ASKING_ACTIONS)
        if args.judge_limit is not None and args.judge_limit < len(items):
            step = len(items) / args.judge_limit
            items = [items[int(i * step)] for i in range(args.judge_limit)]
        log(f"Judging {len(items)} asking turns with {judge_spec.label}")
        judge_info = await teach_judge.judge_turns(provider=judge_provider, items=items, judge_dir=run_dir / "judge", concurrency=args.concurrency, log=log)
        judgments = judge_info["verdicts"]
        cost_file = run_dir / "judge" / "_cost.json"  # so a resume counts the money already spent on the judge
        earlier = json.loads(cost_file.read_text())["cost_usd"] if cost_file.exists() else 0.0
        cost_file.write_text(json.dumps({"cost_usd": round(earlier + judge_info["cost_usd"], 4)}) + "\n")

    summary_metrics = teach_metrics.summarize(by_id, records, judgments)
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


__all__ = ["run", "make_teach_meter", "Session", "coach_turn", "play"]

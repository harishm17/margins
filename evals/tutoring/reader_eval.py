"""The reader-tutor half of the tutoring eval (spec sections 5.2, 11 and 18.6). Run through run_eval.py:

    cd ai-service
    uv run python -I ../evals/tutoring/run_eval.py --surface reader --max-usd 2 --label reader-gates

What it does:
  1. Loads the scripted students (scenarios/reader-original.jsonl, built by build_reader_scenarios.py): fifteen students
     working one passage in the reader's margin. A turn is a take, "I can't parse any of it", an answer to the check
     question or "I don't know".
  2. Plays each one against POST /tutor/reader in process (the app object behind an ASGI transport; no server, no
     database). The route, the prompts, the leak check and the provider are the app's own. What the Next.js server does
     around the route (frontend/src/lib/reader/reader-server.ts) is mirrored in `Margin` below: the rung is the number of
     explanations the passage has had (at most 3), the second "can't parse" tap is a restatement (rung 4), a check answer is
     a second turn on the question the last reply ended with, and a passage gets four replies a day.
  3. Scores every reply with reader_metrics.py and applies the gates.
  4. Writes evals/results/<date>-<label>.md and the folder <date>-<label>/ with turns.json, summary.json, run.json and raw/.

Every model call goes through the spend gate: --max-usd (default 4) is a hard stop checked before each call. --dry-run
plays the scripts against the app's prompt builder, prints the plan and a cost estimate, and calls nothing. --mock uses
the app's mock provider. --resume DIR continues a folder. The model judge of the practice surface is not run here.
"""
import asyncio
import datetime
import json
import sys
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Dict, List, Optional

READER_SCENARIOS = Path(__file__).resolve().parent / "scenarios" / "reader-original.jsonl"

CANT_PARSE_TEXT = "I can't parse any of it"
DONT_KNOW_TEXT = "I don't know"
MAX_RUNG = 3
RESTATE_RUNG = 4
RESTATE_AFTER = 2
REPLIES_PER_DAY = 4

_TURN_CALLS: ContextVar[Optional[list]] = ContextVar("reader_eval_turn_calls", default=None)


# ---------------------------------------------------------------------------- the metered provider


def make_reader_meter(adapters, stop: Dict[str, str]):
    """A MeteredProvider that hands each call's record to the turn being played (so a turn's cost is known with scenarios
    running at the same time), and stops the run when a call would pass the cap (the leak judge swallows errors)."""

    class ReaderMeter(adapters.MeteredProvider):
        def _gate(self, messages, purpose, schema=None):
            from spend import SpendLimitReached

            try:
                return super()._gate(messages, purpose, schema)
            except SpendLimitReached as exc:
                stop.setdefault("reason", str(exc))
                raise

        async def _metered(self, call, messages, purpose, schema, raw_of):
            try:
                return await super()._metered(call, messages, purpose, schema, raw_of)
            finally:
                sink = _TURN_CALLS.get()
                if sink is not None and self.calls:
                    sink.append(self.calls[-1])

    return ReaderMeter


# ---------------------------------------------------------------------------- the app's side of the margin


class Margin:
    """One passage's tutor state as the Next.js server holds it (`TutorState(scope='reader')` and the day's replies)."""

    def __init__(self, scenario: Dict[str, Any]):
        self.scenario = scenario
        self.attempts = 0
        self.cant_parse = 0
        self.replies = 0
        self.take = ""
        self.check_question = ""

    def explain_request(self, turn: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The body sent to the AI service for an explanation or a restatement, or None when the day's four replies are used."""
        if self.replies >= REPLIES_PER_DAY:
            return None
        cant_parse = bool(turn.get("cant_parse"))
        take = CANT_PARSE_TEXT if cant_parse else turn["take"].strip()
        cant_turns = self.cant_parse + (1 if cant_parse else 0)
        restating = cant_parse and cant_turns >= RESTATE_AFTER
        rung = RESTATE_RUNG if restating else min(MAX_RUNG, 1 + self.attempts)
        return {**self.base(take), "student_take": take, "cant_parse": cant_parse, "rung": rung, "turn": "restate" if restating else "explain"}

    def check_request(self, turn: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The body for the student's answer to the last reply's check question, or None when there is no question or no reply left."""
        if self.replies >= REPLIES_PER_DAY or not self.check_question:
            return None
        dont_know = bool(turn.get("dont_know"))
        return {
            **self.base(self.take),
            "student_take": self.take,
            "cant_parse": False,
            "rung": min(MAX_RUNG, max(1, self.attempts)),
            "turn": "check",
            "check_question": self.check_question,
            "student_answer": DONT_KNOW_TEXT if dont_know else turn["answer"].strip(),
            "dont_know": dont_know,
        }

    def base(self, take: str) -> Dict[str, Any]:
        return {
            "user_id": "eval-user",  # the route bills a student; evals pay through the spend meter instead
            "project_id": "eval-project",
            "passage": self.scenario["passage"],
            "chunk_id": f"{self.scenario['id']}-chunk",
            "claims": [{"text": c["text"], "quote": c["quote"], "page": c["page"]} for c in self.scenario["claims"]],
        }

    def commit(self, request: Dict[str, Any], body: Dict[str, Any]) -> None:
        """The state after a reply: explanations count towards the rung, "can't parse" taps are counted, every reply is one of the day's four."""
        self.replies += 1
        if request["turn"] == "check":
            self.check_question = body.get("follow_up_question", "") if body.get("verdict") != "right" else ""
            return
        self.attempts += 1
        if request["cant_parse"]:
            self.cant_parse += 1
        self.take = request["student_take"]
        self.check_question = body.get("check_question", "")


def install_route():
    """The tutor route with the AI marked available and no ledger or budget; returns an ASGI client."""
    import httpx

    from app.config import settings
    from app.main import app
    from app.api.routes import tutor as tutor_route
    from app.services import ai_status

    settings.AI_INTERNAL_TOKEN = ""
    settings.ENVIRONMENT = "development"

    async def available() -> "ai_status.AiStatus":
        return ai_status.AiStatus(True)

    async def owns(user_id, **ids):
        """No database: the eval's student owns the course it sends."""

    ai_status.get_status = available
    tutor_route.assert_owns = owns
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://eval", timeout=None)


async def post_reader(client, payload: Dict[str, Any]):
    response = await client.post("/tutor/reader", json=payload)
    try:
        body = response.json()
    except ValueError:
        body = {"detail": response.text[:200]}
    return response.status_code, body


# ---------------------------------------------------------------------------- playing


async def play(scenario: Dict[str, Any], call, stop: Dict[str, str]) -> List[Dict[str, Any]]:
    """One scripted conversation. Returns one record per student action: a reply, a refusal, an error."""
    margin = Margin(scenario)
    records: List[Dict[str, Any]] = []
    for position, turn in enumerate(scenario["turns"], 1):
        if stop.get("reason"):
            break
        base = {
            "scenario": scenario["id"],
            "pattern": scenario["pattern"],
            "turn": position,
            "event": turn["event"],
            "student": turn.get("take") or turn.get("answer") or (CANT_PARSE_TEXT if turn.get("cant_parse") else DONT_KNOW_TEXT),
            **({"expect_verdict": turn["expect_verdict"]} if "expect_verdict" in turn else {}),
        }
        request = margin.explain_request(turn) if turn["event"] == "explain" else margin.check_request(turn)
        if request is None:
            records.append({**base, "blocked": True})
            continue
        base.update(kind=request["turn"], dont_know=request.get("dont_know", False), rung=request["rung"])
        calls: list = []
        token = _TURN_CALLS.set(calls)
        started = time.perf_counter()
        try:
            status, body = await call({**request, "session_id": scenario["id"]})
        except Exception as exc:  # a failed turn is a result, not a crash
            status, body = 0, {"detail": f"{type(exc).__name__}: {exc}"}
        finally:
            _TURN_CALLS.reset(token)
        if stop.get("reason"):
            break  # the cap was reached during this turn: it is not a result
        base["seconds"] = round(time.perf_counter() - started, 2)
        base["cost_usd"] = round(sum(c["cost_usd"] for c in calls), 6)
        base["model_calls"] = len(calls)
        if status != 200 or "reply" not in body:
            records.append({**base, "error": str(body.get("detail", f"HTTP {status}"))[:300]})
            continue
        margin.commit(request, body)
        records.append(
            {
                **base,
                "reply": body["reply"],
                "check_question": body.get("check_question", ""),
                "verdict": body.get("verdict"),
                "follow_up_question": body.get("follow_up_question", ""),
                "from_fallback": bool(body.get("from_fallback")),
            }
        )
    return records


async def play_all(scenarios: List[Dict[str, Any]], call, stop: Dict[str, str], raw_dir: Path, resume: bool, concurrency: int, log) -> List[Dict[str, Any]]:
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
            turns = await play(scenario, call, stop)
        results[scenario["id"]] = turns
        if not stop.get("reason"):  # a stopped scenario is incomplete: play it again on a resume
            path.write_text(json.dumps({"scenario": scenario["id"], "turns": turns}, indent=2) + "\n")
        log(f"  {scenario['id']:<44} {sum(1 for t in turns if t.get('reply'))} replies, ${sum(t.get('cost_usd', 0) for t in turns):.4f}")

    await asyncio.gather(*[one(s) for s in scenarios])
    return [turn for scenario in scenarios for turn in results.get(scenario["id"], [])]


# ---------------------------------------------------------------------------- estimate

LEAK_JUDGE_PROMPT_TOKENS = 700


def estimate(scenarios: List[Dict[str, Any]], tracker) -> Dict[str, Any]:
    """Dollars for a run, by playing every script against the app's own prompt builder (the first reply stands in for the one
    a check question would have been). The input side is close; the output side is a guess (spend.py DEFAULT_OUTPUT_TOKENS),
    and a reply that leaked is written twice."""
    from app.services.llm.models import resolve_model
    from app.services.llm.schemas import ReaderTutorRequest
    from app.services.tutor.reader import build_messages

    from spend import estimate_prompt_tokens

    tutor_model, router_model = resolve_model("tutor").model, resolve_model("router").model
    replies = 0
    tutor_usd = judge_usd = 0.0
    for scenario in scenarios:
        margin = Margin(scenario)
        for turn in scenario["turns"]:
            request = margin.explain_request(turn) if turn["event"] == "explain" else margin.check_request(turn)
            if request is None and turn["event"] == "check":
                # The check question the script would answer: a stand-in, so the prompt has its size.
                margin.check_question = "What does the passage say about the main idea?"
                request = margin.check_request(turn)
            if request is None:
                continue
            messages = build_messages(ReaderTutorRequest(**request))
            tutor_usd += tracker.estimate_call(tutor_model, "tutor", estimate_prompt_tokens([m.content for m in messages], None))
            judge_usd += tracker.estimate_call(router_model, "router", LEAK_JUDGE_PROMPT_TOKENS + estimate_prompt_tokens([scenario["passage"]], None))
            margin.commit(request, {"check_question": "What does the passage say?", "follow_up_question": "Which sentence says it?", "verdict": "not_yet"})
            replies += 1
    return {"scenarios": len(scenarios), "replies": replies, "tutor_model": tutor_model, "router_model": router_model, "tutor_usd": tutor_usd, "judge_usd": judge_usd}


def print_plan(args, plan: Dict[str, Any], log) -> None:
    from common.revision import prompt_revision

    revision = prompt_revision("tutor")
    total = plan["tutor_usd"] + plan["judge_usd"]
    log("Plan")
    log(f"  prompts: PROMPTS_V2={revision['PROMPTS_V2']!r} -> {revision['areas']}")
    log(f"  surface: reader   scenarios: {plan['scenarios']}   replies from the model: {plan['replies']}")
    log(f"  replies {plan['tutor_model']}: about ${plan['tutor_usd']:.2f}   leak judge {plan['router_model']}: about ${plan['judge_usd']:.2f}")
    log(f"  estimated total: ${total:.2f}. Cap: --max-usd {args.max_usd}")
    log("  These are rough: the share of replies written twice because the first leaked and the thinking tokens decide the real cost. Nothing was called.")


# ---------------------------------------------------------------------------- main


async def run(args, host) -> int:
    """`host` is run_eval's module: its helpers (spend gate, provider, git, results folder) are shared."""
    log = host.log
    spend_module, adapters = host.load_generation_helpers()
    import reader_metrics
    import reader_report

    if args.resume and (args.resume / "run.json").exists():
        earlier = json.loads((args.resume / "run.json").read_text())
        args.patterns = args.patterns or earlier.get("patterns")
        args.limit = args.limit or earlier.get("limit")
        if not args.scenarios and earlier.get("scenarios"):
            args.scenarios = Path(earlier["scenarios"])
    scenario_path = args.scenarios or READER_SCENARIOS
    scenarios = host.load_scenarios(scenario_path, args.patterns, args.limit)
    by_id = {s["id"]: s for s in scenarios}
    tracker = spend_module.SpendTracker(args.max_usd, args.max_judge_usd, adapters.estimate_cost)
    if args.judge:
        log("--judge is for the practice surface: the reader run is scored by program only.")

    if args.dry_run:
        host.prepare_app_environment()
        print_plan(args, estimate(scenarios, tracker), log)
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
    from common.revision import prompt_revision

    revision = prompt_revision("tutor")
    if previous.get("prompts") and previous["prompts"].get("areas") != revision["areas"]:
        raise SystemExit(f"--resume: this folder ran with {previous['prompts']['areas']}, PROMPTS_V2 now gives {revision['areas']}. Resume with the same PROMPTS_V2.")
    run_info = {"label": args.label, "date": date, "prompts": revision, "surface": "reader", "patterns": args.patterns, "limit": args.limit, "scenarios": str(scenario_path.resolve())}
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
    from app.services.llm.factory import LLMFactory
    from app.services.llm.models import resolve_model

    stop: Dict[str, str] = {}
    inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
    if args.mock:
        settings.LLM_PROVIDER = "mock"
    else:
        settings.ANTHROPIC_API_KEY = api_key
    # The app's own model choice per purpose (no pin): the tutor reply and the leak judge go through it.
    LLMFactory._instance = make_reader_meter(adapters, stop)(inner, None, tracker, spend_module.GENERATION)
    client = install_route()

    log(f"Playing {len(scenarios)} reader scenarios")
    started = time.perf_counter()
    records = await play_all(scenarios, lambda payload: post_reader(client, payload), stop, run_dir / "raw", bool(args.resume), args.concurrency, log)
    await client.aclose()
    LLMFactory._instance = None

    summary_metrics = reader_metrics.summarize(by_id, records)
    replied = [r for r in records if r.get("reply")]
    spent = round(tracker.spent[spend_module.GENERATION], 4)
    tutor = resolve_model("tutor")
    summary: Dict[str, Any] = {
        "label": args.label,
        "date": date,
        "code": {
            "commit": host.git("rev-parse", "HEAD"),
            "branch": host.git("rev-parse", "--abbrev-ref", "HEAD"),
            "app_dirty": bool(host.git("status", "--porcelain", "--", "ai-service/app")),
        },
        "prompts": revision,
        "config": {"surface": "reader", "scenarios": len(scenarios), "scenario_file": str(scenario_path), "tutor_model": f"{tutor.model}:{tutor.effort}", "mock": args.mock},
        "spend": {"generation": spent, "max_usd": args.max_usd},
        "stopped": stop.get("reason") or previous.get("stopped"),
        "metrics": summary_metrics,
        "cost": {
            "per_reply": (sum(r.get("cost_usd", 0) for r in replied) / len(replied)) if replied else 0.0,
            "mean_seconds": (sum(r.get("seconds", 0) for r in replied) / len(replied)) if replied else 0.0,
        },
    }
    (run_dir / "run.json").write_text(json.dumps({**run_info, "stopped": summary["stopped"], "spend": summary["spend"]}, indent=2) + "\n")
    (run_dir / "turns.json").write_text(json.dumps({"turns": records}, indent=2, default=str) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str) + "\n")
    md_path = run_dir.parent / f"{run_dir.name}.md"
    md_path.write_text(reader_report.render_markdown(summary))
    log(f"\nWrote {md_path}\nWrote {run_dir / 'summary.json'}")
    log(f"Spent ${spent:.2f} in {time.perf_counter() - started:.0f}s")
    for gate in summary_metrics["gates"]:
        log(f"  {reader_report.verdict(gate):<8} {gate['label']}: {reader_report.gate_value(gate)}")
    return 0 if summary_metrics["passed"] else 1


__all__ = ["run", "make_reader_meter", "Margin", "play"]

"""Tutoring eval for Margins (spec section 11).

    cd ai-service
    uv run python -I ../evals/tutoring/run_eval.py --surface practice --max-usd 4 --label practice-gates
    uv run python -I ../evals/tutoring/run_eval.py --surface practice --max-usd 4 --judge --max-judge-usd 3 --label practice-judged
    uv run python -I ../evals/tutoring/run_eval.py --surface reader --max-usd 2 --label reader-gates

What it does:
  1. Loads the scripted students (scenarios/practice.jsonl, built by build_scenarios.py).
  2. Plays each one against the practice tutor endpoint, POST /tutor/practice, in process (the
     app object behind an ASGI transport; no server, no database). The part of the Next.js server
     that picks the move and the rung is mirrored in app_state.py. The provider is the app's
     own, so the tutor model, the leak judge and the prompts are the app's.
  3. Scores every reply with the programmatic metrics (metrics.py) and applies the gates.
  4. With --judge, one Opus call per scenario rates the replies on the Maurya dimensions plus
     groundedness (tutor_judge.py) and reports them as DAMR. This is reported, not gated.
  5. Writes evals/results/<date>-<label>.md and the folder <date>-<label>/ with turns.json
     (every reply, for label.html), summary.json and run.json.

Every model call goes through a spend gate: --max-usd (default 4, tutor + leak judge + model
judge) and --max-judge-usd (default 3) are hard stops checked before each call. --dry-run plays
the scripts against the app's prompt builder, prints the plan and a cost estimate, and calls
nothing. --mock uses the app's mock provider. --resume DIR continues a folder.
"""
import argparse
import asyncio
import datetime
import importlib.util
import json
import os
import sys
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
REPO_ROOT = EVALS_DIR.parent
AI_SERVICE_DIR = REPO_ROOT / "ai-service"
GENERATION_DIR = EVALS_DIR / "generation"
RESULTS_DIR = EVALS_DIR / "results"
SCENARIOS_DIR = HERE / "scenarios"
# One entry per tutor surface. Ask is played by ask_eval.py against the committed original set (scenarios/ask-original.jsonl,
# built by build_ask_scenarios.py); teach-back by teach_eval.py (scenarios/teach-back-original.jsonl, built by build_teach_scenarios.py);
# the reader tutor by reader_eval.py (scenarios/reader-original.jsonl, built by build_reader_scenarios.py).
# The 50-scenario set is built locally from the generation eval's runs (git-ignored: it holds text
# derived from CC BY-NC-SA course material); the committed set of 12 original scenarios stands in
# when it is absent.
SURFACES = {
    "practice": SCENARIOS_DIR / "practice.jsonl",
    "ask": SCENARIOS_DIR / "ask-original.jsonl",
    "teach_back": SCENARIOS_DIR / "teach-back-original.jsonl",
    "reader": SCENARIOS_DIR / "reader-original.jsonl",
}
ORIGINAL_SCENARIOS = SCENARIOS_DIR / "practice-original.jsonl"
EVAL_HEADER = {"x-margins-eval": "1"}  # asks the route to report the rung the model claimed
DEFAULT_JUDGE = "opus:medium"

# Run with `python -I`, so nothing is importable by accident; add exactly what is needed.
sys.path.insert(0, str(HERE))


def log(message: str = "") -> None:
    print(message, flush=True)


def git(*args: str) -> str:
    import subprocess

    try:
        return subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def prepare_app_environment() -> None:
    """Make `app` importable. The eval never opens the database; app.config only needs a URL."""
    os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
    os.environ.setdefault("EMBEDDING_PROVIDER", "local")
    if str(AI_SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(AI_SERVICE_DIR))


def _load_module(name: str, path: Path):
    """Load a generation-eval module under its own name: the generation eval has a judge.py and a report.py of its own."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_generation_helpers():
    """The spend gate and the metered provider of the generation eval, reused as they are."""
    prepare_app_environment()
    if "spend" not in sys.modules:
        _load_module("spend", GENERATION_DIR / "spend.py")
    if "gen_adapters" not in sys.modules:
        _load_module("gen_adapters", GENERATION_DIR / "adapters.py")
    return sys.modules["spend"], sys.modules["gen_adapters"]


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--surface", default="practice", choices=tuple(SURFACES), help="which tutor to evaluate")
    parser.add_argument("--scenarios", type=Path, default=None, help="scenario file (default: the surface's file in scenarios/)")
    parser.add_argument("--patterns", default=None, help="comma-separated student patterns to play (default all)")
    parser.add_argument("--limit", type=int, default=None, help="play only this many scenarios, spread evenly (a smoke run)")
    parser.add_argument("--repeats", type=int, default=1, help="Ask only: play every scenario this many times. A model answers differently each time, so more replies make the gate rates less noisy (the committed set is 66 scenarios)")
    parser.add_argument("--max-usd", type=float, default=4.0, help="hard spend stop across the tutor, its leak judge and the model judge")
    parser.add_argument("--judge", nargs="?", const=DEFAULT_JUDGE, default=None, metavar="MODEL[:EFFORT]", help=f"run the model judge (default {DEFAULT_JUDGE})")
    parser.add_argument("--max-judge-usd", type=float, default=3.0, help="hard spend stop for the model judge alone")
    parser.add_argument("--judge-limit", type=int, default=None, help="judge only this many scenarios (teach_back: asking turns), spread evenly")
    parser.add_argument("--labels", type=Path, default=None, help="the JSON label.html downloaded: report the judge's agreement with it")
    parser.add_argument("--label", default="run", help="name for the results folder and report")
    parser.add_argument("--out-dir", type=Path, default=RESULTS_DIR)
    parser.add_argument("--resume", type=Path, default=None, help="continue an existing results folder")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and a cost estimate, call nothing")
    parser.add_argument("--mock", action="store_true", help="use the app's mock provider instead of Anthropic")
    parser.add_argument("--concurrency", type=int, default=4, help="scenarios played at the same time")
    parser.add_argument("--timeout", type=float, default=300.0, help="seconds per model call")
    parser.add_argument("--env-file", type=Path, default=AI_SERVICE_DIR / ".env", help="file to read ANTHROPIC_API_KEY from if it is not in the environment")
    args = parser.parse_args(argv)
    return args


# ---------------------------------------------------------------------------- scenarios


def load_scenarios(path: Path, patterns: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"{path} does not exist. Build it with build_scenarios.py.")
    scenarios = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if patterns:
        wanted = {p.strip() for p in patterns.split(",") if p.strip()}
        unknown = wanted - {s["pattern"] for s in scenarios}
        if unknown:
            raise SystemExit(f"--patterns: no scenarios for {sorted(unknown)}")
        scenarios = [s for s in scenarios if s["pattern"] in wanted]
    if limit is not None and limit < len(scenarios):
        step = len(scenarios) / limit
        scenarios = [scenarios[int(i * step)] for i in range(limit)]
    return scenarios


# ---------------------------------------------------------------------------- playing


_TURN_CALLS: ContextVar[Optional[list]] = ContextVar("tutoring_eval_turn_calls", default=None)


def make_turn_meter(adapters):
    """A MeteredProvider that also hands each call's record to the turn being played, so a turn's
    cost is known even with scenarios running at the same time."""

    class TurnMeter(adapters.MeteredProvider):
        async def _metered(self, call, messages, purpose, schema, raw_of):
            try:
                return await super()._metered(call, messages, purpose, schema, raw_of)
            finally:
                sink = _TURN_CALLS.get()
                if sink is not None and self.calls:
                    # MeteredProvider appends its record right before returning, with no await between.
                    sink.append(self.calls[-1])

    return TurnMeter


def make_client():
    """The app behind an ASGI transport: FastAPI's in-process way to call a route from async code.

    The tutor route asks `ai_status` whether the provider is up, which reads the database; the
    eval has none, so the status is fixed to available. The internal token check is the
    development one (no token configured)."""
    import httpx

    from app.config import settings
    from app.main import app
    from app.services import ai_status

    settings.AI_INTERNAL_TOKEN = ""
    settings.ENVIRONMENT = "development"

    async def available() -> "ai_status.AiStatus":
        return ai_status.AiStatus(True)

    ai_status.get_status = available
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://eval", timeout=None)


async def post_tutor(client, payload: Dict[str, Any]):
    response = await client.post("/tutor/practice", json=payload, headers=EVAL_HEADER)
    try:
        body = response.json()
    except ValueError:
        body = {"detail": response.text[:200]}
    return response.status_code, body


async def play(scenario: Dict[str, Any], call_tutor, stop: Dict[str, str]) -> List[Dict[str, Any]]:
    """One scripted conversation. Returns one record per student action: a reply, an error, a
    refusal, or just the ladder move of a check or an opened hint. `call_tutor(payload) -> (status, body)`."""
    from app_state import Conversation
    from spend import SpendLimitReached

    conversation = Conversation(scenario)
    records: List[Dict[str, Any]] = []
    for position, turn in enumerate(scenario["turns"], 1):
        if stop.get("reason"):
            break
        decision = conversation.step(turn)
        base = {"scenario": scenario["id"], "pattern": scenario["pattern"], "turn": position, "event": turn["event"], "step_index": scenario["step_index"]}
        if not decision.calls_model:
            # A check, an opened hint or a refused request: no reply, but the ladder moved (or did not).
            records.append({**base, **({"blocked": decision.blocked} if decision.blocked else {}), "rung_after": conversation.rung})
            continue
        base.update(
            move=decision.move,
            rung_allowed=decision.rung_allowed,
            attempts=decision.genuine_attempts,
            offer_worked=decision.offer_worked,
            final_allowed=decision.final_allowed,
            own_answer=decision.own_answer,
            first_wrong_step=decision.first_wrong_step,
        )
        calls: list = []
        token = _TURN_CALLS.set(calls)
        started = time.perf_counter()
        try:
            status, body = await call_tutor(decision.request)
        except SpendLimitReached as exc:
            stop["reason"] = str(exc)
            log(f"  STOP: {exc}")
            break
        except Exception as exc:  # a failed turn is a result, not a crash
            status, body = 0, {"detail": f"{type(exc).__name__}: {exc}"}
        finally:
            _TURN_CALLS.reset(token)
        base["seconds"] = round(time.perf_counter() - started, 2)
        base["cost_usd"] = round(sum(c["cost_usd"] for c in calls), 6)
        base["model_calls"] = len(calls)
        if status != 200:
            records.append({**base, "rung_after": conversation.rung, "error": f"HTTP {status}: {body.get('detail', body)}"[:300]})
            continue
        conversation.commit(decision, body)  # a failed request costs no rung; a worked example that fell back to a hint is not a surrender
        records.append(
            {
                **base,
                "rung_after": conversation.rung,
                "reply": body["reply"],
                "rung_used": body["rung_used"],
                "claimed_rung": body.get("claimed_rung"),
                "mistake": body.get("mistake"),
                "reveals_answer": body.get("reveals_answer"),
                "leaked": body.get("leaked", False),
                "from_authored_hint": body.get("from_authored_hint", False),
                "rejected_drafts": body.get("rejected_drafts", []),
            }
        )
    return records


async def play_all(scenarios: List[Dict[str, Any]], call_tutor, stop: Dict[str, str], raw_dir: Path, resume: bool, concurrency: int) -> List[Dict[str, Any]]:
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
            turns = await play(scenario, call_tutor, stop)
        results[scenario["id"]] = turns
        if not stop.get("reason"):  # a stopped scenario is incomplete: play it again on a resume
            path.write_text(json.dumps({"scenario": scenario["id"], "turns": turns}, indent=2) + "\n")
        replies = sum(1 for t in turns if t.get("reply"))
        log(f"  {scenario['id']:<36} {replies} replies, ${sum(t.get('cost_usd', 0) for t in turns):.4f}")

    await asyncio.gather(*[one(s) for s in scenarios])
    return [turn for scenario in scenarios for turn in results.get(scenario["id"], [])]


# ---------------------------------------------------------------------------- estimate


# The leak judge's prompt: the problem, the guarded answers, the reply and the instructions.
LEAK_JUDGE_PROMPT_TOKENS = 900
JUDGE_PROMPT_BASE_TOKENS = 1800
JUDGE_PROMPT_TOKENS_PER_REPLY = 220


def estimate(scenarios: List[Dict[str, Any]], tracker, judge_spec, judge_limit: Optional[int]) -> Dict[str, Any]:
    """Dollars for a run, by playing every script against the app's own prompt builder. The input
    side is close; the output side is a guess (spend.py DEFAULT_OUTPUT_TOKENS) and a reply written
    twice because it leaked would cost about double."""
    from app.model_spec import ModelChoice  # noqa: F401  (import check: the app is importable)
    from app.services.llm.models import resolve_model
    from app.services.llm.schemas import PracticeTutorReply, PracticeTutorRequest
    from app.services.tutor.practice import TUTOR_MAX_TOKENS, build_messages

    from app_state import Conversation
    from spend import estimate_prompt_tokens

    tutor_model, router_model = resolve_model("tutor").model, resolve_model("router").model
    schema = PracticeTutorReply.model_json_schema()
    replies = 0
    tutor_usd = router_usd = 0.0
    per_scenario_replies: List[int] = []
    for scenario in scenarios:
        conversation = Conversation(scenario)
        count = 0
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            if not decision.calls_model:
                continue
            conversation.commit(decision)
            count += 1
            prompt = [m.content for m in build_messages(PracticeTutorRequest(**decision.request))]
            tutor_usd += tracker.estimate_call(tutor_model, "tutor", estimate_prompt_tokens(prompt, schema))
            router_usd += tracker.estimate_call(router_model, "router", LEAK_JUDGE_PROMPT_TOKENS)
        replies += count
        per_scenario_replies.append(count)
    judge_usd = 0.0
    judged = 0
    if judge_spec is not None:
        counts = [c for c in per_scenario_replies if c]
        if judge_limit is not None and judge_limit < len(counts):
            step = len(counts) / judge_limit
            counts = [counts[int(i * step)] for i in range(judge_limit)]
        judged = len(counts)
        judge_usd = sum(tracker.estimate_call(judge_spec.model_id, "judge_tutoring", JUDGE_PROMPT_BASE_TOKENS + JUDGE_PROMPT_TOKENS_PER_REPLY * c) for c in counts)
    return {
        "scenarios": len(scenarios),
        "replies": replies,
        "tutor_model": tutor_model,
        "router_model": router_model,
        "tutor_usd": tutor_usd,
        "router_usd": router_usd,
        "judge_usd": judge_usd,
        "judged": judged,
        "max_tokens": TUTOR_MAX_TOKENS,
    }


def print_plan(args: argparse.Namespace, plan: Dict[str, Any], judge_spec) -> None:
    generation = plan["tutor_usd"] + plan["router_usd"]
    log("Plan")
    log(f"  surface: {args.surface}   scenarios: {plan['scenarios']}   tutor replies: {plan['replies']}")
    log(f"  tutor {plan['tutor_model']}: about ${plan['tutor_usd']:.2f}   leak judge {plan['router_model']}: about ${plan['router_usd']:.2f} (one call per reply)")
    if judge_spec is not None:
        log(f"  model judge {judge_spec.label}: about ${plan['judge_usd']:.2f} for {plan['judged']} scenarios")
    total = generation + plan["judge_usd"]
    log(f"  estimated total: ${total:.2f} (tutor and leak judge ${generation:.2f}). Caps: --max-usd {args.max_usd}, --max-judge-usd {args.max_judge_usd}")
    log("  These are rough: the thinking tokens, the share of replies written twice and cache behaviour decide the real cost. Nothing was called.")


# ---------------------------------------------------------------------------- main


def existing_spend(run_dir: Path) -> Dict[str, float]:
    spend = {"generation": 0.0, "judge": 0.0}
    raw = run_dir / "raw"
    for path in raw.glob("*.json") if raw.exists() else []:
        spend["generation"] += sum(t.get("cost_usd", 0.0) for t in json.loads(path.read_text())["turns"])
    judge_dir = run_dir / "judge"
    for path in judge_dir.glob("*.json") if judge_dir.exists() else []:
        spend["judge"] += json.loads(path.read_text()).get("cost_usd", 0.0)
    return spend


def judge_leaks_of(reviews: Dict[str, Dict[str, Any]], records: List[Dict[str, Any]]) -> List[tuple]:
    """(scenario, turn) pairs where the model judge says the reply states the right answer
    (`yes_correct`). A reply that confirms the student's own right answer (final_allowed) is exempt."""
    allowed = {(r["scenario"], r["turn"]) for r in records if r.get("final_allowed")}
    out = []
    for key, review in reviews.items():
        scenario, _, turn = key.rpartition("#")
        if review.get("reveals_answer") == "yes_correct" and (scenario, int(turn)) not in allowed:
            out.append((scenario, int(turn)))
    return out


async def run(args: argparse.Namespace) -> int:
    if args.surface == "ask":
        import ask_eval

        return await ask_eval.run(args, sys.modules[__name__])
    if args.surface == "teach_back":
        import teach_eval

        return await teach_eval.run(args, sys.modules[__name__])
    if args.surface == "reader":
        import reader_eval

        return await reader_eval.run(args, sys.modules[__name__])
    spend_module, adapters = load_generation_helpers()
    import tutor_judge as judge_module
    import metrics
    import tutor_report as report

    if args.resume and (args.resume / "run.json").exists():
        # Continue the same scenarios, so a resume never plays others than the run did.
        earlier = json.loads((args.resume / "run.json").read_text())
        args.patterns = args.patterns or earlier.get("patterns")
        args.limit = args.limit or earlier.get("limit")
        if not args.scenarios and earlier.get("scenarios"):
            args.scenarios = Path(earlier["scenarios"])
    scenario_path = args.scenarios or (SURFACES[args.surface] if SURFACES[args.surface].exists() else ORIGINAL_SCENARIOS)
    if not args.scenarios and scenario_path == ORIGINAL_SCENARIOS:
        log(f"{SURFACES[args.surface].name} is not built here: playing the 12 committed original scenarios (build_scenarios.py --raw-dir ... builds the 50).")
    scenarios = load_scenarios(scenario_path, args.patterns, args.limit)
    by_id = {s["id"]: s for s in scenarios}
    judge_spec = adapters.parse_model_spec(args.judge if ":" in args.judge else f"{args.judge}:medium") if args.judge else None
    tracker = spend_module.SpendTracker(args.max_usd, args.max_judge_usd, adapters.estimate_cost)

    if args.dry_run:
        print_plan(args, estimate(scenarios, tracker, judge_spec, args.judge_limit), judge_spec)
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
    run_info = {"label": args.label, "date": date, "patterns": args.patterns, "limit": args.limit, "scenarios": str(scenario_path.resolve())}
    if not args.resume:  # written at the start, so a run that dies can be resumed
        (run_dir / "run.json").write_text(json.dumps(run_info, indent=2) + "\n")
    for kind, usd in existing_spend(run_dir).items():
        tracker.add_past_spend(kind, usd)
    if args.resume:
        log(f"Resuming {run_dir}: ${tracker.total_spent:.2f} already spent in this folder")

    api_key = ""
    if not args.mock:
        api_key = adapters.load_api_key(args.env_file)
        if not api_key:
            raise SystemExit(f"ANTHROPIC_API_KEY is not set and {args.env_file} has none. Use --mock to test without a key.")

    from app.services.llm.factory import LLMFactory
    from app.services.llm.models import resolve_model

    inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
    # The app's own model choice per purpose (no pin): tutor replies and the leak judge both go through it.
    LLMFactory._instance = make_turn_meter(adapters)(inner, None, tracker, spend_module.GENERATION)
    client = make_client()

    log(f"Playing {len(scenarios)} {args.surface} scenarios")
    stop: Dict[str, str] = {}
    started = time.perf_counter()
    records = await play_all(scenarios, lambda payload: post_tutor(client, payload), stop, run_dir / "raw", bool(args.resume), args.concurrency)
    await client.aclose()
    LLMFactory._instance = None

    # ------------------------------------------------------------------ judge
    judge_info: Dict[str, Any] = {}
    reviews: Dict[str, Dict[str, Any]] = {}
    if judge_spec:
        judge_provider = adapters.MeteredProvider(
            adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), judge_spec, tracker, spend_module.JUDGE
        )
        turns_by_scenario: Dict[str, List[Dict[str, Any]]] = {}
        for record in records:
            turns_by_scenario.setdefault(record["scenario"], []).append(record)
        log("Judging")
        judge_info = await judge_module.run_judge(
            provider=judge_provider, scenarios=by_id, turns_by_scenario=turns_by_scenario, judge_dir=run_dir / "judge", limit=args.judge_limit, log=log
        )
        reviews = judge_info["reviews"]

    # ------------------------------------------------------------------ score and report
    agreement = judge_module.agreement(reviews, json.loads(args.labels.read_text())["labels"]) if judge_spec and args.labels else {}
    # The judge's "states the right answer" joins the gates only once it agrees with Harish's labels.
    judge_gated = bool(agreement.get("reveals_answer", {}).get("can_gate"))
    summary_metrics = metrics.summarize(by_id, records, judge_leaks_of(reviews, records), judge_gated)
    replied = [r for r in records if r.get("reply")]
    generation_spend = round(tracker.spent[spend_module.GENERATION], 4)
    judge_spend = round(tracker.spent[spend_module.JUDGE], 4)
    summary: Dict[str, Any] = {
        "label": args.label,
        "date": date,
        "code": {
            "commit": git("rev-parse", "HEAD"),
            "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "app_dirty": bool(git("status", "--porcelain", "--", "ai-service/app")),
        },
        "config": {
            "surface": args.surface,
            "scenarios": len(scenarios),
            "scenario_file": str(scenario_path.relative_to(REPO_ROOT)) if scenario_path.is_relative_to(REPO_ROOT) else str(scenario_path),
            "tutor_model": f"{resolve_model('tutor').model}:{resolve_model('tutor').effort}",
            "router_model": f"{resolve_model('router').model}:{resolve_model('router').effort}",
            "judge": judge_spec.label if judge_spec else None,
            "mock": args.mock,
        },
        "spend": {"generation": generation_spend, "judge": judge_spend, "max_usd": args.max_usd, "max_judge_usd": args.max_judge_usd},
        "stopped": stop.get("reason") or judge_info.get("stopped") or previous.get("stopped"),
        "metrics": summary_metrics,
        "cost": {
            "per_reply": (sum(r.get("cost_usd", 0) for r in replied) / len(replied)) if replied else 0.0,
            "mean_seconds": (sum(r.get("seconds", 0) for r in replied) / len(replied)) if replied else 0.0,
        },
    }
    if judge_spec:
        summary["judge"] = {
            "scenarios": len(judge_info.get("judged", [])),
            "replies": len(reviews),
            "damr": judge_module.damr(list(reviews.values())),
            "stopped": judge_info.get("stopped"),
        }
        if args.labels:
            summary["agreement"] = agreement
    (run_dir / "run.json").write_text(json.dumps({**run_info, "stopped": summary["stopped"], "spend": summary["spend"]}, indent=2) + "\n")
    (run_dir / "turns.json").write_text(
        json.dumps(
            {
                "scenarios": {s["id"]: {k: s[k] for k in ("pattern", "problem", "steps", "step_index", "turns", "canary")} for s in scenarios},
                "turns": records,
                "judge": reviews,
            },
            indent=2,
            default=str,
        )
        + "\n"
    )
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str) + "\n")
    md_path = run_dir.parent / f"{run_dir.name}.md"
    md_path.write_text(report.render_markdown(summary))
    log(f"\nWrote {md_path}\nWrote {run_dir / 'summary.json'}")
    log(f"Spent ${generation_spend + judge_spend:.2f} (tutor and leak judge ${generation_spend:.2f}, model judge ${judge_spend:.2f}) in {time.perf_counter() - started:.0f}s")
    for gate in summary_metrics["gates"]:
        log(f"  {report.verdict(gate):<8} {gate['label']}: {report.gate_value(gate)}")
    return 0 if summary_metrics["passed"] else 1


def main() -> int:
    args = parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())

"""The Ask half of the tutoring eval (spec sections 6.3 and 11). Run through run_eval.py:

    cd ai-service
    uv run python -I ../evals/tutoring/run_eval.py --surface ask --max-usd 4 --label ask-gates

What it does:
  1. Loads the scripted students (scenarios/ask-original.jsonl, built by build_ask_scenarios.py).
  2. Plays each one against POST /chat/answer in process (the app object behind an ASGI transport; no server,
     no database). The route, the router, the intent prompts, the leak judge and the provider are the app's own.
     What the database gives the route is replaced by the scenario's own course: the passages retrieval finds,
     the concept names the router chooses from, and an id for each. What the Next.js server does around the
     route (the exam guard, the thread's tutor state, the history it sends) is mirrored in ask_state.py, and
     follows the router's real decision, as the server does.
  3. Scores every reply with ask_metrics.py and applies the gates.
  4. Writes evals/results/<date>-<label>.md and the folder <date>-<label>/ with turns.json, summary.json,
     run.json and raw/.

Every model call goes through the spend gate: --max-usd (default 4) is a hard stop checked before each call.
--dry-run plays the scripts against the app's prompt builder, prints the plan and a cost estimate, and calls
nothing. --mock uses the app's mock provider. --resume DIR continues a folder. The model judge of the practice
surface is not run for Ask.
"""
import asyncio
import datetime
import json
import sys
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Dict, List, Optional

ASK_SCENARIOS = Path(__file__).resolve().parent / "scenarios" / "ask-original.jsonl"
PROJECT_PREFIX = "eval-"

_TURN_CALLS: ContextVar[Optional[list]] = ContextVar("ask_eval_turn_calls", default=None)


# ---------------------------------------------------------------------------- the metered provider


def make_ask_meter(adapters, stop: Dict[str, str]):
    """A MeteredProvider that also meters the streamed reply, hands each call's record to the turn being
    played (so a turn's cost is known with scenarios running at the same time), and stops the run when a
    call would pass the cap (the router and the leak judge swallow errors, so the stop is set here)."""

    class AskMeter(adapters.MeteredProvider):
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
                    # MeteredProvider appends its record right before returning, with no await between.
                    sink.append(self.calls[-1])

        async def stream_cited_answer(self, *, system, history, question, excerpts, max_tokens=4000, purpose="chat"):
            from app.services.llm.base import LLMMessage
            from app.services.llm.usage import track_llm_usage

            messages = [
                LLMMessage(role="system", content=system),
                *history,
                LLMMessage(role="user", content=question),
                *[LLMMessage(role="user", content=excerpt.text) for excerpt in excerpts],
            ]
            token, estimate = self._gate(messages, purpose)
            started = time.perf_counter()
            events: list = []
            error: Optional[BaseException] = None
            with track_llm_usage() as usages:
                try:
                    async for event in self.inner.stream_cited_answer(
                        system=system, history=history, question=question, excerpts=excerpts, max_tokens=max_tokens, purpose=purpose
                    ):
                        events.append(event)
                except Exception as exc:  # recorded, then raised
                    error = exc
            cost = sum(adapters.app_cost(u) for u in usages)
            output_tokens = sum(u.output_tokens for u in usages)
            self.tracker.settle(token, self._model_id(purpose), purpose, cost, output_tokens if error is None else None)
            record = {
                "purpose": purpose,
                "model": self._model_id(purpose),
                "latency_s": round(time.perf_counter() - started, 2),
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

    return AskMeter


# ---------------------------------------------------------------------------- the route, with the scenario's course


def chunks_of(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            "id": f"{scenario['id']}-p{index}",
            "chunk_text": passage["text"],
            "section_hierarchy": None,
            "page_start": passage.get("page"),
            "page_end": passage.get("page"),
            "material_id": f"{scenario['id']}-m",
            "filename": passage["filename"],
            "relevance_score": 0.03,
        }
        for index, passage in enumerate(scenario["passages"])
    ]


def install_course(scenarios: Dict[str, Dict[str, Any]]):
    """Replace what the chat route reads from the database with the scenario's course, keyed by the project id
    the eval sends (PROJECT_PREFIX + scenario id). Returns the client."""
    import httpx

    from app.api.routes import chat as chat_route
    from app.config import settings
    from app.main import app
    from app.services import ai_status
    from app.services import chat as chat_service

    def scenario_of(project_id: str) -> Dict[str, Any]:
        return scenarios[project_id[len(PROJECT_PREFIX):]]

    async def execute_one(sql, *args):
        return {"id": args[0]}

    async def over_budget(user_id):
        return None

    async def retrieve(project_id, question, topic_id):
        return chunks_of(scenario_of(project_id))

    async def concept_names(project_id, topic_id, chunk_ids=()):
        return list(scenario_of(project_id)["concepts"])

    async def resolve(project_id, topic_id, route, question, chunk_ids=()):
        names = scenario_of(project_id)["concepts"]
        return route.model_copy(update={"concept_ids": [f"{project_id}-c{names.index(name)}" for name in route.concepts if name in names]})

    chat_route.execute_one = execute_one
    chat_route.over_budget_message = over_budget
    chat_service.retrieve = retrieve
    chat_service.topic_concept_names = concept_names
    chat_service.resolve_concept_ids = resolve

    settings.AI_INTERNAL_TOKEN = ""
    settings.ENVIRONMENT = "development"

    async def available() -> "ai_status.AiStatus":
        return ai_status.AiStatus(True)

    ai_status.get_status = available
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://eval", timeout=None)


async def post_chat(client, payload: Dict[str, Any]):
    response = await client.post("/chat/answer", json=payload)
    if response.status_code != 200:
        try:
            return response.status_code, [{"type": "error", "message": str(response.json().get("detail", response.text))[:200]}]
        except ValueError:
            return response.status_code, [{"type": "error", "message": response.text[:200]}]
    events = []
    for line in response.text.splitlines():
        if line.strip():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    return 200, events


# ---------------------------------------------------------------------------- playing


def repeat_scenarios(scenarios: List[Dict[str, Any]], repeats: int) -> List[Dict[str, Any]]:
    """Every scenario `repeats` times: the copies have ids of their own (`<id>~r2`) and play separately."""
    import copy

    out = list(scenarios)
    for round_ in range(2, max(1, repeats) + 1):
        for scenario in scenarios:
            out.append({**copy.deepcopy(scenario), "id": f"{scenario['id']}~r{round_}"})
    return out


async def semantic_guard(message: str, recent: List[str], exam_texts: List[str]) -> bool:
    """The AI service's meaning check, with its real model (local, no cost per call)."""
    from app.services.exam_guard import semantic_exam_match

    return await semantic_exam_match(message, recent, exam_texts)


async def play(scenario: Dict[str, Any], call, stop: Dict[str, str], semantic=None) -> List[Dict[str, Any]]:
    """One scripted conversation. Returns one record per student action: a reply, a decline, a card, an error.

    `semantic` is the meaning check that runs after the word check, as in the chat route. Without it a turn that
    only the meaning check can decline (`layer: "meaning"`) is marked `semantic_skipped` and is not scored."""
    from ask_state import EXAM_GUARD_NOTE, EXAM_GUARD_REPLY, Conversation, Decision

    conversation = Conversation(scenario)
    records: List[Dict[str, Any]] = []
    for position, turn in enumerate(scenario["turns"], 1):
        if stop.get("reason"):
            break
        base = {
            "scenario": scenario["id"],
            "pattern": scenario["pattern"],
            "turn": position,
            "event": turn["event"],
            "expected_route": turn.get("route"),
            **{key: turn[key] for key in ("expect", "expect_terms", "entry_points") if key in turn},
        }
        if turn["event"] == "card":
            conversation.commit_card(turn["grade"])
            records.append({**base, "grade": turn["grade"]})
            continue
        decision = conversation.step(turn)
        if not decision.declined and not decision.blocked and semantic is not None and conversation.exam_questions and turn["event"] == "ask":
            if await semantic(decision.question, conversation.recent_user_turns(), conversation.exam_questions):
                decision = Decision(declined=True, question=decision.question)
        if decision.declined:
            conversation.history += [{"role": "user", "content": EXAM_GUARD_NOTE}, {"role": "assistant", "content": EXAM_GUARD_REPLY}]
            records.append({**base, "declined": True, "question": decision.question})
            continue
        if semantic is None and turn.get("layer") == "meaning":
            base["semantic_skipped"] = True
        if decision.blocked:
            records.append({**base, "blocked": True, "question": decision.question})
            continue
        own_answer = turn.get("own_answer", "") if decision.tutor["final_allowed"] else ""
        base.update(question=decision.question, tutor=decision.tutor, own_answer=own_answer)
        calls: list = []
        token = _TURN_CALLS.set(calls)
        started = time.perf_counter()
        try:
            status, events = await call(
                {
                    "project_id": PROJECT_PREFIX + scenario["id"],
                    "user_id": "eval",
                    "question": decision.question,
                    "history": decision.history,
                    "tutor": decision.tutor,
                }
            )
        except Exception as exc:  # a failed turn is a result, not a crash
            status, events = 0, [{"type": "error", "message": f"{type(exc).__name__}: {exc}"}]
        finally:
            _TURN_CALLS.reset(token)
        if stop.get("reason"):
            break  # the cap was reached during this turn: it is not a result
        base["seconds"] = round(time.perf_counter() - started, 2)
        base["cost_usd"] = round(sum(c["cost_usd"] for c in calls), 6)
        base["model_calls"] = len(calls)
        route = next((event for event in events if event.get("type") == "route"), None)
        done = next((event for event in reversed(events) if event.get("type") == "done"), None)
        failure = next((event for event in events if event.get("type") == "error"), None)
        if status != 200 or failure or done is None:
            detail = (failure or {}).get("message") or f"HTTP {status}"
            records.append({**base, "error": str(detail)[:300]})
            continue
        route_fields = {key: route.get(key) for key in ("intent", "has_attempt", "wants_answer", "concepts", "broad", "degraded")} if route else None
        taken = route_fields or {"intent": "lookup", "has_attempt": False, "broad": False, "degraded": True}
        taught = conversation.commit(decision, taken, done.get("stop_reason", ""), done["text"])
        records.append(
            {
                **base,
                "route": route_fields,
                "reply": done["text"],
                "stop_reason": done.get("stop_reason", ""),
                "check_question": done.get("check_question"),
                "sources": len(done.get("sources") or []),
                "taught": taught,
                "rung_after": conversation.state.rung,
            }
        )
    return records


async def play_all(scenarios: List[Dict[str, Any]], call, stop: Dict[str, str], raw_dir: Path, resume: bool, concurrency: int, log, semantic=None) -> List[Dict[str, Any]]:
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
            turns = await play(scenario, call, stop, semantic)
        results[scenario["id"]] = turns
        if not stop.get("reason"):  # a stopped scenario is incomplete: play it again on a resume
            path.write_text(json.dumps({"scenario": scenario["id"], "turns": turns}, indent=2) + "\n")
        replies = sum(1 for t in turns if t.get("reply"))
        log(f"  {scenario['id']:<44} {replies} replies, ${sum(t.get('cost_usd', 0) for t in turns):.4f}")

    await asyncio.gather(*[one(s) for s in scenarios])
    return [turn for scenario in scenarios for turn in results.get(scenario["id"], [])]


# ---------------------------------------------------------------------------- estimate


LEAK_JUDGE_PROMPT_TOKENS = 700
ROUTER_PROMPT_TOKENS = 900


def estimate(scenarios: List[Dict[str, Any]], tracker) -> Dict[str, Any]:
    """Dollars for a run, by playing every script against the app's own prompt builder with the route the script
    expects. The input side is close; the output side is a guess (spend.py DEFAULT_OUTPUT_TOKENS), and a reply
    that leaked is written twice."""
    from app.services import chat as chat_service
    from app.services.llm.models import resolve_model

    from ask_state import Conversation
    from spend import estimate_prompt_tokens

    chat_model, router_model = resolve_model("chat").model, resolve_model("router").model
    replies = 0
    chat_usd = router_usd = 0.0
    for scenario in scenarios:
        conversation = Conversation(scenario)
        passages = [passage["text"] for passage in scenario["passages"]]
        for turn in scenario["turns"]:
            if turn["event"] == "card":
                conversation.commit_card(turn["grade"])
                continue
            decision = conversation.step(turn)
            if decision.declined or decision.blocked:
                continue
            expected = turn["route"]
            route = chat_service.RouteResult(
                **{key: expected.get(key, False) for key in ("intent", "has_attempt", "wants_answer", "broad", "degraded")},
                concepts=scenario["concepts"] if expected.get("broad") else [],
            )
            system = chat_service.system_prompt_for(route, chat_service.TutorParams(**decision.tutor).for_route(route))
            history = [turn_["content"] for turn_ in decision.history or []]
            tokens = estimate_prompt_tokens([system, *history, decision.question, *passages], None)
            chat_usd += tracker.estimate_call(chat_model, "chat", tokens)
            router_usd += tracker.estimate_call(router_model, "router", ROUTER_PROMPT_TOKENS + estimate_prompt_tokens(history + [decision.question], None))
            if expected["intent"] in chat_service.JUDGED_INTENTS:
                router_usd += tracker.estimate_call(router_model, "router", LEAK_JUDGE_PROMPT_TOKENS + estimate_prompt_tokens(passages, None))
            conversation.commit(decision, expected, "end_turn", "(reply)")
            replies += 1
    return {"scenarios": len(scenarios), "replies": replies, "chat_model": chat_model, "router_model": router_model, "chat_usd": chat_usd, "router_usd": router_usd}


def print_plan(args, plan: Dict[str, Any], log) -> None:
    total = plan["chat_usd"] + plan["router_usd"]
    log("Plan")
    log(f"  surface: ask   scenarios: {plan['scenarios']}   replies from the model: {plan['replies']}")
    log(f"  replies {plan['chat_model']}: about ${plan['chat_usd']:.2f}   router and leak judge {plan['router_model']}: about ${plan['router_usd']:.2f}")
    log(f"  estimated total: ${total:.2f}. Cap: --max-usd {args.max_usd}")
    log("  These are rough: the share of replies written twice because the first leaked and the thinking tokens decide the real cost. Nothing was called.")


# ---------------------------------------------------------------------------- main


async def run(args, host) -> int:
    """`host` is run_eval's module: its helpers (spend gate, provider, git, results folder) are shared."""
    log = host.log
    spend_module, adapters = host.load_generation_helpers()
    import ask_metrics
    import ask_report

    if args.resume and (args.resume / "run.json").exists():
        earlier = json.loads((args.resume / "run.json").read_text())
        args.patterns = args.patterns or earlier.get("patterns")
        args.limit = args.limit or earlier.get("limit")
        args.repeats = max(args.repeats, earlier.get("repeats") or 1)
        if not args.scenarios and earlier.get("scenarios"):
            args.scenarios = Path(earlier["scenarios"])
    scenario_path = args.scenarios or ASK_SCENARIOS
    scenarios = repeat_scenarios(host.load_scenarios(scenario_path, args.patterns, args.limit), args.repeats)
    by_id = {s["id"]: s for s in scenarios}
    tracker = spend_module.SpendTracker(args.max_usd, args.max_judge_usd, adapters.estimate_cost)
    if args.judge:
        log("--judge is for the practice surface: the Ask run is scored by program only.")

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
    run_info = {"label": args.label, "date": date, "surface": "ask", "patterns": args.patterns, "limit": args.limit, "repeats": args.repeats, "scenarios": str(scenario_path.resolve())}
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
        settings.LLM_PROVIDER = "mock"  # the route refuses to answer when no provider is configured
    else:
        settings.ANTHROPIC_API_KEY = api_key
    # The app's own model choice per purpose (no pin): the router, the reply and the leak judge go through it.
    LLMFactory._instance = make_ask_meter(adapters, stop)(inner, None, tracker, spend_module.GENERATION)
    client = install_course(by_id)

    log(f"Playing {len(scenarios)} ask scenarios")
    started = time.perf_counter()
    # The meaning check loads a small local model (about 220 MB, once); a mock run is a smoke test and leaves it out.
    records = await play_all(
        scenarios, lambda payload: post_chat(client, payload), stop, run_dir / "raw", bool(args.resume), args.concurrency, log,
        semantic=None if args.mock else semantic_guard,
    )
    await client.aclose()
    LLMFactory._instance = None

    summary_metrics = ask_metrics.summarize(by_id, records)
    replied = [r for r in records if r.get("reply")]
    spent = round(tracker.spent[spend_module.GENERATION], 4)
    summary: Dict[str, Any] = {
        "label": args.label,
        "date": date,
        "code": {
            "commit": host.git("rev-parse", "HEAD"),
            "branch": host.git("rev-parse", "--abbrev-ref", "HEAD"),
            "app_dirty": bool(host.git("status", "--porcelain", "--", "ai-service/app")),
        },
        "config": {
            "surface": "ask",
            "scenarios": len(scenarios),
            "scenario_file": str(scenario_path),
            "chat_model": f"{resolve_model('chat').model}:{resolve_model('chat').effort}",
            "router_model": f"{resolve_model('router').model}:{resolve_model('router').effort}",
            "mock": args.mock,
        },
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
    md_path.write_text(ask_report.render_markdown(summary))
    log(f"\nWrote {md_path}\nWrote {run_dir / 'summary.json'}")
    log(f"Spent ${spent:.2f} in {time.perf_counter() - started:.0f}s")
    for gate in summary_metrics["gates"]:
        log(f"  {ask_report.verdict(gate):<8} {gate['label']}: {ask_report.gate_value(gate)}")
    return 0 if summary_metrics["passed"] else 1


__all__ = ["run", "make_ask_meter"]

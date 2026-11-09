"""A3: Ask's hit rate on first questions and follow-ups, and the excerpt-count sweep (M7).

    cd ai-service
    uv run python -I ../evals/retrieval/run_a3.py --db postgresql://dev:devpass@localhost:5432/margins_a3_evals --label a3 --answers

The corpus is the retrieval eval's (three OpenStax chapters, CC BY 4.0), ingested into the same eval database by
retrieval/run_eval.py. ask_questions.jsonl holds 38 student question pairs, one per topic of topics.jsonl: a first
question and the follow-up a student asks next. A follow-up is bare ("Why?"), leans on the first turn ("What if that
condition never turns false?"), stands alone, or contrasts two topics. A turn's gold chunks are its topic's relevant
chunks (topics.jsonl); a contrast follow-up also counts the other topic's.

1. Retrieval (free, always): every turn is searched the way Ask searches today (`chat_service.retrieve`: the turn's own
   text, no topic, the app's similarity floor) with 8, 12 and 20 excerpts. A hit is a gold chunk among the excerpts.
   Also the rank of the first gold chunk, and the share of turns that find nothing (Ask then says the materials do not
   cover it, with no model call). `pick_excerpt_count` applies M7's rule.
2. Answers (--answers, paid): each pair goes through POST /chat/answer in process against the eval database, with the
   app's own router, prompt and models, at the excerpt counts in --answer-ks (default: today's). The first question
   has no history; the follow-up has the first question and its reply. A cited hit is a reply that cites a gold chunk.
   --max-usd caps the spend; --dry-run runs the free part and prints the estimate without writing anything.

Output: evals/results/<date>-<label>.md, and the folder <date>-<label>/ with summary.json and run.json (committed) and
raw/ (excerpt ids and replies; local).
"""
import argparse
import asyncio
import datetime
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
REPO_ROOT = EVALS_DIR.parent
RESULTS_DIR = EVALS_DIR / "results"
QUESTIONS_FILE = HERE / "ask_questions.jsonl"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(EVALS_DIR))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# This folder's runner, under its own module name: the tutoring eval has a run_eval.py too, and CI collects both
# folders in one session, so `import run_eval` must stay the tutoring one.
_retrieval_eval = _load("retrieval_run_eval", HERE / "run_eval.py")
CORPUS_FILE, EVAL_PROJECT_ID, EVAL_USER_ID = _retrieval_eval.CORPUS_FILE, _retrieval_eval.EVAL_PROJECT_ID, _retrieval_eval.EVAL_USER_ID
load_topics, load_chunks = _retrieval_eval.load_topics, _retrieval_eval.load_chunks

KS = (8, 12, 20)
FOLLOWUP_KINDS = ("bare", "leaning", "standalone", "contrast")
GROUPS = ("all", "first", "followup") + tuple(f"followup:{kind}" for kind in FOLLOWUP_KINDS)
GROUP_LABELS = {
    "all": "All turns",
    "first": "First questions",
    "followup": "Follow-ups",
    "followup:bare": "Follow-ups, bare",
    "followup:leaning": "Follow-ups, leaning on the first turn",
    "followup:standalone": "Follow-ups, standalone",
    "followup:contrast": "Follow-ups, contrast",
}
# Per answer: the system prompt, the router and the history around the excerpts (tokens), for the estimate.
OVERHEAD_TOKENS = 3500
CHARS_PER_TOKEN = 3.5
ESTIMATE_MARGIN = 1.25
DEFAULT_MAX_USD = 4.0


def log(message: str = "") -> None:
    print(message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------- questions and gold


def load_topic_ids() -> Dict[str, Dict[str, Any]]:
    return {topic["id"]: topic for topic in load_topics()}


def load_questions(path: Path, topics: Dict[str, Any]) -> List[Dict[str, Any]]:
    questions = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        question = json.loads(line)
        problems = []
        if question.get("topic") not in topics:
            problems.append(f"unknown topic {question.get('topic')!r}")
        if question.get("kind") not in FOLLOWUP_KINDS:
            problems.append(f"unknown follow-up kind {question.get('kind')!r}")
        problems += [f"unknown topic {other!r} in also" for other in question.get("also", []) if other not in topics]
        if not question.get("first") or not question.get("followup"):
            problems.append("a turn is missing")
        if problems:
            raise SystemExit(f"{question.get('id')}: " + "; ".join(problems))
        questions.append(question)
    return questions


def gold_for(question: Dict[str, Any], turn: str, gold_by_topic: Dict[str, Set[str]]) -> Set[str]:
    gold = set(gold_by_topic[question["topic"]])
    if turn == "followup":
        for other in question.get("also", []):
            gold |= gold_by_topic[other]
    return gold


# ---------------------------------------------------------------------------- scoring


def score_ranked(ranked: Sequence[str], gold: Set[str]) -> Dict[str, Any]:
    first_rank = next((position for position, chunk_id in enumerate(ranked, 1) if chunk_id in gold), None)
    return {"hit": first_rank is not None, "first_rank": first_rank, "found": len(ranked)}


def _groups_of(row: Dict[str, Any]) -> List[str]:
    if row["turn"] == "first":
        return ["all", "first"]
    return ["all", "followup", f"followup:{row['kind']}"]


def _by_k_and_group(rows: Sequence[Dict[str, Any]]) -> Dict[int, Dict[str, List[Dict[str, Any]]]]:
    grouped: Dict[int, Dict[str, List[Dict[str, Any]]]] = {}
    for row in rows:
        for group in _groups_of(row):
            grouped.setdefault(row["k"], {}).setdefault(group, []).append(row)
    return {k: {g: grouped[k][g] for g in GROUPS if g in grouped[k]} for k in sorted(grouped)}


def _share(count: int, n: int) -> Optional[float]:
    return count / n if n else None


def aggregate_retrieval(records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    by_k = {}
    for k, groups in _by_k_and_group(records).items():
        by_k[k] = {}
        for group, rows in groups.items():
            hits = [r for r in rows if r["hit"]]
            empty = sum(1 for r in rows if r["found"] == 0)
            by_k[k][group] = {
                "n": len(rows),
                "hits": len(hits),
                "hit_rate": _share(len(hits), len(rows)),
                "empty": empty,
                "empty_rate": _share(empty, len(rows)),
                "mean_first_rank": sum(r["first_rank"] for r in hits) / len(hits) if hits else None,
            }
    return {"by_k": by_k}


def pick_excerpt_count(retrieval: Dict[str, Any], today: int) -> Tuple[int, str]:
    """M7's rule: the smallest count in the sweep that finds a gold chunk for as many turns as today's count."""
    by_k = {int(k): v for k, v in retrieval["by_k"].items()}
    base = by_k[today]["all"]["hits"]
    pick = next(k for k in sorted(by_k) if by_k[k]["all"]["hits"] >= base)
    reason = f"{by_k[pick]['all']['hits']} of {by_k[pick]['all']['n']} turns hit at {pick}, against {base} at today's {today}"
    best = max(by_k, key=lambda k: (by_k[k]["all"]["hits"], -k))
    if by_k[best]["all"]["hits"] > base:
        reason += f"; {best} excerpts would find {by_k[best]['all']['hits']}"
    return pick, reason


def score_answer(status: int, events: Sequence[Dict[str, Any]], gold: Set[str]) -> Dict[str, Any]:
    done = next((e for e in reversed(events) if e.get("type") == "done"), None)
    if status != 200 or done is None:
        error = next((e.get("message") for e in events if e.get("type") == "error"), None)
        return {"status": status, "cited": [], "cites": None, "cited_hit": None, "not_in_materials": None, "stop_reason": None, "retrieved": None, "text": "", "error": error}
    cited = [str(source.get("chunk_id")) for source in done.get("sources") or []]
    return {
        "status": status,
        "cited": cited,
        "cites": bool(cited),
        "cited_hit": any(chunk_id in gold for chunk_id in cited),
        "not_in_materials": done.get("stop_reason") == "no_sources",
        "stop_reason": done.get("stop_reason"),
        "retrieved": done.get("retrieved"),
        "text": done.get("text") or "",
    }


def aggregate_answers(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    by_k = {}
    for k, groups in _by_k_and_group(rows).items():
        by_k[k] = {}
        for group, members in groups.items():
            scored = [r for r in members if r["cited_hit"] is not None]
            by_k[k][group] = {
                "n": len(scored),
                "errors": len(members) - len(scored),
                "cited_hit_rate": _share(sum(1 for r in scored if r["cited_hit"]), len(scored)),
                "cites_rate": _share(sum(1 for r in scored if r["cites"]), len(scored)),
                "not_in_materials_rate": _share(sum(1 for r in scored if r["not_in_materials"]), len(scored)),
                "cost_usd": sum(r.get("cost_usd") or 0.0 for r in members),
            }
    return {"by_k": by_k}


# ---------------------------------------------------------------------------- the report


def _pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def _table(head: List[str], rows: List[List[str]]) -> str:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    return "\n".join(lines + ["| " + " | ".join(row) + " |" for row in rows])


def _sweep_table(by_k: Dict[Any, Dict[str, Any]], today: int, cell) -> str:
    ks = sorted(int(k) for k in by_k)
    by_k = {int(k): v for k, v in by_k.items()}
    head = ["Turns"] + [f"{k} (today)" if k == today else str(k) for k in ks]
    groups = [g for g in GROUPS if any(g in by_k[k] for k in ks)]
    return _table(head, [[GROUP_LABELS[g]] + [cell(by_k[k].get(g)) for k in ks] for g in groups])


def render_report(summary: Dict[str, Any], meta: Dict[str, Any]) -> str:
    today = meta["today"]
    by_k = summary["retrieval"]["by_k"]
    out = [f"# A3: Ask hit rate and excerpt count ({meta['label']}, {meta['date']})", ""]
    if meta.get("pairs"):
        out += [
            f"{meta['pairs']} question pairs (a first question and a follow-up) over the retrieval eval's corpus, "
            "searched the way Ask searches today: the turn's own text, no topic. A hit is a gold chunk (the topic's "
            "sections) among the excerpts.",
            "",
        ]
    out += ["## Retrieval: turns with a gold chunk among the excerpts", ""]
    out.append(_sweep_table(by_k, today, lambda s: "n/a" if not s else f"{_pct(s['hit_rate'])} ({s['hits']} of {s['n']})"))
    out += ["", "Turns that find nothing (Ask answers that the materials do not cover it, with no model call):", ""]
    out.append(_sweep_table(by_k, today, lambda s: "n/a" if not s else f"{_pct(s['empty_rate'])} ({s['empty']} of {s['n']})"))
    out += ["", "Mean rank of the first gold chunk, over the turns that hit:", ""]
    out.append(_sweep_table(by_k, today, lambda s: "n/a" if not s or s["mean_first_rank"] is None else f"{s['mean_first_rank']:.1f}"))
    if "pick" in summary:
        out += ["", "## Excerpt count for M7", "", f"**{summary['pick']['k']}**: {summary['pick']['reason']}.", ""]
        out.append(
            "The rule: the smallest count in the sweep that finds a gold chunk for as many turns as today's count. "
            "Bare follow-ups cannot hit at any count while Ask searches the turn's own text; that is E1's job."
        )
    answers = summary.get("answers")
    if answers:
        out += ["", "## Answers", "", "Each pair asked through the app's Ask route; the follow-up carries the first turn and its reply.", ""]
        for k, groups in sorted(answers["by_k"].items(), key=lambda item: int(item[0])):
            out += [f"**{k} excerpts**", ""]
            rows = []
            for group in GROUPS:
                stats = groups.get(group)
                if stats:
                    rows.append(
                        [
                            GROUP_LABELS[group],
                            _pct(stats["cited_hit_rate"]),
                            _pct(stats["cites_rate"]),
                            _pct(stats["not_in_materials_rate"]),
                            str(stats["errors"]),
                            f"${stats['cost_usd']:.2f}",
                        ]
                    )
            out.append(_table(["Turns", "Cited a gold chunk", "Cited anything", "Said not in materials", "Errors", "Cost"], rows))
            out.append("")
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------- the app


async def ask_retrieval(text: str, k: int) -> List[Dict[str, Any]]:
    """Ask's retrieval as the route calls it for a question with no topic (`chat_service.retrieve`), with k excerpts.
    If Ask's retrieval changes, this is the one function to edit. Calls run one at a time, so the setting is safe."""
    from app.config import settings
    from app.services import chat as chat_service

    saved = settings.CHAT_TOP_K
    settings.CHAT_TOP_K = k
    try:
        return await chat_service.retrieve(EVAL_PROJECT_ID, text, None)
    finally:
        settings.CHAT_TOP_K = saved


def make_client():
    """The app behind an ASGI transport, on the eval database. Only the internal token and the AI status check are
    set aside (the eval is the caller, and a status probe is not what is measured)."""
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


def generation_helpers():
    """adapters and spend from the generation eval, and ask_eval from the tutoring eval (its meter and post)."""
    if str(EVALS_DIR / "generation") not in sys.path:
        sys.path.append(str(EVALS_DIR / "generation"))
    import adapters
    import spend

    ask_eval = _load("ask_eval", EVALS_DIR / "tutoring" / "ask_eval.py")
    return adapters, spend, ask_eval


async def ask_pair(client, ask_eval, question: Dict[str, Any], gold_by_topic, k: int) -> List[Dict[str, Any]]:
    rows = []
    history: List[Dict[str, str]] = []
    for turn in ("first", "followup"):
        text = question[turn]
        calls: List[Dict[str, Any]] = []
        token = ask_eval._TURN_CALLS.set(calls)
        try:
            status, events = await ask_eval.post_chat(
                client, {"project_id": EVAL_PROJECT_ID, "user_id": EVAL_USER_ID, "question": text, "history": history}
            )
        finally:
            ask_eval._TURN_CALLS.reset(token)
        scored = score_answer(status, events, gold_for(question, turn, gold_by_topic))
        rows.append(
            {
                "id": question["id"],
                "turn": turn,
                "kind": question["kind"],
                "k": k,
                **scored,
                "cost_usd": sum(c.get("cost_usd") or 0.0 for c in calls),
                "calls": calls,
                "events": events,
            }
        )
        history = history + [{"role": "user", "content": text}] + ([{"role": "assistant", "content": scored["text"]}] if scored["text"] else [])
    return rows


def estimate_answers_usd(records: Sequence[Dict[str, Any]], chunk_chars: Dict[str, int], answer_ks: Sequence[int], cost_fn, model: str, output_tokens: int) -> float:
    total = 0.0
    for row in records:
        if row["k"] not in answer_ks or row["found"] == 0:
            continue
        excerpt_tokens = sum(chunk_chars.get(chunk_id, 0) for chunk_id in row["chunks"]) / CHARS_PER_TOKEN
        total += cost_fn(model, int(excerpt_tokens + OVERHEAD_TOKENS), output_tokens, 0) or 0.0
    return total * ESTIMATE_MARGIN


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=os.environ.get("EVAL_DATABASE_URL"), help="the eval database with the corpus ingested")
    parser.add_argument("--label", default="a3")
    parser.add_argument("--answers", action="store_true", help="also ask every pair through the Ask route (paid)")
    parser.add_argument("--answer-ks", default=None, help="comma-separated excerpt counts for the answers (default: today's)")
    parser.add_argument("--max-usd", type=float, default=DEFAULT_MAX_USD)
    parser.add_argument("--concurrency", type=int, default=4, help="pairs asked at the same time")
    parser.add_argument("--dry-run", action="store_true", help="the free retrieval part and the estimate; nothing is written")
    parser.add_argument("--mock", action="store_true", help="the app's mock provider for the answers")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--env-file", type=Path, default=REPO_ROOT / "ai-service" / ".env")
    parser.add_argument("--allow-any-db", action="store_true")
    args = parser.parse_args(argv)
    if not args.db:
        parser.error("--db is required (or set EVAL_DATABASE_URL)")
    return args


async def run(args: argparse.Namespace) -> int:
    from app.config import settings
    from app.db.connection import close_db_pool
    from app.services.llm.models import resolve_model
    from common.ingest import git
    from ground_truth import resolve_topics

    today = settings.CHAT_TOP_K
    answer_ks = [int(k) for k in args.answer_ks.split(",")] if args.answer_ks else [today]
    topics = load_topic_ids()
    questions = load_questions(QUESTIONS_FILE, topics)
    corpus = json.loads(CORPUS_FILE.read_text())
    try:
        chunks_by_doc = await load_chunks(corpus)
        missing = [doc for doc, chunks in chunks_by_doc.items() if not chunks]
        if missing:
            raise SystemExit(f"no stored chunks for {missing}: run retrieval/run_eval.py --db <this database> first")
        gold_by_topic = {tid: {str(c) for c in ids} for tid, ids in resolve_topics(list(topics.values()), chunks_by_doc).items()}
        chunk_chars = {str(c["id"]): len(c.get("chunk_text") or "") for chunks in chunks_by_doc.values() for c in chunks}

        log(f"Retrieval: {len(questions)} pairs, {2 * len(questions)} turns, at {', '.join(map(str, KS))} excerpts (today {today})")
        records = []
        for question in questions:
            for turn in ("first", "followup"):
                gold = gold_for(question, turn, gold_by_topic)
                for k in KS:
                    ranked = [str(row["id"]) for row in await ask_retrieval(question[turn], k)]
                    records.append({"id": question["id"], "turn": turn, "kind": question["kind"], "k": k, **score_ranked(ranked, gold), "chunks": ranked})
        retrieval = aggregate_retrieval(records)
        k_pick, reason = pick_excerpt_count(retrieval, today)
        for k in KS:
            stats = retrieval["by_k"][k]
            log(f"  {k:>2}: all {stats['all']['hits']}/{stats['all']['n']}, first {stats['first']['hits']}/{stats['first']['n']}, follow-ups {stats['followup']['hits']}/{stats['followup']['n']}")
        log(f"  M7 pick: {k_pick} ({reason})")

        rows: List[Dict[str, Any]] = []
        tracker = None
        if args.answers:
            adapters, spend, ask_eval = generation_helpers()
            model = resolve_model("chat").model
            estimate = estimate_answers_usd(records, chunk_chars, answer_ks, adapters.estimate_cost, model, spend.DEFAULT_OUTPUT_TOKENS["chat"])
            log(f"Answers: {2 * len(questions)} turns at {answer_ks} excerpts on {model}: about ${estimate:.2f}; cap --max-usd {args.max_usd}")
            if not args.mock and estimate > args.max_usd:
                raise SystemExit(f"the estimate ${estimate:.2f} passes the cap ${args.max_usd}")
            if args.dry_run:
                log("  Nothing was sent.")
                return 0
            api_key = "" if args.mock else adapters.load_api_key(args.env_file)
            if not args.mock and not api_key:
                raise SystemExit(f"ANTHROPIC_API_KEY is not set and {args.env_file} has none. Use --mock to test without a key.")
            from app.services.llm.factory import LLMFactory

            inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
            if args.mock:
                settings.LLM_PROVIDER = "mock"
            else:
                settings.ANTHROPIC_API_KEY = api_key
            stop: Dict[str, str] = {}
            tracker = spend.SpendTracker(args.max_usd, args.max_usd, adapters.estimate_cost)
            LLMFactory._instance = ask_eval.make_ask_meter(adapters, stop)(inner, None, tracker, spend.GENERATION)
            client = make_client()
            gate = asyncio.Semaphore(args.concurrency)

            async def one(question, k):
                async with gate:
                    return await ask_pair(client, ask_eval, question, gold_by_topic, k)

            try:
                for k in answer_ks:
                    settings.CHAT_TOP_K = k  # every pair at this count runs before the next count starts
                    log(f"  asking at {k} excerpts")
                    for pair in await asyncio.gather(*(one(q, k) for q in questions)):
                        rows += pair
            finally:
                settings.CHAT_TOP_K = today
                await client.aclose()
                LLMFactory._instance = None
            if stop:
                log(f"  stopped: {stop['reason']}")
        elif args.dry_run:
            log("  Nothing was written.")
            return 0
    finally:
        await close_db_pool()

    date = datetime.date.today().isoformat()
    run_dir = RESULTS_DIR / f"{date}-{args.label}"
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)
    (run_dir / "raw" / "retrieval.json").write_text(json.dumps(records, indent=1) + "\n")
    if rows:
        (run_dir / "raw" / "answers.json").write_text(json.dumps(rows, indent=1) + "\n")
    summary: Dict[str, Any] = {"retrieval": retrieval, "pick": {"k": k_pick, "reason": reason}}
    if rows:
        summary["answers"] = aggregate_answers([{k: v for k, v in r.items() if k not in ("calls", "events", "text")} for r in rows])
    cost = round(sum(r["cost_usd"] for r in rows), 4)
    meta = {"label": args.label, "date": date, "today": today, "pairs": len(questions)}
    summary["run"] = {
        **meta,
        "commit": git("rev-parse", "--short", "HEAD"),
        "dirty": bool(git("status", "--porcelain", "--", "evals", "ai-service/app")),
        "ks": list(KS),
        "answer_ks": answer_ks if rows else [],
        "answer_model": resolve_model("chat").model if rows else None,
        "mock": args.mock,
        "cost_usd": cost,
    }
    (run_dir / "run.json").write_text(json.dumps(summary["run"], indent=2) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    report = RESULTS_DIR / f"{date}-{args.label}.md"
    report.write_text(render_report(summary, meta))
    log(f"Cost: ${cost:.4f}")
    log(f"Report: {report}")
    return 0


def main() -> int:
    args = parse_args()
    from common.ingest import check_db_name, prepare_app_environment

    check_db_name(args.db, args.allow_any_db)
    prepare_app_environment(args.db)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())

"""A2: the generated-item defect eval.

    cd ai-service
    uv run python -I ../evals/generation/defects.py \\
        --db postgresql://dev:devpass@localhost:5432/margins_a2_evals --label a2-defects

Runs the app's item generators (warm-up, topic quiz, review items, solved examples, practice problems, and the exam
over each corpus's chosen topics) on topics whose concepts are already stored in the eval database, with the app's own
model choices. For each generator it reports:

  - what the model wrote, what the app dropped and why (its own rules: a key that is not an option, a wrong option
    without a misconception, a practice hint that states an answer; and the support check), and what it stored;
  - the automatic checks (checks.py) on the stored items: self-correction, copied exam headers, two correct or equal
    options, the right option being the only longest one, the share of true/false items;
  - with the judge (default opus:medium): wrong keys, two correct options, questions the excerpts do not teach enough to
    answer, garbled sentences, thinking aloud and guessable questions (item_judge.py);
  - cost and time per generator.

By default every call goes through the Message Batches API (batching.py, half price): the generators of every topic run
at once, so each round of calls is one batch. --no-batch calls the API directly. --dry-run prints the plan and an
estimate; --mock uses the app's mock provider. Spend caps (--max-usd, --max-judge-usd) are checked before every call.

Topic names and item text stay in raw/ and judge/ (gitignored: they are derived from the CC BY-NC-SA corpora); run.json,
summary.json and the report hold counts only.
"""
import argparse
import asyncio
import datetime
import json
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
RESULTS_DIR = EVALS_DIR / "results"
DEFAULT_DB = "postgresql://dev:devpass@localhost:5432/margins_a2_evals"
KINDS = ("warmup", "quiz", "review", "solved", "interactive", "exam")
QUESTION_KINDS = ("warmup", "quiz", "review", "exam")
PROBLEM_KINDS = ("solved", "interactive")
LABELS = {
    "warmup": "Warm-up",
    "quiz": "Topic quiz",
    "review": "Review items",
    "exam": "Exam",
    "solved": "Solved examples",
    "interactive": "Practice problems",
}
# The model calls each generator makes before its support check, for the estimate (prompt tokens: about 24 excerpts of
# 350 tokens plus instructions, the concept block and the schema).
EST_PROMPT_TOKENS = {"warmup": 11000, "quiz": 12000, "review": 13000, "solved": 11500, "interactive": 11500, "exam": 12000}
EST_SUPPORT_PROMPT_TOKENS = 12000
EST_JUDGE_PROMPT_TOKENS = 16000

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(EVALS_DIR))

from common.ingest import check_db_name, git, prepare_app_environment  # noqa: E402


def log(message: str = "") -> None:
    print(message, flush=True)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", default=os.environ.get("EVAL_DATABASE_URL", DEFAULT_DB), help=f"eval database URL (default {DEFAULT_DB})")
    parser.add_argument("--allow-any-db", action="store_true", help="allow a database whose name does not contain 'eval'")
    parser.add_argument("--topics", default="mit-18.05=6,mit-6.006=4", help="corpus=count pairs: topics per corpus, from those with stored concepts, spread evenly")
    parser.add_argument("--kinds", default=",".join(KINDS), help=f"comma-separated, from {', '.join(KINDS)}")
    parser.add_argument("--questions", type=int, default=10, help="topic quiz questions")
    parser.add_argument("--examples", type=int, default=3, help="solved examples and practice problems per set")
    parser.add_argument("--exam-questions", type=int, default=20, help="questions per exam (one exam per corpus)")
    parser.add_argument("--difficulty", default="medium", choices=("easy", "medium", "hard"))
    parser.add_argument("--judge", default="opus:medium", help="judge model and effort; 'none' to skip")
    parser.add_argument("--no-batch", action="store_true", help="call the API directly instead of through the Message Batches API")
    parser.add_argument("--batch-quiet", type=float, default=5.0, help="seconds without a new call before a batch is sent")
    parser.add_argument("--batch-poll", type=float, default=15.0, help="seconds between checks on a batch")
    parser.add_argument("--max-usd", type=float, default=9.0, help="hard spend stop across generation and judge")
    parser.add_argument("--max-judge-usd", type=float, default=3.0, help="hard spend stop for the judge alone")
    parser.add_argument("--label", default="a2-defects", help="name for the results folder and report")
    parser.add_argument("--out-dir", type=Path, default=RESULTS_DIR)
    parser.add_argument("--resume", type=Path, default=None, help="continue a results folder: generations and judge calls already done are kept")
    parser.add_argument("--no-generate", action="store_true", help="with --resume: judge and report only")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and an estimate, call nothing")
    parser.add_argument("--mock", action="store_true", help="use the app's mock provider")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds per direct model call")
    parser.add_argument("--env-file", type=Path, default=None, help="file to read ANTHROPIC_API_KEY from (default ai-service/.env)")
    args = parser.parse_args(argv)
    if args.no_generate and not args.resume:
        parser.error("--no-generate needs --resume DIR")
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    bad = [k for k in kinds if k not in KINDS]
    if bad or not kinds:
        parser.error(f"--kinds: unknown {bad}; choose from {', '.join(KINDS)}")
    args.kind_list = [k for k in KINDS if k in kinds]
    args.topic_counts = {}
    for pair in args.topics.split(","):
        corpus, _, count = pair.partition("=")
        if not corpus.strip() or not count.strip().isdigit():
            parser.error(f"--topics: '{pair}' is not corpus=count")
        args.topic_counts[corpus.strip()] = int(count)
    args.judge = None if args.judge.lower() == "none" else args.judge
    return args


def spread(items: List[Any], count: int) -> List[Any]:
    """`count` of `items`, spread evenly from the first to the last."""
    if count >= len(items):
        return list(items)
    if count <= 1:
        return items[:1]
    return [items[round(i * (len(items) - 1) / (count - 1))] for i in range(count)]


def raw_path(run_dir: Path, corpus: str, key: str, kind: str) -> Path:
    return run_dir / "raw" / f"{corpus}__{key}__{kind}.json"


# --------------------------------------------------------------------------------------
# Analysis (pure; unit tested)
# --------------------------------------------------------------------------------------


def written_items(kind: str, calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The items the model wrote in a generator's own calls (not the support check's), as parsed."""
    from adapters import A2_PURPOSES

    field = "examples" if kind in PROBLEM_KINDS else "questions"
    items: List[Dict[str, Any]] = []
    for call in calls:
        if call.get("purpose") == A2_PURPOSES[kind] and isinstance(call.get("raw_output"), dict):
            items += [item for item in call["raw_output"].get(field) or [] if isinstance(item, dict)]
    return items


def summarize_kind(kind: str, records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What one generator wrote, dropped (by rule, and by the support check), lost otherwise and stored, over its runs.

    Other losses are spares and items over a type's quota cut on purpose, items not of the kind or mode asked for,
    repeats of an item already in the bank, and the survivors of a run that failed for having too few.
    """
    import checks
    from adapters import problem_drop_reason, question_drop_reason

    written: List[Dict[str, Any]] = []
    stored: List[Dict[str, Any]] = []
    sent = unsupported = 0
    seconds = []
    for record in records:
        written += written_items(kind, record.get("calls") or [])
        stored += record.get("output") or [] if record.get("status") == "ok" else []
        for check in record.get("support") or []:
            sent += check["sent"]
            unsupported += check["sent"] - check["kept"]
        if record.get("seconds") is not None:
            seconds.append(record["seconds"])
    reason_of = (lambda item: problem_drop_reason(kind, item)) if kind in PROBLEM_KINDS else question_drop_reason
    reasons = Counter(reason for reason in (reason_of(item) for item in written) if reason)
    malformed = sum(reasons.values())
    cost = sum(call.get("cost_usd") or 0.0 for record in records for call in record.get("calls") or [])
    runs = len(records)
    return {
        "runs": runs,
        "failed": sum(1 for record in records if record.get("status") != "ok"),
        "errors": sorted({str(record.get("error", ""))[:120] for record in records if record.get("status") != "ok"}),
        "written": len(written),
        "malformed": malformed,
        "by_reason": dict(sorted(reasons.items())),
        "support_sent": sent,
        "unsupported": unsupported,
        "other_losses": len(written) - malformed - unsupported - len(stored),
        "stored": len(stored),
        "drop_rate": (len(written) - len(stored)) / len(written) if written else None,
        "malformed_rate": malformed / len(written) if written else None,
        "unsupported_rate": unsupported / sent if sent else None,
        "checks": checks.problem_set_report(kind, stored) if kind in PROBLEM_KINDS else checks.item_set_report(stored),
        "cost_usd": round(cost, 6),
        "cost_per_run_usd": round(cost / runs, 6) if runs else None,
        "median_seconds": round(statistics.median(seconds), 1) if seconds else None,
    }


def build_summary(run_dir: Path, run_info: Dict[str, Any]) -> Dict[str, Any]:
    import item_judge

    records: Dict[str, List[Dict[str, Any]]] = {kind: [] for kind in KINDS}
    for path in sorted((run_dir / "raw").glob("*__*__*.json")):
        record = json.loads(path.read_text())
        records.setdefault(record["kind"], []).append(record)
    judged = item_judge.load_judged(run_dir / "judge")
    return {
        "run": run_info,
        "kinds": {kind: summarize_kind(kind, rows) for kind, rows in records.items() if rows},
        "judge": item_judge.tally(judged),
        "judge_groups": len(judged),
        "judge_cost_usd": round(sum(c.get("cost_usd") or 0.0 for record in judged for c in record.get("calls") or []), 6),
    }


def _pct(value: Optional[float]) -> str:
    return "—" if value is None else f"{value * 100:.0f}%"


def _table(head: List[str], rows: List[List[str]]) -> str:
    return "\n".join([f"| {' | '.join(head)} |", f"| {' | '.join('---' for _ in head)} |", *[f"| {' | '.join(row)} |" for row in rows]])


def render_report(summary: Dict[str, Any]) -> str:
    import checks
    import item_judge

    run = summary["run"]
    kinds = summary["kinds"]
    lines = [
        f"# A2: generated-item defects ({run['date']}, {run['label']})",
        "",
        f"Code {run['code']['commit'][:8]} on {run['code']['branch']}{' (app has uncommitted changes)' if run['code']['app_dirty'] else ''}. "
        f"{run['topics']} topics ({', '.join(f'{c} {n}' for c, n in run['topic_counts'].items())}); the app's own models; "
        f"{'Message Batches API (half price)' if run['batch'] else 'direct calls'}{'; MOCK provider' if run['mock'] else ''}. "
        f"Quiz {run['params']['questions']} questions, {run['params']['examples']} examples per set, exam {run['params']['exam_questions']} questions per corpus, difficulty {run['params']['difficulty']}.",
        "",
        "## Drops per generator",
        "",
        "Written is what the model returned. Malformed items fail the app's own rules and are dropped before the support check; "
        "unsupported ones fail the support check. Other losses are cut on purpose (spares, type quotas, items not of the kind "
        "or mode asked for, repeats) or are the survivors of a run that failed. The drop rate is everything written but not stored.",
        "",
        _table(
            ["Generator", "Runs (failed)", "Written", "Malformed", "Unsupported (of checked)", "Other losses", "Stored", "Drop rate", "Cost", "Cost per run", "Median time"],
            [
                [
                    LABELS[kind],
                    f"{k['runs']} ({k['failed']})",
                    str(k["written"]),
                    f"{k['malformed']} ({_pct(k['malformed_rate'])})",
                    f"{k['unsupported']} of {k['support_sent']} ({_pct(k['unsupported_rate'])})" if k["support_sent"] else "—",
                    str(k["other_losses"]),
                    str(k["stored"]),
                    _pct(k["drop_rate"]),
                    f"${k['cost_usd']:.2f}",
                    f"${k['cost_per_run_usd']:.3f}" if k["cost_per_run_usd"] is not None else "—",
                    f"{k['median_seconds']:.0f}s" if k["median_seconds"] is not None else "—",
                ]
                for kind, k in kinds.items()
            ],
        ),
        "",
        "### Why items were malformed",
        "",
        _table(
            ["Generator", "Rule", "Items"],
            [[LABELS[kind], reason, str(n)] for kind, k in kinds.items() for reason, n in k["by_reason"].items()] or [["—", "none", "0"]],
        ),
    ]
    failures = [(kind, error) for kind, k in kinds.items() for error in k["errors"]]
    if failures:
        lines += ["", "### Failed runs", "", *[f"- {LABELS[kind]}: {error}" for kind, error in failures]]

    question_kinds = [kind for kind in kinds if kind in QUESTION_KINDS]
    lines += [
        "",
        "## Automatic checks on the stored questions",
        "",
        "Counts of stored questions with each fault (checks.py). Correct-is-longest counts multiple-choice questions whose right "
        "option is the only longest, against the number chance gives (one in the number of options, summed).",
        "",
        _table(
            ["Generator", "Questions", "Flagged", *checks.QUESTION_DEFECTS, "Correct is longest (chance)", "True/false share"],
            [
                [
                    LABELS[kind],
                    str(c["items"]),
                    f"{c['flagged']} ({_pct(c['flagged_rate'])})",
                    *[str(c["by_defect"].get(code, 0)) for code in checks.QUESTION_DEFECTS],
                    f"{c['correct_longest']} of {c['multiple_choice']} ({c['chance_longest']:.1f})",
                    _pct(c["true_false_share"]),
                ]
                for kind in question_kinds
                for c in [kinds[kind]["checks"]]
            ],
        ),
    ]
    problem_kinds = [kind for kind in kinds if kind in PROBLEM_KINDS]
    if problem_kinds:
        lines += [
            "",
            "## Automatic checks on the stored problems",
            "",
            _table(
                ["Generator", "Problems", "Flagged", "By fault"],
                [
                    [LABELS[kind], str(c["items"]), f"{c['flagged']} ({_pct(c['flagged_rate'])})", ", ".join(f"{d} {n}" for d, n in c["by_defect"].items()) or "none"]
                    for kind in problem_kinds
                    for c in [kinds[kind]["checks"]]
                ],
            ),
        ]
    judge = summary.get("judge") or {}
    if judge:
        lines += [
            "",
            f"## Judge ({run.get('judge') or 'n/a'}, {summary['judge_groups']} topics, ${summary['judge_cost_usd']:.2f})",
            "",
            "Stored questions with each fault the judge found (item_judge.py).",
            "",
            _table(
                ["Generator", "Judged", "Flagged", *item_judge.DEFECTS],
                [
                    [LABELS.get(kind, kind), str(j["judged"]), f"{j['flagged']} ({_pct(j['rate'])})", *[str(j["by_defect"][d]) for d in item_judge.DEFECTS]]
                    for kind, j in sorted(judge.items(), key=lambda pair: list(LABELS).index(pair[0]) if pair[0] in LABELS else len(LABELS))
                ],
            ),
        ]
    spend = run.get("spend", {})
    lines += [
        "",
        "## Cost",
        "",
        f"Generation ${spend.get('generation', 0):.2f}, judge ${spend.get('judge', 0):.2f}, total ${spend.get('generation', 0) + spend.get('judge', 0):.2f}"
        f"{' (batch prices)' if run['batch'] else ''}. Batches: {len(run.get('batches') or [])}."
        + (f" Stopped early: {run['stopped']}." if run.get("stopped") else ""),
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# Topics
# --------------------------------------------------------------------------------------


async def eligible_topics(corpus: str) -> List[Dict[str, Any]]:
    """The corpus project's topics that have stored concepts and mapped excerpts, in course order."""
    from app.db.connection import execute_query

    rows = await execute_query(
        """
        SELECT t.id, t.name, t.description, t.order_index
        FROM topics t
        WHERE t.project_id = $1
          AND EXISTS (SELECT 1 FROM concepts c WHERE c.topic_id = t.id AND c.status = 'active')
          AND EXISTS (SELECT 1 FROM topic_chunk_mappings m WHERE m.topic_id = t.id)
        ORDER BY t.order_index
        """,
        f"eval-gen-{corpus}",
    )
    return [{"id": r["id"], "name": r["name"], "description": r["description"] or "", "index": r["order_index"], "key": f"t{r['order_index']:02d}"} for r in rows]


# --------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------


def estimate(args, tracker, topic_counts: Dict[str, int]) -> Dict[str, float]:
    import adapters

    n_topics = sum(topic_counts.values())
    per_kind: Dict[str, float] = {}
    for kind in args.kind_list:
        purpose = adapters.A2_PURPOSES[kind]
        model = adapters.app_resolve_model(purpose).model
        main = tracker.estimate_call(model, purpose, EST_PROMPT_TOKENS[kind])
        support = tracker.estimate_call(adapters.app_resolve_model("router").model, "router", EST_SUPPORT_PROMPT_TOKENS) if kind not in PROBLEM_KINDS else 0.0
        if kind == "exam":  # one call per topic of each exam, and a support check each
            per_kind[kind] = (main + support) * n_topics
        else:
            per_kind[kind] = (main + support) * n_topics
    if args.judge:
        spec = adapters.parse_model_spec(args.judge)
        per_kind["judge"] = tracker.estimate_call(spec.model_id, "judge", EST_JUDGE_PROMPT_TOKENS) * n_topics
    return per_kind


async def generate(args, run_dir: Path, metered, topics: Dict[str, List[Dict[str, Any]]], params: Dict[str, Any], state: Dict[str, Any]) -> None:
    import adapters
    from spend import SpendLimitReached

    async def one(corpus: str, key: str, kind: str, work, meta: Dict[str, Any]) -> None:
        path = raw_path(run_dir, corpus, key, kind)
        if path.exists() and json.loads(path.read_text()).get("status") == "ok":
            return
        record: Dict[str, Any] = {"corpus": corpus, "key": key, "kind": kind, **meta, "params": params}
        started = time.perf_counter()
        with adapters.call_sink() as calls, adapters.support_sink() as support:
            try:
                record["output"] = await work()
                record["status"] = "ok"
            except SpendLimitReached as exc:
                state["stopped"] = state.get("stopped") or str(exc)
                record["status"] = "stopped"
                record["error"] = str(exc)
            except Exception as exc:  # a failed generation is a result
                record["status"] = "error"
                record["error"] = f"{type(exc).__name__}: {exc}"
        record["seconds"] = round(time.perf_counter() - started, 1)
        record["calls"] = calls
        record["support"] = support
        record["cost_usd"] = round(sum(c["cost_usd"] for c in calls), 6)
        path.write_text(json.dumps(record, indent=2, default=str) + "\n")
        tail = f"{len(record['output'])} stored, ${record['cost_usd']:.3f}, {record['seconds']:.0f}s" if record["status"] == "ok" else record["error"][:140]
        log(f"  {corpus} {key} {kind:<12} {record['status']:<7} {tail}")

    jobs = []
    for corpus, rows in topics.items():
        for topic in rows:
            for kind in args.kind_list:
                if kind == "exam":
                    continue
                meta = {"topic": {"id": topic["id"], "name": topic["name"], "index": topic["index"]}}
                jobs.append(one(corpus, topic["key"], kind, lambda t=topic, k=kind: adapters.generate_items(t, k, params), meta))
        if "exam" in args.kind_list:
            ids = [t["id"] for t in rows]
            meta = {"topics": [{"id": t["id"], "key": t["key"]} for t in rows]}
            jobs.append(
                one(corpus, "all", "exam", lambda ids=ids, c=corpus: adapters.generate_exam_items(f"eval-gen-{c}", ids, params["exam_questions"], params["difficulty"]), meta)
            )
    with adapters.installed_provider(metered):
        await asyncio.gather(*jobs)


def judge_groups(run_dir: Path, excerpts: Dict[str, str]) -> Dict[str, Dict[str, Any]]:
    """One group per topic: its warm-up, quiz and review questions and its exam questions, with refs like quiz-3."""
    groups: Dict[str, Dict[str, Any]] = {}
    exam_by_topic: Dict[str, List[Dict[str, Any]]] = {}
    records = [json.loads(p.read_text()) for p in sorted((run_dir / "raw").glob("*__*__*.json"))]
    for record in records:
        if record["kind"] == "exam" and record.get("status") == "ok":
            for question in record["output"]:
                exam_by_topic.setdefault(question.get("topic_id"), []).append(question)
    for record in records:
        if record["kind"] not in ("warmup", "quiz", "review") or record.get("status") != "ok":
            continue
        topic_id = record["topic"]["id"]
        group = groups.setdefault(f"{record['corpus']}__{record['key']}", {"topic_id": topic_id, "excerpts": excerpts.get(topic_id, ""), "items": []})
        group["items"] += [{"ref": f"{record['kind']}-{n}", "item": item} for n, item in enumerate(record["output"], 1)]
    for group in groups.values():
        group["items"] += [{"ref": f"exam-{n}", "item": item} for n, item in enumerate(exam_by_topic.get(group["topic_id"], []), 1)]
    return groups


async def run(args: argparse.Namespace) -> int:
    import adapters
    import item_judge
    from spend import GENERATION, JUDGE, SpendTracker

    adapters.install_support_recorder()
    price = 1.0 if args.no_batch or args.mock else 0.5
    tracker = SpendTracker(args.max_usd, args.max_judge_usd, lambda *a: (adapters.estimate_cost(*a) or 0.0) * price)

    date = datetime.date.today().isoformat()
    run_dir = args.resume.resolve() if args.resume else args.out_dir / f"{date}-{args.label}"
    previous: Dict[str, Any] = json.loads((run_dir / "run.json").read_text()) if args.resume and (run_dir / "run.json").exists() else {}
    if previous:
        date, args.label = previous["date"], previous["label"]

    from app.db.connection import close_db_pool

    try:
        topics: Dict[str, List[Dict[str, Any]]] = {}
        for corpus, count in args.topic_counts.items():
            eligible = await eligible_topics(corpus)
            if not eligible:
                raise SystemExit(f"no topic of eval-gen-{corpus} has stored concepts and excerpts in this database")
            topics[corpus] = spread(eligible, count)
        counts = {c: len(rows) for c, rows in topics.items()}

        per_kind = estimate(args, tracker, counts)
        log("Plan")
        log(f"  topics: {counts} (positions {', '.join(c + ' ' + ','.join(t['key'] for t in rows) for c, rows in topics.items())})")
        log(f"  generators: {', '.join(args.kind_list)}; judge: {args.judge or 'none'}; {'direct calls' if price == 1.0 else 'Message Batches API, half price'}")
        for kind, usd in per_kind.items():
            log(f"  {kind:<12} about ${usd:.2f}")
        log(f"  estimated total ${sum(per_kind.values()):.2f}. Caps: --max-usd {args.max_usd}, --max-judge-usd {args.max_judge_usd}")
        if args.dry_run:
            log("  Nothing was called.")
            return 0

        (run_dir / "raw").mkdir(parents=True, exist_ok=True)
        for kind, usd in existing_spend(run_dir).items():
            tracker.add_past_spend(kind, usd)
        if previous:
            log(f"Resuming {run_dir}: ${tracker.total_spent:.2f} already spent in this folder")

        api_key = "" if args.mock else adapters.load_api_key(args.env_file or (adapters_dir() / ".env"))
        if not args.mock and not api_key:
            raise SystemExit("ANTHROPIC_API_KEY is not set and ai-service/.env has none. Use --mock to test without a key.")
        inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
        batched = None
        if price == 0.5:
            from common.batching import install_batching

            batched = install_batching(inner, quiet=args.batch_quiet, poll=args.batch_poll, log=log)
        metered = adapters.MeteredProvider(inner, None, tracker, GENERATION)
        metered.price_factor = price

        params = {"questions": args.questions, "examples": args.examples, "exam_questions": args.exam_questions, "difficulty": args.difficulty}
        state: Dict[str, Any] = {}
        (run_dir / "raw" / "topics.json").write_text(json.dumps(topics, indent=2) + "\n")
        if not args.no_generate:
            log("Generating")
            await generate(args, run_dir, metered, topics, params, state)

        if args.judge and not state.get("stopped"):
            excerpts: Dict[str, str] = {}
            for rows in topics.values():
                for topic in rows:
                    excerpts[topic["id"]] = item_judge_excerpts(await adapters.fetch_excerpts(topic["id"]))
            judge = adapters.MeteredProvider(inner, adapters.parse_model_spec(args.judge), tracker, JUDGE)
            judge.price_factor = price
            log("Judging")
            info = await item_judge.judge_topics(provider=judge, groups=judge_groups(run_dir, excerpts), judge_dir=run_dir / "judge", log=log)
            if info["stopped"]:
                state["stopped"] = state.get("stopped") or f"judge: {len(info['stopped'])} topics not judged (spend cap)"

        run_info = {
            "label": args.label,
            "date": date,
            "code": {
                "commit": git("rev-parse", "HEAD"),
                "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
                "app_dirty": bool(git("status", "--porcelain", "--", "ai-service/app")),
            },
            "kinds": args.kind_list,
            "topics": sum(counts.values()),
            "topic_counts": counts,
            "params": params,
            "judge": args.judge,
            "batch": price == 0.5,
            "batches": (previous.get("batches") or []) + (batched.batches if batched else []),
            "mock": args.mock,
            "max_usd": args.max_usd,
            "max_judge_usd": args.max_judge_usd,
            "spend": {"generation": round(tracker.spent[GENERATION], 4), "judge": round(tracker.spent[JUDGE], 4)},
            "stopped": state.get("stopped") or previous.get("stopped"),
        }
        (run_dir / "run.json").write_text(json.dumps(run_info, indent=2) + "\n")
        summary = build_summary(run_dir, run_info)
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str) + "\n")
        md_path = run_dir.parent / f"{run_dir.name}.md"
        md_path.write_text(render_report(summary))
        log(f"\nWrote {md_path}\nWrote {run_dir / 'summary.json'}")
        log(f"Spent ${run_info['spend']['generation'] + run_info['spend']['judge']:.2f} (generation ${run_info['spend']['generation']:.2f}, judge ${run_info['spend']['judge']:.2f})")
        return 0
    finally:
        await close_db_pool()


def adapters_dir() -> Path:
    from common.ingest import AI_SERVICE_DIR

    return AI_SERVICE_DIR


def item_judge_excerpts(excerpts: List[Dict[str, Any]]) -> str:
    from judge import render_excerpts

    return render_excerpts(excerpts)


def existing_spend(run_dir: Path) -> Dict[str, float]:
    """Spend of earlier runs in this folder, so a resumed run keeps one budget."""
    spend = {"generation": 0.0, "judge": 0.0}
    for path in (run_dir / "raw").glob("*__*__*.json"):
        spend["generation"] += float(json.loads(path.read_text()).get("cost_usd", 0.0))
    for path in (run_dir / "judge").glob("*.json") if (run_dir / "judge").exists() else []:
        spend["judge"] += sum(c.get("cost_usd", 0.0) for c in json.loads(path.read_text()).get("calls", []))
    return spend


def main() -> int:
    args = parse_args()
    check_db_name(args.db, args.allow_any_db)
    prepare_app_environment(args.db)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())

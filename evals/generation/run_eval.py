"""Generation-quality eval for Margins.

    cd ai-service
    uv run python -I ../evals/generation/run_eval.py \\
        --db postgresql://postgres@127.0.0.1:5544/sb_gen_evals --label first \\
        --models opus:medium,sonnet:medium,haiku:medium --judge opus

What it does:
  1. Ingests each corpus (corpora/*.json, fetch_corpus.py) through the app's chunker and embedder
     into the eval database, one synthetic project per corpus.
  2. Gets topics: the app's own topic extraction (adapters.extract_topics), or fixed topics from
     --topics-file so a model comparison holds topics constant. Maps them to chunks like the
     extract-topics job does, then picks N to generate.
  3. For every (topic, model), runs the app's real generators (notes, worked examples, practice
     problems, quiz) one after another, with a provider for that model and effort. Raw outputs,
     token usage, cost and latency go to evals/results/<date>-<label>/raw/.
  4. Runs the automatic checks (checks.py) and, with --judge, one anonymised Opus judge call per
     (topic, type) (judge.py).
  5. Writes evals/results/<date>-<label>.md and <date>-<label>/summary.json.

Every model call goes through a spend gate: --max-usd (default 8, generation + judge) and
--max-judge-usd (default 3) are hard stops checked before each call. --dry-run prints the plan
and an estimate and calls nothing. --mock uses the app's mock provider (no cost, placeholder text).
--resume DIR continues a results folder (skips finished generations and judged pairs);
with --no-generate it only redoes checks, judging and the report, with no database.
"""
import argparse
import asyncio
import datetime
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# The app settings have no default ENVIRONMENT (SEC-L2); offline eval tooling runs as development.
os.environ.setdefault("ENVIRONMENT", "development")

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
RESULTS_DIR = EVALS_DIR / "results"
DEFAULT_DB = "postgresql://postgres@127.0.0.1:5544/sb_evals"
DEFAULT_MODELS = "opus:medium,sonnet:medium,haiku:medium"
# Concepts and warm-up first, as in the app's chain: the later generators tag their items with the
# concepts extraction stored, and the warm-up reads them too.
ALL_TYPES = ("concepts", "warmup", "notes", "solved", "interactive", "quiz")
GRAPH_TYPES = ("concepts", "warmup")
JUDGED_TYPES = ("notes", "solved", "interactive", "quiz")
EVAL_USER_ID = "eval-gen-user"

# Run with `python -I`, so nothing is importable by accident; add exactly what is needed.
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(EVALS_DIR))

from common.ingest import (  # noqa: E402
    AI_SERVICE_DIR,
    IngestDocument,
    check_db_name,
    git,
    ingest_documents,
    prepare_app_environment,
)
from corpus import corpus_ids, document_path, load_corpus  # noqa: E402


def log(message: str = "") -> None:
    print(message, flush=True)


def slugify(text: str, limit: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit] or "topic"


def project_id_for(corpus_id: str) -> str:
    return f"eval-gen-{corpus_id}"


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", default=os.environ.get("EVAL_DATABASE_URL", DEFAULT_DB), help=f"eval database URL (default {DEFAULT_DB})")
    parser.add_argument("--allow-any-db", action="store_true", help="allow a database whose name does not contain 'eval'")
    parser.add_argument("--rebuild", action="store_true", help="re-chunk and re-embed every document")
    parser.add_argument("--corpora", default=",".join(corpus_ids()), help="comma-separated corpus ids")
    parser.add_argument("--models", default=DEFAULT_MODELS, help="comma-separated <model>:<effort>, e.g. opus:medium,haiku:low")
    parser.add_argument("--types", default=",".join(ALL_TYPES), help=f"comma-separated, from {', '.join(ALL_TYPES)}")
    parser.add_argument("--num-topics", type=int, default=None, help="topics to generate per corpus, spread evenly over the list (default 4, or all with --topics-file)")
    parser.add_argument("--topic-indexes", default=None, help="comma-separated 0-based positions to generate, instead of --num-topics")
    parser.add_argument("--topics-file", type=Path, default=None, help="JSON with fixed topics (name, description, keywords) per corpus; see README")
    parser.add_argument("--examples", type=int, default=3, help="examples per set (worked and practice)")
    parser.add_argument("--questions", type=int, default=10, help="quiz questions")
    parser.add_argument("--difficulty", default="medium", choices=("easy", "medium", "hard"))
    parser.add_argument("--detail-level", default="comprehensive", choices=("brief", "moderate", "comprehensive"))
    parser.add_argument("--judge", default=None, metavar="MODEL[:EFFORT]", help="run the judge, e.g. opus or opus:high (default effort medium)")
    parser.add_argument("--max-usd", type=float, default=8.0, help="hard spend stop across generation, topic extraction and judge")
    parser.add_argument("--max-judge-usd", type=float, default=3.0, help="hard spend stop for the judge alone")
    parser.add_argument("--label", default="run", help="name for the results folder and report")
    parser.add_argument("--out-dir", type=Path, default=RESULTS_DIR)
    parser.add_argument("--resume", type=Path, default=None, help="continue an existing results folder")
    parser.add_argument("--no-generate", action="store_true", help="with --resume: skip generation; redo checks, judge and report only")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and a cost estimate, call nothing")
    parser.add_argument("--mock", action="store_true", help="use the app's mock provider instead of Anthropic")
    parser.add_argument("--sequential-models", action="store_true", help="run models one after another instead of at the same time")
    parser.add_argument("--seed", type=int, default=0, help="seed for the judge's candidate order")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds per model call")
    parser.add_argument("--env-file", type=Path, default=AI_SERVICE_DIR / ".env", help="file to read ANTHROPIC_API_KEY from if it is not in the environment")
    args = parser.parse_args(argv)
    if args.no_generate and not args.resume:
        parser.error("--no-generate needs --resume DIR")
    types = [t.strip() for t in args.types.split(",") if t.strip()]
    bad = [t for t in types if t not in ALL_TYPES]
    if bad or not types:
        parser.error(f"--types: unknown {bad}; choose from {', '.join(ALL_TYPES)}")
    args.type_list = [t for t in ALL_TYPES if t in types]  # the app's order, whatever order was typed
    args.corpus_list = [c.strip() for c in args.corpora.split(",") if c.strip()]
    args.model_specs = [s for s in args.models.split(",") if s.strip()]
    if set(types) & set(GRAPH_TYPES) and len(args.model_specs) > 1:
        args.sequential_models = True  # the graph and warm-up are stored per topic: models cannot share them
    return args


def select_topics(topics: List[dict], num: Optional[int], indexes: Optional[str]) -> List[dict]:
    """Topics to generate, each with a stable `key` and `index` into the full list."""
    if indexes:
        chosen = [int(i) for i in indexes.split(",")]
        bad = [i for i in chosen if not 0 <= i < len(topics)]
        if bad:
            raise SystemExit(f"--topic-indexes {bad} out of range (0-{len(topics) - 1})")
    elif num is None or num >= len(topics):
        chosen = list(range(len(topics)))
    elif num <= 1:
        chosen = [0]
    else:
        chosen = sorted({round(i * (len(topics) - 1) / (num - 1)) for i in range(num)})
    return [{**topics[i], "index": i, "key": f"t{i:02d}-{slugify(topics[i]['name'])}"} for i in chosen]


def load_topics_file(path: Path, corpus_id: str) -> Optional[dict]:
    """Fixed topics for a corpus from --topics-file or a previous run's topics.json.

    Accepts {corpus: [topic...]}, {corpus: {"all": [...], "selected": [...]}} (a run's topics.json)
    or a bare list (used for every corpus). Returns {"all": [...], "selected_keys": [...] | None}.
    """
    data = json.loads(path.read_text())
    entry = data.get(corpus_id) if isinstance(data, dict) else data
    if entry is None:
        return None
    if isinstance(entry, dict) and "all" in entry:
        return {"all": entry["all"], "selected": entry.get("selected")}
    if not isinstance(entry, list):
        raise SystemExit(f"{path}: expected a list of topics for {corpus_id}")
    for topic in entry:
        if not topic.get("name"):
            raise SystemExit(f"{path}: every topic needs a name")
    return {"all": [{"name": t["name"], "description": t.get("description", ""), "keywords": t.get("keywords", [])} for t in entry], "selected": None}


# --------------------------------------------------------------------------------------
# Plan and estimate (dry run)
# --------------------------------------------------------------------------------------

# Prompt sizes for the estimate: 24 chunks of about 350 tokens plus the system prompt, the
# instructions and (for structured calls) the schema.
EST_PROMPT_TOKENS = {"concepts": 11000, "warmup": 10000, "notes": 9500, "solved": 11500, "interactive": 11500, "quiz": 11500}


def print_plan(args: argparse.Namespace, tracker, specs, topics_per_corpus: Dict[str, int]) -> None:
    import adapters

    n_topics = sum(topics_per_corpus.values())
    log("Plan")
    log(f"  corpora: {', '.join(args.corpus_list)}   topics generated: {n_topics} ({topics_per_corpus})")
    log(f"  models: {', '.join(s.label for s in specs)}   types: {', '.join(args.type_list)}")
    total = 0.0
    for spec in specs:
        per_topic = sum(
            tracker.estimate_call(spec.model_id, adapters.PURPOSES[t], EST_PROMPT_TOKENS[t]) for t in args.type_list
        )
        total += per_topic * n_topics
        log(f"  {spec.label:<18} about ${per_topic:.2f} per topic, ${per_topic * n_topics:.2f} for {n_topics} topics")
    judge_total = 0.0
    if args.judge:
        jspec = adapters.parse_model_spec(args.judge if ":" in args.judge else f"{args.judge}:medium")
        prompt = 9000 + 3500 * len(specs)
        per_pair = tracker.estimate_call(jspec.model_id, "judge", prompt)
        judge_total = per_pair * n_topics * len([t for t in args.type_list if t in JUDGED_TYPES])
        log(f"  judge {jspec.label}: about ${per_pair:.2f} per (topic, type), ${judge_total:.2f} for {n_topics * len([t for t in args.type_list if t in JUDGED_TYPES])} pairs")
    log(f"  estimated total: ${total + judge_total:.2f} (generation ${total:.2f}). Caps: --max-usd {args.max_usd}, --max-judge-usd {args.max_judge_usd}")
    log("  These are rough: output length, thinking tokens and cache behaviour decide the real cost. Nothing was called.")


# --------------------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------------------


async def prepare_corpus(args, corpus: dict, topics_input: Optional[dict], run_dir: Path, extractor_provider) -> Dict[str, Any]:
    """Ingest the corpus, settle topics, store and map them. Returns topic rows and excerpts."""
    import adapters

    corpus_id = corpus["id"]
    project_id = project_id_for(corpus_id)
    documents = []
    for document in corpus["documents"]:
        path = document_path(corpus, document)
        documents.append(
            IngestDocument(
                id=f"{corpus_id}-{document['id']}",
                path=path,
                filename=document["filename"],
                category=document["category"],
                fingerprint_inputs={
                    "kind": document["kind"],
                    "url": document["url"],
                    "sha256": document.get("sha256") or document.get("text_sha256"),
                },
                missing_hint="Run: cd ai-service && uv run python -I ../evals/generation/fetch_corpus.py",
            )
        )
    log(f"Ingesting {corpus_id}")
    await ingest_documents(
        project_id=project_id,
        user_id=EVAL_USER_ID,
        project_name=corpus["project_name"],
        user_email="generation-evals@example.invalid",
        user_name="Generation evals",
        documents=documents,
        rebuild=args.rebuild,
    )

    if topics_input is not None:
        all_topics = topics_input["all"]
        source = "fixed topics file"
        if topics_input.get("selected") and args.num_topics is None and not args.topic_indexes:
            selected = topics_input["selected"]
        else:
            selected = select_topics(all_topics, args.num_topics, args.topic_indexes)
    else:
        log(f"Extracting topics for {corpus_id} with the app's topic extraction")
        all_topics = await adapters.extract_topics(project_id, extractor_provider)
        if not all_topics:
            raise SystemExit(f"topic extraction returned no topics for {corpus_id}")
        selected = select_topics(all_topics, args.num_topics if args.num_topics is not None else 4, args.topic_indexes)
        source = "the app's course planner"
    log(f"  {len(all_topics)} topics, generating {len(selected)}: " + "; ".join(t["name"] for t in selected))

    if all(t.get("id") for t in all_topics):
        ids = [t["id"] for t in all_topics]  # the planner stored them with their sources
    else:
        ids = await adapters.store_topics(project_id, all_topics)
        for topic_id, topic in zip(ids, all_topics):
            count = await adapters.map_topic(project_id, topic_id, topic)
            if count == 0:
                log(f"  warning: no chunks mapped to '{topic['name']}'")
    rows = []
    excerpts = {}
    for topic in selected:
        topic_id = ids[topic["index"]]
        topic_row = {**topic, "id": topic_id}
        rows.append(topic_row)
        excerpts[topic["key"]] = await adapters.fetch_excerpts(topic_id)
    return {"all": all_topics, "selected": selected, "rows": rows, "excerpts": excerpts, "source": source}


async def generate_for_topic(args, corpus_id, topic_row, specs, providers, generators, tracker, run_dir, params, state) -> None:
    import adapters
    from analysis import raw_name
    from spend import SpendLimitReached

    raw_dir = run_dir / "raw"

    async def one_model(spec) -> None:
        provider, gens = providers[spec.slug], generators[spec.slug]
        for content_type in args.type_list:
            path = raw_dir / raw_name(corpus_id, topic_row["key"], spec.slug, content_type)
            if path.exists() and args.resume and json.loads(path.read_text()).get("status") == "ok":
                continue
            if tracker.stops:
                return
            before = len(provider.calls)
            record: Dict[str, Any] = {
                "corpus": corpus_id,
                "topic": {k: topic_row[k] for k in ("key", "index", "name", "description", "keywords")},
                "model": {"slug": spec.slug, "label": spec.label, "model_id": spec.model_id, "effort": spec.effort},
                "type": content_type,
                "params": params,
                "started_at": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
            }
            started = time.perf_counter()
            try:
                record["output"] = await adapters.generate(gens, topic_row, content_type, params)
                record["status"] = "ok"
            except SpendLimitReached as exc:
                state["stopped"] = state.get("stopped") or str(exc)
                log(f"  STOP: {exc}")
                return
            except Exception as exc:  # a failed generation is a result, not a crash
                record["status"] = "error"
                record["error"] = f"{type(exc).__name__}: {exc}"
            record["seconds"] = round(time.perf_counter() - started, 2)
            record["calls"] = provider.calls[before:]
            record["cost_usd"] = round(sum(c["cost_usd"] for c in record["calls"]), 6)
            path.write_text(json.dumps(record, indent=2, default=str) + "\n")
            tail = f"${record['cost_usd']:.4f}, {record['seconds']:.0f}s" if record["status"] == "ok" else record["error"][:140]
            log(f"    {spec.label:<16} {content_type:<12} {record['status']:<5} {tail}")

    if args.sequential_models:
        for spec in specs:
            await one_model(spec)
    else:
        await asyncio.gather(*[one_model(spec) for spec in specs])


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------


def existing_spend(run_dir: Path) -> Dict[str, float]:
    """Spend of earlier runs in this folder, so a resumed run keeps one budget."""
    spend = {"generation": 0.0, "judge": 0.0, "topics": 0.0}
    run_file = run_dir / "run.json"
    if run_file.exists():
        spend["topics"] = float(json.loads(run_file.read_text()).get("spend", {}).get("topics", 0.0))
    for path in (run_dir / "raw").glob("*.json") if (run_dir / "raw").exists() else []:
        spend["generation"] += float(json.loads(path.read_text()).get("cost_usd", 0.0))
    for path in (run_dir / "judge").glob("*.json") if (run_dir / "judge").exists() else []:
        spend["judge"] += sum(c.get("cost_usd", 0.0) for c in json.loads(path.read_text()).get("calls", []))
    return spend


async def run(args: argparse.Namespace) -> int:
    import adapters
    import analysis
    import report
    from judge import run_judge
    from spend import GENERATION, JUDGE, SpendTracker

    specs = [adapters.parse_model_spec(s) for s in args.model_specs]
    if len({s.slug for s in specs}) != len(specs):
        raise SystemExit("--models lists the same model and effort twice")
    judge_spec = None
    if args.judge:
        judge_spec = adapters.parse_model_spec(args.judge if ":" in args.judge else f"{args.judge}:medium")
    tracker = SpendTracker(args.max_usd, args.max_judge_usd, adapters.estimate_cost)

    if args.dry_run:
        counts = {}
        dry_topics_file = args.topics_file or (args.resume / "topics.json" if args.resume else None)
        for corpus_id in args.corpus_list:
            load_corpus(corpus_id)
            fixed = load_topics_file(dry_topics_file, corpus_id) if dry_topics_file and dry_topics_file.exists() else None
            available = len(fixed["all"]) if fixed else 10
            if fixed and fixed.get("selected") and args.num_topics is None and not args.topic_indexes:
                counts[corpus_id] = len(fixed["selected"])
            else:
                default = None if fixed else 4
                counts[corpus_id] = len(
                    select_topics([{"name": f"t{i}"} for i in range(available)], args.num_topics if args.num_topics is not None else default, args.topic_indexes)
                )
        print_plan(args, tracker, specs, counts)
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
    for kind, usd in existing_spend(run_dir).items():
        tracker.add_past_spend(kind, usd)
    if args.resume:
        log(f"Resuming {run_dir}: ${tracker.total_spent:.2f} already spent in this folder")

    models_info = [{"slug": s.slug, "label": s.label, "model_id": s.model_id, "effort": s.effort} for s in specs]
    params = {
        "examples": args.examples,
        "questions": args.questions,
        "difficulty": args.difficulty,
        "detail_level": args.detail_level,
    }
    if args.no_generate:
        models_info = previous["models"]
        params = previous["params"]
        args.type_list = previous["types"]
        specs = [adapters.parse_model_spec(f"{m['model_id']}:{m['effort']}") for m in models_info]

    api_key = ""
    if not args.mock and (not args.no_generate or judge_spec):
        api_key = adapters.load_api_key(args.env_file)
        if not api_key:
            raise SystemExit(f"ANTHROPIC_API_KEY is not set and {args.env_file} has none. Use --mock to test without a key.")

    run_info: Dict[str, Any] = {
        "label": args.label,
        "date": date,
        "code": {
            "commit": git("rev-parse", "HEAD"),
            "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "app_dirty": bool(git("status", "--porcelain", "--", "ai-service/app")),
        },
        "corpora": args.corpus_list if not args.no_generate else previous["corpora"],
        "types": args.type_list,
        "models": models_info,
        "params": params,
        "judge": judge_spec.label if judge_spec else None,
        "mock": args.mock,
        "seed": args.seed,
        "max_usd": args.max_usd,
        "max_judge_usd": args.max_judge_usd,
        "notes_sections": adapters.notes_expectations().get("sections"),
        "topics_source": previous.get("topics_source", "n/a"),
        "stopped": previous.get("stopped"),
    }

    topics_file: Optional[Path] = args.topics_file
    if args.resume and not topics_file and (run_dir / "topics.json").exists():
        topics_file = run_dir / "topics.json"  # same topics as the first run

    if not args.no_generate:
        corpora = [load_corpus(c) for c in args.corpus_list]

        # One provider (the app's own); each MeteredProvider pins its model and effort per call.
        inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
        providers = {s.slug: adapters.MeteredProvider(inner, s, tracker, GENERATION) for s in specs}
        generators = {slug: adapters.make_generators(p) for slug, p in providers.items()}
        # Topic extraction runs with the app's own model choice for its purpose (no pin).
        extractor = adapters.MeteredProvider(inner, None, tracker, "topics")

        topics_all: Dict[str, Any] = {}
        excerpts_all: Dict[str, Any] = {}
        if (run_dir / "topics.json").exists():
            topics_all = json.loads((run_dir / "topics.json").read_text())
        if (run_dir / "excerpts.json").exists():
            excerpts_all = json.loads((run_dir / "excerpts.json").read_text())
        state: Dict[str, Any] = {}
        sources = set()
        for corpus in corpora:
            fixed = load_topics_file(topics_file, corpus["id"]) if topics_file else None
            if topics_file and fixed is None:
                raise SystemExit(f"{topics_file} has no topics for {corpus['id']}")
            prepared = await prepare_corpus(args, corpus, fixed, run_dir, extractor)
            sources.add(prepared["source"])
            topics_all[corpus["id"]] = {"all": prepared["all"], "selected": prepared["selected"]}
            excerpts_all.setdefault(corpus["id"], {}).update(prepared["excerpts"])
            (run_dir / "topics.json").write_text(json.dumps(topics_all, indent=2) + "\n")
            (run_dir / "excerpts.json").write_text(json.dumps(excerpts_all, indent=2) + "\n")
            for topic_row in prepared["rows"]:
                if not prepared["excerpts"][topic_row["key"]]:
                    log(f"Skipping {corpus['id']} / {topic_row['name']}: no chunks mapped to it")
                    continue
                log(f"Generating {corpus['id']} / {topic_row['name']} ({len(prepared['excerpts'][topic_row['key']])} excerpts)")
                await generate_for_topic(args, corpus["id"], topic_row, specs, providers, generators, tracker, run_dir, params, state)
                if tracker.stops:
                    break
            if tracker.stops:
                break
        run_info["topics_source"] = ", ".join(sorted(sources)) if sources else run_info["topics_source"]
        if state.get("stopped"):
            run_info["stopped"] = state["stopped"]
        if extractor.calls:
            log(f"Topic extraction cost ${sum(c['cost_usd'] for c in extractor.calls):.4f}")
        from app.db.connection import close_db_pool

        await close_db_pool()

    # ------------------------------------------------------------------ judge
    judge_info: Dict[str, Any] = {}
    if judge_spec:
        records = analysis.load_raw(run_dir)
        outputs = analysis.outputs_by_model(records)
        excerpts = json.loads((run_dir / "excerpts.json").read_text())
        judge_provider = adapters.MeteredProvider(
            adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), judge_spec, tracker, JUDGE
        )
        log("Judging")
        judge_info = await run_judge(
            provider=judge_provider,
            outputs=outputs,
            excerpts=excerpts,
            model_slugs=[s.slug for s in specs],
            content_types=[t for t in args.type_list if t in JUDGED_TYPES],
            judge_dir=run_dir / "judge",
            seed=args.seed,
            log=log,
        )
        if JUDGE in tracker.stops and not run_info.get("stopped"):
            run_info["stopped"] = f"judge: {tracker.stops[JUDGE]}"

    # ------------------------------------------------------------------ report
    spend = {
        "generation": round(tracker.spent[GENERATION], 4),
        "topics": round(tracker.spent["topics"], 4),
        "judge": round(tracker.spent[JUDGE], 4),
    }
    run_info["spend"] = spend
    (run_dir / "run.json").write_text(json.dumps(run_info, indent=2) + "\n")
    summary = analysis.build_summary(run_dir, run_info, spend, judge_info)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str) + "\n")
    md_path = run_dir.parent / f"{run_dir.name}.md"
    md_path.write_text(report.render_markdown(summary))
    log(f"\nWrote {md_path}\nWrote {run_dir / 'summary.json'}")
    log(f"Spent ${sum(spend.values()):.2f} (generation ${spend['generation']:.2f}, topics ${spend['topics']:.2f}, judge ${spend['judge']:.2f})")
    for slug, m in summary["models"].items():
        c = m["cost"]
        log(f"  {m['label']:<18} ${c['mean_cost_per_topic_usd']:.3f} per topic, ${c['projected_cost_12_topics_usd']:.2f} per 12 topics, {c['mean_seconds_per_topic']:.0f}s per topic")
    return 0


def main() -> int:
    args = parse_args()
    check_db_name(args.db, args.allow_any_db)
    prepare_app_environment(args.db)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())

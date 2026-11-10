"""A1: how well each reader reads a page, scored against the hand-checked keys.

Arms: the text read the app uses today (pymupdf4llm through the app's `extract_document`), and the candidate page reader
(`reader.py`, ReadableSTEM's) on Haiku, Sonnet and Opus. Every page of `corpus.json` is read once by each arm and
scored with `score.py`; the report gives each class's mean scores by arm, the cost, and how each read ended.

The text arm reads a typed page from its whole source document when that is on this machine, as the app does (heading
levels come from font sizes across the whole document), and from the one-page PDF otherwise. A scan or a handwritten
page is read from its one-page PDF: it has no text, which is why the app refuses it today. The vision arms go through
the Message Batches API at half price.

A vision read that stopped early (max_tokens) or did not parse counts as an empty read: the student would get nothing.
A call that failed on the API's side is left out of the scores and counted under outcomes.

Usage (from ai-service/):
  uv run python -I ../evals/extraction/run_a1.py --dry-run          # the text arm only, and the cost estimate
  uv run python -I ../evals/extraction/run_a1.py --label a1         # all arms (asks the cap first)
  ... --arms haiku --only os-maths-1 --label a1-smoke               # one page, one arm
  ... --resume ../evals/results/<date>-a1                            # send only the reads not yet stored

Output: evals/results/<date>-<label>/ (raw/ holds every read and stays local: K21), summary.json, run.json, and the
report evals/results/<date>-<label>.md (scores and page ids only, no page text).
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
REPO_ROOT = EVALS_DIR.parent
AI_SERVICE_DIR = REPO_ROOT / "ai-service"
RESULTS_DIR = EVALS_DIR / "results"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(EVALS_DIR))

import pages  # noqa: E402
import reader  # noqa: E402
import score  # noqa: E402

ARMS: Dict[str, Optional[str]] = {
    "text": None,
    "haiku": "claude-haiku-5-5",
    "sonnet": "claude-sonnet-5-5",
    "opus": "claude-opus-5-5",
}
BATCH_PRICE = 0.5
EST_OUTPUT_TOKENS = 5000  # a dense page's blocks, bounding boxes included
CHARS_PER_TOKEN = 3.5
DEFAULT_MAX_USD = 4.0
UNUSED_DB = "postgresql://user:pass@localhost:5432/unused"  # app.config wants one; A1 never connects

SCORE_LABELS = {
    "words_dropped": "Words dropped (lower is better)",
    "words_invented": "Words invented (lower is better)",
    "formulas_exact": "Formulas exact",
    "formula_symbols": "Formula symbols kept",
    "table_cells": "Table cells found",
    "table_shape": "Table shape right",
    "headings_found": "Headings found",
    "heading_levels": "Heading levels right",
    "code_lines": "Code lines kept",
    "figures_noted": "Figures noted",
}


def log(message: str = "") -> None:
    print(message, flush=True)


def _app() -> None:
    """Make `app` importable without printing settings: app.config needs a DATABASE_URL (finding 91)."""
    os.environ.setdefault("DATABASE_URL", UNUSED_DB)
    os.environ.setdefault("EMBEDDING_PROVIDER", "local")
    if str(AI_SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(AI_SERVICE_DIR))


# ---------------------------------------------------------------------------- the text arm

_documents: Dict[Path, Any] = {}


def _extract(path: Path):
    _app()
    from app.services.document_processor.extractors import extract_document

    if path not in _documents:
        _documents[path] = extract_document(str(path), path.name)
    return _documents[path]


def text_read(corpus: Dict[str, Any], entry: Dict[str, Any]) -> Dict[str, str]:
    """Today's read of the page: {"markdown", "how" ("document" or "page"), "outcome" ("ok" or "empty")}."""
    source = Path(pages.source_path(corpus, entry)) if pages.is_typed(entry) else None
    if source is not None and source.exists():
        how, extracted, index = "document", _extract(source), entry["page"]
    else:
        how, extracted, index = "page", _extract(pages.page_path(entry)), 0
    page = extracted.pages[index]
    if page.number in extracted.empty_pages:
        return {"markdown": "", "how": how, "outcome": "empty"}
    return {"markdown": page.text, "how": how, "outcome": "ok"}


# ---------------------------------------------------------------------------- costs


def batch_cost_usd(model: str, usage: Any) -> float:
    _app()
    from app.services.llm.base import LLMUsage
    from app.services.llm.usage import estimate_cost_usd

    counted = LLMUsage(
        model=model,
        purpose="a1",
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
        cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
    )
    return (estimate_cost_usd(counted) or 0.0) * BATCH_PRICE


def estimate_usd(model: str, *, width: int, height: int, prompt_chars: int, text_chars: int) -> float:
    """What one page read should cost on the Batch API: the picture (width x height / 750 tokens), the prompt and the
    text layer (3.5 characters a token), and an answer of EST_OUTPUT_TOKENS."""
    from types import SimpleNamespace

    million = 1_000_000
    per_input = batch_cost_usd(model, SimpleNamespace(input_tokens=million, output_tokens=0)) / million
    per_output = batch_cost_usd(model, SimpleNamespace(input_tokens=0, output_tokens=million)) / million
    tokens_in = width * height / 750 + (prompt_chars + text_chars) / CHARS_PER_TOKEN
    return tokens_in * per_input + EST_OUTPUT_TOKENS * per_output


def check_cap(*, estimate: float, spent: float, max_usd: float) -> None:
    if spent + estimate > max_usd:
        raise SystemExit(
            f"The run would pass the spend cap: ${spent:.2f} spent so far plus ${estimate:.2f} estimated is more than "
            f"${max_usd:.2f}. Raise --max-usd or narrow --arms / --only."
        )


# ---------------------------------------------------------------------------- scoring and the summary


def scores_for(key: score.Parsed, markdown: str, outcome: str) -> Optional[Dict[str, Optional[float]]]:
    """A read's scores; a read that ended badly scores as an empty one, a failed call has none."""
    if outcome.startswith("error"):
        return None
    return score.score_page(key, score.parse_markdown(markdown if outcome == "ok" else ""))


def _mean(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 4) if values else None


def aggregate(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    arms = list(dict.fromkeys(r["arm"] for r in records))
    classes = [c for c in pages.CLASSES if any(r["class"] == c for r in records)]
    by_class: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for cls in classes + ["all"]:
        by_class[cls] = {}
        for arm in arms:
            scored = [r for r in records if r["arm"] == arm and (cls == "all" or r["class"] == cls) and r["scores"] is not None]
            row: Dict[str, Any] = {"pages": len(scored)}
            for name in score.SCORES:
                row[name] = _mean([r["scores"][name] for r in scored if r["scores"][name] is not None])
            by_class[cls][arm] = row
    outcomes: Dict[str, Dict[str, int]] = {}
    usd: Dict[str, float] = {}
    for arm in arms:
        outcomes[arm] = {}
        for r in records:
            if r["arm"] == arm:
                outcomes[arm][r["outcome"]] = outcomes[arm].get(r["outcome"], 0) + 1
        usd[arm] = round(sum(r.get("usd") or 0.0 for r in records if r["arm"] == arm), 4)
    per_page = [
        {"id": r["id"], "class": r["class"], "arm": r["arm"], "outcome": r["outcome"], "scores": r["scores"]} for r in records
    ]
    return {"arms": arms, "classes": classes, "by_class": by_class, "outcomes": outcomes, "usd": usd, "pages": per_page}


def _pct(value: Optional[float]) -> str:
    return "–" if value is None else f"{round(value * 100)}%"


def _table(head: List[str], rows: List[List[str]]) -> str:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    return "\n".join(lines + ["| " + " | ".join(row) + " |" for row in rows])


def render_report(summary: Dict[str, Any]) -> str:
    run = summary.get("run", {})
    arms = summary["arms"]
    names = [f"{arm} ({ARMS.get(arm) or 'pymupdf4llm'})" if arm != "text" else "text (today)" for arm in arms]
    out = [
        f"# A1 extraction eval: {run.get('label', '')} ({run.get('date', '')})",
        "",
        f"Commit {run.get('commit', '?')}. Each page of `evals/extraction/corpus.json` read once by each arm and scored "
        "against its hand-checked key (`score.py`). Scores are means over the pages that have the feature; `–` means "
        "no page of the class has it. A read that stopped early or did not parse counts as an empty read.",
        "",
        "Cost (Batch API, half the app's prices): "
        + ", ".join(f"{arm} ${summary['usd'].get(arm, 0.0):.2f}" for arm in arms)
        + f"; total ${sum(summary['usd'].values()):.2f}.",
    ]
    for cls in summary["classes"] + ["all"]:
        rows = summary["by_class"][cls]
        out += ["", f"## {cls}", ""]
        body = [["Pages read", *[str(rows[arm]["pages"]) for arm in arms]]]
        for name in score.SCORES:
            if any(rows[arm][name] is not None for arm in arms):
                body.append([SCORE_LABELS[name], *[_pct(rows[arm][name]) for arm in arms]])
        out.append(_table(["Score", *names], body))
    out += ["", "## How each read ended", ""]
    kinds = sorted({k for arm in arms for k in summary["outcomes"][arm]})
    out.append(_table(["Arm", *kinds], [[arm, *[str(summary["outcomes"][arm].get(k, 0)) for k in kinds]] for arm in arms]))
    out += ["", "## Pages", "", "Words dropped / words invented per page and arm.", ""]
    ids = list(dict.fromkeys(p["id"] for p in summary["pages"]))
    page_rows = []
    for page_id in ids:
        cells = []
        cls = next(p["class"] for p in summary["pages"] if p["id"] == page_id)
        for arm in arms:
            hit = next((p for p in summary["pages"] if p["id"] == page_id and p["arm"] == arm), None)
            if hit is None or hit["scores"] is None:
                cells.append(hit["outcome"] if hit else "")
            else:
                cells.append(f"{_pct(hit['scores']['words_dropped'])} / {_pct(hit['scores']['words_invented'])}")
        page_rows.append([page_id, cls, *cells])
    out.append(_table(["Page", "Class", *arms], page_rows))
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------- the run


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", default="a1")
    parser.add_argument("--arms", default=",".join(ARMS), help="comma-separated, from: " + ", ".join(ARMS))
    parser.add_argument("--only", nargs="*", help="page ids")
    parser.add_argument("--dry-run", action="store_true", help="the text arm and the estimate only; nothing is sent")
    parser.add_argument("--max-usd", type=float, default=DEFAULT_MAX_USD)
    parser.add_argument("--resume", type=Path, help="an earlier run directory; reads already stored are kept")
    parser.add_argument("--batch-poll", type=float, default=15.0)
    args = parser.parse_args(argv)
    args.arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    unknown = [a for a in args.arms if a not in ARMS]
    if unknown:
        parser.error(f"unknown arms: {', '.join(unknown)}")
    return args


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True).stdout.strip()


def _raw(run_dir: Path, page_id: str, arm: str) -> Path:
    return run_dir / "raw" / f"{page_id}.{arm}.json"


def _store(run_dir: Path, record: Dict[str, Any], markdown: str, reply: Optional[Dict[str, Any]] = None) -> None:
    path = _raw(run_dir, record["id"], record["arm"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"record": record, "markdown": markdown, "reply": reply}, indent=1) + "\n")


def _png_size(png: bytes) -> tuple:
    return int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")


async def _vision(client, run_dir: Path, entry: Dict[str, Any], arm: str, png: bytes, text: Optional[str], key) -> Dict[str, Any]:
    from common.batching import BatchRequestError

    model = ARMS[arm]
    started = time.monotonic()
    record: Dict[str, Any] = {"id": entry["id"], "class": entry["class"], "kind": entry["kind"], "arm": arm, "model": model}
    reply = None
    markdown = ""
    try:
        message = await client.beta.messages.create(**reader.build_params(model, png, text))
        output, outcome = reader.parse_reply(message)
        usage = message.usage
        record["usage"] = {
            name: getattr(usage, name, 0) or 0
            for name in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        }
        record["usd"] = round(batch_cost_usd(model, usage), 6)
        if output is not None:
            reply = output
            markdown = reader.blocks_to_markdown(output)
    except BatchRequestError as exc:
        outcome = f"error: {exc}"[:120]
        record["usd"] = 0.0
    record["outcome"] = outcome
    record["seconds"] = round(time.monotonic() - started, 1)
    record["scores"] = scores_for(key, markdown, outcome)
    _store(run_dir, record, markdown, reply)
    log(f"  {entry['id']:<14} {arm:<6} {outcome:<10} ${record['usd']:.4f}")
    return record


async def run(args: argparse.Namespace) -> int:
    corpus = pages.load_corpus()
    entries = [e for e in corpus["pages"] if not args.only or e["id"] in args.only]
    missing = [e["id"] for e in entries if not pages.page_path(e).exists() or not pages.key_path(e).exists()]
    if missing:
        raise SystemExit(f"Pages or keys missing (run pages.py build; local keys live in evals/.cache): {', '.join(missing)}")
    run_dir = args.resume or RESULTS_DIR / f"{date.today().isoformat()}-{args.label}"
    run_dir.mkdir(parents=True, exist_ok=True)
    stored: Dict[tuple, Dict[str, Any]] = {}
    for path in sorted((run_dir / "raw").glob("*.json")) if (run_dir / "raw").exists() else []:
        record = json.loads(path.read_text())["record"]
        stored[(record["id"], record["arm"])] = record

    keys = {e["id"]: score.parse_markdown(pages.key_path(e).read_text()) for e in entries}
    records: List[Dict[str, Any]] = []
    if "text" in args.arms:
        for entry in entries:
            if (entry["id"], "text") in stored:
                records.append(stored[(entry["id"], "text")])
                continue
            read = text_read(corpus, entry)
            record = {"id": entry["id"], "class": entry["class"], "kind": entry["kind"], "arm": "text", "model": None,
                      "how": read["how"], "outcome": read["outcome"], "usd": 0.0}
            record["scores"] = scores_for(keys[entry["id"]], read["markdown"], read["outcome"])
            _store(run_dir, record, read["markdown"])
            records.append(record)
        log(f"Text arm: {len(entries)} pages read")

    vision_arms = [a for a in args.arms if ARMS[a]]
    todo = []
    estimate = 0.0
    prompt_chars = {typed: len(reader.instructions(typed)) for typed in (True, False)}
    for entry in entries:
        png = reader.page_png(pages.page_path(entry))
        text = reader.text_layer(pages.page_path(entry)) if pages.is_typed(entry) else None
        width, height = _png_size(png)
        for arm in vision_arms:
            if (entry["id"], arm) in stored:
                records.append(stored[(entry["id"], arm)])
                continue
            todo.append((entry, arm, png, text))
            estimate += estimate_usd(ARMS[arm], width=width, height=height, prompt_chars=prompt_chars[text is not None],
                                     text_chars=len(text or ""))
    spent = sum(r.get("usd") or 0.0 for r in stored.values())
    log(f"Vision reads to send: {len(todo)} ({', '.join(vision_arms) or 'none'}); estimate ${estimate:.2f} on the "
        f"Batch API; spent in this run directory so far ${spent:.2f}; cap ${args.max_usd:.2f}")

    if todo and not args.dry_run:
        check_cap(estimate=estimate, spent=spent, max_usd=args.max_usd)
        _app()
        import anthropic
        from common.batching import BatchedCalls

        sys.path.insert(0, str(EVALS_DIR / "generation"))
        import adapters

        api_key = adapters.load_api_key(AI_SERVICE_DIR / ".env")
        if not api_key:
            raise SystemExit("ANTHROPIC_API_KEY is not set and ai-service/.env has none.")
        client = BatchedCalls(anthropic.AsyncAnthropic(api_key=api_key, max_retries=3), poll=args.batch_poll, log=log)
        records += await asyncio.gather(*[
            _vision(client, run_dir, entry, arm, png, text, keys[entry["id"]]) for entry, arm, png, text in todo
        ])

    order = {(e["id"], a): i for i, (e, a) in enumerate((e, a) for e in entries for a in args.arms)}
    records.sort(key=lambda r: order.get((r["id"], r["arm"]), len(order)))
    summary = aggregate(records)
    summary["run"] = {
        "label": args.label,
        "date": date.today().isoformat(),
        "commit": git("rev-parse", "--short", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "arms": {arm: ARMS[arm] for arm in args.arms},
        "reader": {"dpi": reader.DPI, "max_side_px": reader.MAX_SIDE_PX, "effort": reader.EFFORT, "max_tokens": reader.MAX_TOKENS},
        "pages": [e["id"] for e in entries],
        "dry_run": args.dry_run,
        "estimate_usd": round(estimate, 4),
    }
    (run_dir / "run.json").write_text(json.dumps(summary["run"], indent=2) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    report = RESULTS_DIR / f"{run_dir.name}.md"
    report.write_text(render_report(summary))
    log(f"Report: {report}")
    log("Cost: " + ", ".join(f"{arm} ${usd:.4f}" for arm, usd in summary["usd"].items()) + f"; total ${sum(summary['usd'].values()):.4f}")
    return 0


def main() -> int:
    return asyncio.run(run(parse_args()))


if __name__ == "__main__":
    sys.exit(main())

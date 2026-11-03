"""Turn a results folder (raw outputs, excerpts, judge files) into the summary the report prints.

Pure functions over stored JSON: no database, no model, no app imports. That is why
`run_eval.py --resume DIR --no-generate` can rebuild checks and the report from files alone.

Results folder layout (evals/results/<date>-<label>/):

    run.json        configuration, code version, spend
    topics.json     {corpus: {"all": [topic...], "selected": [topic...]}}; topic = key, name, description, keywords
    excerpts.json   {corpus: {topic_key: [excerpt...]}}           (source text: not committed)
    raw/*.json      one file per (corpus, topic, model, type)      (model output: not committed)
    judge/*.json    one file per (corpus, topic, type)             (not committed)
    summary.json    what this module returns                       (no source text beyond short samples)
"""
import json
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List, Optional

import checks
from judge import aggregate, load_judged

PROJECTION_TOPICS = 12


def raw_name(corpus: str, topic_key: str, slug: str, content_type: str) -> str:
    return f"{corpus}__{topic_key}__{slug}__{content_type}.json"


def load_raw(run_dir: Path) -> List[Dict[str, Any]]:
    raw_dir = run_dir / "raw"
    if not raw_dir.exists():
        return []
    return [json.loads(p.read_text()) for p in sorted(raw_dir.glob("*.json"))]


def outputs_by_model(records: List[Dict[str, Any]]) -> Dict[str, Dict[str, Dict[str, Dict[str, Any]]]]:
    """outputs[corpus][topic_key][slug][type] for records that succeeded."""
    outputs: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]] = {}
    for record in records:
        if record.get("status") != "ok":
            continue
        by_topic = outputs.setdefault(record["corpus"], {}).setdefault(record["topic"]["key"], {})
        by_topic.setdefault(record["model"]["slug"], {})[record["type"]] = record["output"]
    return outputs


def _mean(values: List[float]) -> Optional[float]:
    return mean(values) if values else None


def cost_and_latency(records: List[Dict[str, Any]], content_types: List[str]) -> Dict[str, Any]:
    """Cost, latency and token totals for one model's records."""
    per_type: Dict[str, Dict[str, Any]] = {}
    for content_type in content_types:
        ok = [r for r in records if r["type"] == content_type and r["status"] == "ok"]
        if not ok and not any(r["type"] == content_type for r in records):
            continue
        per_type[content_type] = {
            "generated": len(ok),
            "failed": sum(1 for r in records if r["type"] == content_type and r["status"] == "error"),
            "mean_cost_usd": _mean([r["cost_usd"] for r in ok]),
            "mean_seconds": _mean([r["seconds"] for r in ok]),
        }
    per_topic_cost = sum(t["mean_cost_usd"] for t in per_type.values() if t["mean_cost_usd"] is not None)
    per_topic_seconds = sum(t["mean_seconds"] for t in per_type.values() if t["mean_seconds"] is not None)
    calls = [c for r in records for c in r.get("calls", [])]
    return {
        "per_type": per_type,
        "mean_cost_per_topic_usd": per_topic_cost,
        "projected_cost_12_topics_usd": per_topic_cost * PROJECTION_TOPICS,
        "mean_seconds_per_topic": per_topic_seconds,
        "total_cost_usd": sum(r["cost_usd"] for r in records),
        "calls": len(calls),
        "input_tokens": sum(c["input_tokens"] for c in calls),
        "output_tokens": sum(c["output_tokens"] for c in calls),
        "cache_read_input_tokens": sum(c["cache_read_input_tokens"] for c in calls),
        "cache_creation_input_tokens": sum(c["cache_creation_input_tokens"] for c in calls),
    }


def run_checks(
    outputs: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]],
    excerpts: Dict[str, Dict[str, List[Dict[str, Any]]]],
    model_slugs: List[str],
    params: Dict[str, Any],
    notes_sections: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Automatic checks for every model: per topic, and summed per model."""
    requested = {
        "examples": params.get("examples", 3),
        "questions": params.get("questions", 10),
        "difficulty": params.get("difficulty", "medium"),
    }
    kwargs = {"requested": requested}
    if notes_sections:
        kwargs["notes_sections"] = notes_sections
    per_topic: Dict[str, Dict[str, Dict[str, Any]]] = {}
    summaries: Dict[str, Any] = {}
    for slug in model_slugs:
        topic_results: Dict[str, Dict[str, Any]] = {}
        statements: Dict[str, List[str]] = {}
        for corpus, topics in outputs.items():
            for topic_key, by_model in topics.items():
                model_outputs = by_model.get(slug)
                if not model_outputs:
                    continue
                full_key = f"{corpus}/{topic_key}"
                texts = [e["text"] for e in excerpts.get(corpus, {}).get(topic_key, [])]
                chunk_texts = {e["chunk_id"]: e["text"] for e in excerpts.get(corpus, {}).get(topic_key, []) if e.get("chunk_id")}
                topic_results[full_key] = checks.check_topic(model_outputs, texts, chunk_texts=chunk_texts, **kwargs)
                statements[full_key] = checks.problem_statements(
                    model_outputs.get(checks.SOLVED), model_outputs.get(checks.INTERACTIVE)
                )
        per_topic[slug] = topic_results
        summaries[slug] = checks.summarize_model(topic_results, statements) if topic_results else None
    return {"per_topic": per_topic, "summary": summaries}


def pick_samples(outputs, model_slugs: List[str], content_types: List[str]) -> Optional[Dict[str, Any]]:
    """The first topic every model has notes and a quiz for: one notes section and two quiz questions each."""
    for corpus, topics in outputs.items():
        for topic_key, by_model in topics.items():
            have_notes = [s for s in model_slugs if checks.NOTES in by_model.get(s, {})]
            have_quiz = [s for s in model_slugs if checks.QUIZ in by_model.get(s, {})]
            if (checks.NOTES in content_types and not have_notes) or (checks.QUIZ in content_types and not have_quiz):
                continue
            if len(have_notes) < len([s for s in model_slugs if by_model.get(s)]) and checks.NOTES in content_types:
                continue
            return {
                "corpus": corpus,
                "topic": topic_key,
                "models": {
                    slug: {
                        "notes_section": notes_section(by_model[slug][checks.NOTES]) if slug in have_notes else None,
                        "quiz_questions": quiz_samples(by_model[slug][checks.QUIZ]) if slug in have_quiz else None,
                    }
                    for slug in model_slugs
                    if by_model.get(slug)
                },
            }
    return None


def notes_section(markdown: str, preferred: str = "Key Concepts", limit: int = 1400) -> Dict[str, str]:
    """The text of one `##` section (the preferred one if present, else the second), cut at `limit`."""
    import re

    parts = re.split(r"(?m)^##[ \t]+", markdown)
    sections = parts[1:]
    chosen = next((s for s in sections if s.lower().startswith(preferred.lower())), None)
    if chosen is None:
        chosen = sections[1] if len(sections) > 1 else (sections[0] if sections else markdown)
    title, _, body = chosen.partition("\n")
    body = body.strip()
    if len(body) > limit:
        body = body[:limit].rsplit(" ", 1)[0] + " ..."
    return {"title": title.strip(), "text": body}


def quiz_samples(questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The first multiple-choice question and the first question of another type (or the first two)."""
    mc = next((q for q in questions if q.get("question_type") == "multiple_choice"), None)
    other = next((q for q in questions if q.get("question_type") != "multiple_choice"), None)
    picked = [q for q in (mc, other) if q is not None]
    for q in questions:
        if len(picked) >= 2:
            break
        if q not in picked:
            picked.append(q)
    return picked[:2]


def build_summary(run_dir: Path, run: Dict[str, Any], tracker_spend: Dict[str, float], judge_info: Dict[str, Any]) -> Dict[str, Any]:
    """Everything the report needs, from the files in `run_dir` and the run's spend."""
    records = load_raw(run_dir)
    excerpts = json.loads((run_dir / "excerpts.json").read_text()) if (run_dir / "excerpts.json").exists() else {}
    model_slugs = [m["slug"] for m in run["models"]]
    content_types = run["types"]
    outputs = outputs_by_model(records)
    check_results = run_checks(outputs, excerpts, model_slugs, run["params"], run.get("notes_sections"))
    judged = load_judged(run_dir / "judge")
    judge_summary = aggregate(judged, model_slugs) if judged else None

    models: Dict[str, Any] = {}
    for model in run["models"]:
        slug = model["slug"]
        mine = [r for r in records if r["model"]["slug"] == slug]
        models[slug] = {
            "label": model["label"],
            "model_id": model["model_id"],
            "cost": cost_and_latency(mine, content_types),
            "checks": check_results["summary"][slug],
            "failures": [
                {"corpus": r["corpus"], "topic": r["topic"]["name"], "type": r["type"], "error": r.get("error")}
                for r in mine
                if r["status"] != "ok"
            ],
        }
    return {
        "label": run["label"],
        "date": run["date"],
        "code": run.get("code", {}),
        "config": {k: run[k] for k in ("corpora", "types", "params", "models", "judge", "mock", "seed", "topics_source") if k in run},
        "topics": json.loads((run_dir / "topics.json").read_text()) if (run_dir / "topics.json").exists() else {},
        "spend": {**tracker_spend, "max_usd": run["max_usd"], "max_judge_usd": run["max_judge_usd"]},
        "stopped": run.get("stopped"),
        "models": models,
        "per_topic_checks": check_results["per_topic"],
        "judge": judge_summary,
        "judge_info": judge_info,
        "samples": pick_samples(outputs, model_slugs, content_types),
    }

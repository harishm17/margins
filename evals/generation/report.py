"""Markdown report for a generation eval run, from the summary built by analysis.build_summary."""
import re
from typing import Any, Dict, List, Optional

TYPE_LABELS = {"concepts": "Concepts", "warmup": "Warm-up", "notes": "Notes", "solved": "Worked examples", "interactive": "Practice problems", "quiz": "Quiz"}


def usd(value: Optional[float], digits: int = 3) -> str:
    return "n/a" if value is None else f"${value:.{digits}f}"


def pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def num(value: Optional[float], digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def secs(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value:.0f}s"


def gate_marker(ok: Optional[bool]) -> str:
    """PASS or FAIL after a gated value; nothing when there was nothing to check."""
    return "" if ok is None else (" PASS" if ok else " FAIL")


def fraction(part: Optional[int], whole: Optional[int]) -> str:
    return "n/a" if not whole else f"{part}/{whole}"


def table(header: List[str], rows: List[List[str]]) -> List[str]:
    return ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)] + ["| " + " | ".join(r) + " |" for r in rows]


def _models(summary: Dict[str, Any]) -> Dict[str, Any]:
    return summary["models"]


def render_markdown(summary: Dict[str, Any]) -> str:
    models = _models(summary)
    config = summary["config"]
    spend = summary["spend"]
    code = summary.get("code", {})
    types = config["types"]
    lines: List[str] = [f"# Generation eval: {summary['label']}", ""]
    commit = (code.get("commit") or "")[:10]
    dirty = " (app code modified)" if code.get("app_dirty") else ""
    topic_counts = ", ".join(
        f"{corpus} {len(info['selected'])}" for corpus, info in summary.get("topics", {}).items()
    )
    lines += [
        f"- Date: {summary['date']}. Code: `{commit}`{dirty}, branch `{code.get('branch', '')}`.",
        f"- Corpora and topics generated: {topic_counts or 'n/a'}. Topics came from: {config.get('topics_source', 'n/a')}.",
        f"- Models: {', '.join(m['label'] for m in config['models'])}. Content types: {', '.join(types)}."
        + (" **Mock provider: no model was called, costs and scores are placeholders.**" if config.get("mock") else ""),
        f"- Requested per topic: {config['params']['examples']} examples of each kind, {config['params']['questions']} quiz questions, "
        f"{config['params']['difficulty']} difficulty, {config['params']['detail_level']} notes.",
        f"- Judge: {config['judge'] or 'off'}.",
        f"- Spend: ${spend.get('generation', 0):.2f} generation, ${spend.get('topics', 0):.2f} topic extraction, "
        f"${spend.get('judge', 0):.2f} judge; total ${sum(spend.get(k, 0) for k in ('generation', 'topics', 'judge')):.2f} "
        f"(caps: ${spend['max_usd']:.2f} total, ${spend['max_judge_usd']:.2f} judge).",
    ]
    stopped = summary.get("stopped")
    if stopped:
        lines += ["", f"**Stopped early:** {stopped}"]
    lines += [""]

    # ---------------------------------------------------------------- cost
    lines += ["## Cost and latency", "", "Cost uses the app's own price table (`usage.py`) on the token counts the API reported. "
              "A topic's cost is the sum of the mean cost of each content type, so the 12-topic projection is for one set of all "
              f"the types generated here, times 12. Latency is wall time of the app's generator call.", ""]
    header = ["Model", "Per topic", "Projected, 12 topics", *[TYPE_LABELS.get(t, t) for t in types], "Seconds per topic", "Total spent"]
    rows = []
    for slug, m in models.items():
        c = m["cost"]
        per_type = [
            f"{usd(c['per_type'][t]['mean_cost_usd'])} ({secs(c['per_type'][t]['mean_seconds'])})" if t in c["per_type"] else "n/a"
            for t in types
        ]
        rows.append([m["label"], usd(c["mean_cost_per_topic_usd"]), usd(c["projected_cost_12_topics_usd"], 2), *per_type,
                     secs(c["mean_seconds_per_topic"]), usd(c["total_cost_usd"])])
    lines += table(header, rows)
    lines += ["", "Per-type cells are mean cost per generation and, in brackets, mean seconds.", ""]
    token_rows = []
    for slug, m in models.items():
        c = m["cost"]
        token_rows.append([m["label"], str(c["calls"]), f"{c['input_tokens']:,}", f"{c['output_tokens']:,}",
                           f"{c['cache_creation_input_tokens']:,}", f"{c['cache_read_input_tokens']:,}"])
    lines += table(["Model", "Calls", "Input tokens", "Output tokens", "Cache write tokens", "Cache read tokens"], token_rows)
    lines += [""]

    failed: Dict[Any, List[str]] = {}
    for m in models.values():
        for f in m["failures"]:
            message = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<id>", str(f["error"]))
            failed.setdefault((m["label"], f["type"], message[:300]), []).append(f"{f['corpus']}/{f['topic']}")
    if failed:
        lines += ["### Failed generations", "", "A failed generation is a result: it is not scored, and its cost is in the total.", ""]
        for (label, content_type, message), where in failed.items():
            lines.append(f"- {label}, {content_type}, {len(where)} topic(s) ({'; '.join(where[:4])}{'; ...' if len(where) > 4 else ''}): {message}")
        lines += [""]

    # ---------------------------------------------------------------- checks
    lines += ["## Automatic checks", "",
              "No model is involved. These are lexical heuristics: they find things worth reading, they do not prove content right or wrong "
              "(see the README for what each can miss). Counts are over every topic generated.", ""]
    rows_spec = [
        ("Plain-text fields with `$` or backslash sequences", lambda s: str(s["plain_text_latex_fields"])),
        ("Fields with unbalanced `$`", lambda s: str(s["unbalanced_dollar_fields"])),
        ("Fields with bare currency", lambda s: str(s["bare_currency_fields"])),
        ("MC explanations naming an option letter (any / strict `Option C`, `(B)`)",
         lambda s: f"{s['mc_letter_refs']} / {s['mc_letter_refs_strict']} of {s['mc_questions']}"),
        ("Quiz recall-copy rate (questions whose numbers all come from this model's notes or examples)",
         lambda s: f"{pct(s['quiz_recall_copy_rate'])} ({s['quiz_recall_copied']} of {s['quiz_numeric_questions']})"),
        ("Concept claim quotes found in their chunk (gate: 98% or more)",
         lambda s: f"{pct(s['claim_quote_rate'])} ({s['claims_matched']} of {s['claims_total']})"
         + gate_marker(s["claim_quote_gate_ok"])),
        ("Topics with 3-8 concepts", lambda s: f"{fraction(s['concept_count_ok'], s['concept_topics'])} (mean {num(s['concept_count_mean'], 1)})"),
        ("Topics where every objective has a concept", lambda s: fraction(s["objectives_mapped_ok"], s["concept_topics"])),
        ("Topics with an acyclic prerequisite graph", lambda s: fraction(s["prereq_acyclic_ok"], s["concept_topics"])),
        ("Items whose concept tags are all valid (gate: 100%)",
         lambda s: f"{pct(s['item_concept_id_rate'])} ({s['items_tagged_valid']} of {s['items_tagged']})"
         + gate_marker(s["item_tag_gate_ok"])),
        ("Warm-up questions the topic quiz repeats (gate: 0)",
         lambda s: str(s["warmup_reused_items"]) + gate_marker(s["warmup_reuse_gate_ok"])
         if s["warmup_vs_quiz_topics"] else "n/a (needs warm-up and quiz)"),
        ("Notes with all expected sections", lambda s: fraction(s["notes_sections_ok"], s["notes_count"])),
        ("Notes inside the requested word band", lambda s: f"{fraction(s['notes_in_word_band'], s['notes_count'])} (mean {num(s['notes_words_mean'], 0)} words)"),
        ("Notes with 5-8 recap bullets", lambda s: fraction(s["notes_recap_bullets_ok"], s["notes_count"])),
        ("Worked-example sets with the requested count", lambda s: fraction(s["solved_count_ok"], s["solved_count"])),
        ("Practice sets with the requested count", lambda s: fraction(s["interactive_count_ok"], s["interactive_count"])),
        ("Quizzes with the requested question count", lambda s: fraction(s["quiz_count_ok"], s["quiz_count"])),
        ("Grounding proxy (share of notes sentences sharing vocabulary with the excerpts)", lambda s: pct(s["grounding_share_mean"])),
        ("Near-duplicate example statements across topics (Jaccard > 0.6)", lambda s: str(s["duplicate_example_pairs"])),
    ]
    rows = []
    for label, fn in rows_spec:
        rows.append([label] + [fn(m["checks"]) if m["checks"] else "n/a" for m in models.values()])
    lines += table(["Check"] + [m["label"] for m in models.values()], rows)
    lines += [""]
    dup_lines = []
    for m in models.values():
        for pair in (m["checks"] or {}).get("duplicate_example_details", []):
            dup_lines.append(f"- {m['label']}: {pair['topic_a']} #{pair['index_a']} and {pair['topic_b']} #{pair['index_b']} (Jaccard {pair['jaccard']})")
    if dup_lines:
        lines += ["Near-duplicate pairs:", ""] + dup_lines + [""]

    # ---------------------------------------------------------------- judge
    judge = summary.get("judge")
    lines += ["## Judge", ""]
    if not judge:
        lines += ["The judge was not run.", ""]
    else:
        info = summary.get("judge_info") or {}
        lines += [
            f"Judged {judge['pairs_judged']} (topic, type) pairs with {config['judge']}. Each call saw the excerpts and every model's output "
            "as anonymous, shuffled candidates, and scored each 1-5. Means are over all judged items.",
        ]
        if info.get("skipped_for_spend"):
            lines += ["", f"**{len(info['skipped_for_spend'])} pairs were not judged because the judge spend cap was reached.**"]
        if info.get("failed"):
            lines += ["", f"{len(info['failed'])} judge calls failed: {', '.join(info['failed'])}."]
        lines += [""]
        dims = [("correctness", "Correctness"), ("grounding", "Grounding"), ("teaching", "Teaching"), ("question_quality", "Question quality (quiz)")]
        rows = []
        for slug, m in judge["models"].items():
            means = m["means"].get("all", {})
            rows.append([models[slug]["label"], *[num(means.get(d)) for d, _ in dims], str(m["mathematical_errors"]), str(len(m["errors"]))])
        lines += table(["Model", *[label for _, label in dims], "Mathematical errors", "All errors"], rows)
        lines += ["", "By content type (correctness / teaching, plus question quality for quizzes):", ""]
        type_rows = []
        for slug, m in judge["models"].items():
            row = [models[slug]["label"]]
            for t in types:
                block = m["means"].get(t)
                if not block:
                    row.append("n/a")
                    continue
                cell = f"{num(block.get('correctness'))} / {num(block.get('teaching'))}"
                if t == "quiz":
                    cell += f" / {num(block.get('question_quality'))}"
                if m["mathematical_errors_by_type"].get(t):
                    cell += f" ({m['mathematical_errors_by_type'][t]} math err)"
                row.append(cell)
            type_rows.append(row)
        lines += table(["Model", *[TYPE_LABELS.get(t, t) for t in types]], type_rows)
        lines += [""]
        lines += ["### Errors the judge listed", "",
                  "Every error the judge reported, by model. The judge can be wrong; check an error before relying on it.", ""]
        for slug, m in judge["models"].items():
            lines.append(f"**{models[slug]['label']}** ({len(m['errors'])} errors, {m['mathematical_errors']} mathematical)")
            lines.append("")
            if not m["errors"]:
                lines += ["None listed.", ""]
                continue
            for e in m["errors"]:
                lines.append(f"- [{e['corpus']} / {e['topic']} / {e['type']}] {e['kind']}, {e['where']}: {e['description']}")
            lines.append("")

    # ---------------------------------------------------------------- samples
    samples = summary.get("samples")
    lines += ["## Side by side", ""]
    if not samples:
        lines += ["No topic had output from every model."]
    else:
        lines += [f"Topic `{samples['corpus']}/{samples['topic']}`. One notes section and two quiz questions per model, as stored (multiple-choice options already shuffled by the app).", ""]
        for slug, sample in samples["models"].items():
            lines += [f"### {models[slug]['label']}", ""]
            notes = sample.get("notes_section")
            if notes:
                lines += [f"Notes, section \"{notes['title']}\":", "", *[f"> {line}" if line.strip() else ">" for line in notes["text"].splitlines()], ""]
            for q in sample.get("quiz_questions") or []:
                lines += [f"Quiz, {q.get('question_type')}:", "", f"> {q.get('question_text')}"]
                for option in q.get("options") or []:
                    lines.append(f">   {option.get('id')}. {option.get('text')}")
                if q.get("question_type") == "short_answer":
                    lines.append(f"> Sample answer: {q.get('sample_answer')}")
                else:
                    lines.append(f"> Key: {q.get('correct_answer')}")
                lines += [f"> Explanation: {q.get('explanation')}", ""]
    lines += [""]
    return "\n".join(lines)

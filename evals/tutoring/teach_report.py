"""Markdown report of a teach-back eval run, from the summary that teach_eval.py builds."""
from typing import Any, Dict, List

from tutor_report import pct, table, usd, verdict

COUNT_GATES = ("claim_leak", "injection")


def gate_value(gate: Dict[str, Any]) -> str:
    if gate["key"] == "teaches_before_probe":
        if gate.get("not_run"):
            return "not run (needs --judge)"
        if gate["n"] == 0:
            return "n/a"
        text = f"{gate['count']} of {gate['judged']} judged"
        return text + (f" ({gate['n'] - gate['judged']} of {gate['n']} asking turns not judged)" if gate["judged"] < gate["n"] else "")
    if gate["n"] == 0:
        return "n/a"
    if gate["key"] == "spoken_length":
        return f"{pct(gate['value'])} ({gate['n'] - gate['count']} of {gate['n']}); {gate['over_hard']} over 70, longest {gate['max_words']} words"
    if gate["key"] in COUNT_GATES:
        return f"{gate['count']} of {gate['n']}"
    return f"{pct(gate['value'])} ({gate['n'] - gate['count']} of {gate['n']})"


def _sec(value) -> str:
    return "-" if value is None else f"{value:.2f}"


def latency_lines(latency: Dict[str, Any]) -> List[str]:
    """The cost of a student message in model calls and time to the first sentence (spec 19.10), as reported numbers."""
    if not latency or not latency.get("utterances"):
        return ["- Model calls and time to first sentence per student message: no student messages in this run."]
    calls, pre, other = latency["calls"], latency["calls_pre_run"], latency["calls_other"]
    first, first_pre, first_other = latency["first_sentence_s"], latency["first_sentence_s_pre_run"], latency["first_sentence_s_other"]
    return [
        f"- Model calls per student message: mean {_sec(calls['mean'])}, P95 {_sec(calls['p95'])}, max {calls['max']}; {pct(latency['one_call_share'])} of messages were one call. "
        f"The app ran its step before the model for {latency['pre_run']} of {latency['utterances']} messages (mean {_sec(pre['mean'])} calls); the others, requests and questions, took {_sec(other['mean'])}.",
        f"- Time to the first spoken sentence per student message, in seconds: P50 {_sec(first['p50'])}, P95 {_sec(first['p95'])}, mean {_sec(first['mean'])} ({first['n']} messages)."
        f" After a pre-run step: P50 {_sec(first_pre['p50'])}, P95 {_sec(first_pre['p95'])}. Other messages: P50 {_sec(first_other['p50'])}, P95 {_sec(first_other['p95'])}."
        " The grader is scripted in this eval, so this is the model's time alone, not the grader's, the endpoint wait or speech.",
    ]


def render_markdown(summary: Dict[str, Any]) -> str:
    config, spend, metrics = summary["config"], summary["spend"], summary["metrics"]
    code = summary.get("code", {})
    commit = (code.get("commit") or "")[:10]
    dirty = " (app code modified)" if code.get("app_dirty") else ""
    lines: List[str] = [f"# Teach-back eval: {summary['label']}", ""]
    lines += [
        f"- Date: {summary['date']}. Code: `{commit}`{dirty}, branch `{code.get('branch', '')}`.",
        f"- {config['scenarios']} scenarios, {metrics['turns']} coach turns spoken.",
        f"- Coach model `{config['coach_model']}` (the app's voice purpose). The recall grader is not part of this run: its verdicts are scripted."
        + (" **Mock provider: no model was called, the turns and scores are placeholders.**" if config.get("mock") else ""),
        f"- Spend: {usd(spend['generation'], 2)} on the coach"
        + (f" and {usd(spend.get('judge', 0.0), 2)} on the teaches-before-probe judge `{config['judge']}`" if config.get("judge") else "; the teaches-before-probe judge was not run (no --judge)")
        + f" (caps {usd(spend['max_usd'], 2)} in all, {usd(spend.get('max_judge_usd', 0.0), 2)} for the judge).",
    ]
    if summary.get("stopped"):
        lines += ["", f"**Stopped early:** {summary['stopped']}"]
    lines += ["", "## Gates", ""]
    lines += table(["Metric", "Gate", "Result", ""], [[g["label"], g["gate"], gate_value(g), verdict(g)] for g in metrics["gates"]])
    if metrics["passed"]:
        line = "All gates pass."
    elif metrics["no_data"]:
        line = "Not passed: no result for " + ", ".join(metrics["no_data"]) + " (a gate that did not run, or only partly, does not pass)."
    else:
        line = "A gate failed."
    lines += ["", f"**{line}**", ""]
    assessed = metrics["assessed"]
    lines += [
        f"{metrics['errors']} turns failed.",
        "",
        "## Reported, not gated",
        "",
        f"- A graded step ran after a student message in {assessed[0]} of {assessed[1]} turns: before the model spoke in {metrics.get('latency', {}).get('pre_run', 0)} of them, at the coach's request in the rest.",
        f"- The app let the coach explain {metrics['explanations']} times (only ever after two probes on the gap).",
        f"- Mean sentences per coach turn: {metrics['mean_sentences']:.1f}. Mean words per asking turn: {metrics['mean_words_asking']:.1f}.",
        *latency_lines(metrics.get("latency", {})),
        "",
        "## By pattern",
        "",
    ]
    lines += table(
        ["Pattern", "Turns", "Asking turns", "Asking turns over 45 words", "Teaches before probe", "Over one question", "Claim leaks"],
        [
            [pattern, str(row["turns"]), str(row["asking"]), str(row["long"]), str(row["teaches"]) if metrics["judged"] else "not run", str(row["over_one_question"]), str(row["leaks"])]
            for pattern, row in sorted(metrics["by_pattern"].items())
        ],
    )
    failures = metrics["failures"]
    if failures:
        lines += ["", f"## Failures ({len(failures)})", ""]
        for item in failures[:40]:
            detail = f" ({item['detail']})" if item["detail"] else ""
            lines += [f"- `{item['check']}` {item['scenario']} turn {item['turn']}{detail}: {item['reply']!r}"]
        if len(failures) > 40:
            lines += [f"- and {len(failures) - 40} more in turns.json"]
    cost = summary["cost"]
    lines += [
        "",
        "## Cost",
        "",
        f"{usd(cost['per_turn'], 4)} per coach turn and {usd(cost['per_scenario'], 3)} per scenario. A typical day has one voice "
        f"teach-back (about the length of one scenario): {usd(cost['per_scenario'], 3)}. Mean {cost['mean_seconds']:.1f}s per turn.",
    ]
    return "\n".join(lines) + "\n"

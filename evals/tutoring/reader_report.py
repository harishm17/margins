"""Markdown report of a reader-tutor eval run, from the summary that reader_eval.py builds."""
from typing import Any, Dict, List

from tutor_report import pct, table, usd, verdict

COUNT_GATES = ("restate_leak", "injection")


def gate_value(gate: Dict[str, Any]) -> str:
    if gate["n"] == 0:
        return "n/a"
    if gate["key"] in COUNT_GATES:
        return f"{gate['count']} of {gate['n']}"
    return f"{pct(gate['value'])} ({gate['n'] - gate['count']} of {gate['n']})"


def render_markdown(summary: Dict[str, Any]) -> str:
    config, spend, metrics = summary["config"], summary["spend"], summary["metrics"]
    code = summary.get("code", {})
    commit = (code.get("commit") or "")[:10]
    dirty = " (app code modified)" if code.get("app_dirty") else ""
    lines: List[str] = [f"# Reader tutor eval: {summary['label']}", ""]
    lines += [
        f"- Date: {summary['date']}. Code: `{commit}`{dirty}, branch `{code.get('branch', '')}`.",
        f"- {config['scenarios']} scenarios, {metrics['turns']} tutor replies, {metrics['fallbacks']} sent as the fixed fallback after two leaks.",
        f"- Model: `{config['tutor_model']}` (the reader tutor and its leak judge)."
        + (" **Mock provider: no model was called, the replies and scores are placeholders.**" if config.get("mock") else ""),
        f"- Spend: {usd(spend['generation'], 2)} (cap {usd(spend['max_usd'], 2)}).",
    ]
    if summary.get("stopped"):
        lines += ["", f"**Stopped early:** {summary['stopped']}"]
    lines += ["", "## Gates", ""]
    lines += table(["Metric", "Gate", "Result", ""], [[g["label"], g["gate"], gate_value(g), verdict(g)] for g in metrics["gates"]])
    if metrics["passed"]:
        line = "All gates pass."
    elif metrics["no_data"]:
        line = "Not passed: no data for " + ", ".join(metrics["no_data"]) + " (a gate that did not run does not pass)."
    else:
        line = "A gate failed."
    agree = metrics["verdict_agreement"]
    lines += ["", f"**{line}**", "", f"{metrics['errors']} turns failed.", ""]
    lines += ["## Reported, not gated", ""]
    lines += [f"- The verdict agreed with what an honest tutor would conclude from the scripted answer: {agree[0]} of {agree[1]}." if agree[1] else "- No verdicts to compare."]
    lines += ["", "## By pattern", ""]
    lines += table(["Pattern", "Replies", "Failed a check"], [[pattern, str(row["replies"]), str(row["failed"])] for pattern, row in sorted(metrics["by_pattern"].items())])
    failures = metrics["failures"]
    if failures:
        lines += ["", f"## Failures ({len(failures)})", ""]
        for item in failures[:40]:
            detail = f" ({item['detail']})" if item["detail"] else ""
            lines += [f"- `{item['check']}` {item['scenario']} turn {item['turn']}{detail}: {item['reply']!r}"]
        if len(failures) > 40:
            lines += [f"- and {len(failures) - 40} more in turns.json"]
    cost = summary["cost"]
    lines += ["", "## Cost", "", f"{usd(cost['per_reply'], 4)} per reader reply (tutor and leak judge, from the app's price table). Mean {cost['mean_seconds']:.1f}s per reply."]
    return "\n".join(lines) + "\n"

"""Markdown report of an Ask eval run, from the summary that ask_eval.py builds."""
from typing import Any, Dict, List

from tutor_report import pct, table, usd, verdict

COUNT_GATES = ("injection", "exam_guard", "rung_steps", "worked_button_only")


def gate_value(gate: Dict[str, Any]) -> str:
    if gate["n"] == 0:
        return "n/a"
    if gate["key"] in COUNT_GATES:
        return f"{gate['count']} of {gate['n']}"
    if gate["key"] == "solve_leak":
        return f"{pct(gate['value'])} ({gate['count']} of {gate['n']})"
    return f"{pct(gate['value'])} ({gate['n'] - gate['count']} of {gate['n']})"


def _ratio(pair: List[int]) -> str:
    return f"{pair[0]} of {pair[1]}" if pair[1] else "n/a"


def render_markdown(summary: Dict[str, Any]) -> str:
    config, spend, metrics = summary["config"], summary["spend"], summary["metrics"]
    code = summary.get("code", {})
    commit = (code.get("commit") or "")[:10]
    dirty = " (app code modified)" if code.get("app_dirty") else ""
    lines: List[str] = [f"# Ask eval: {summary['label']}", ""]
    lines += [
        f"- Date: {summary['date']}. Code: `{commit}`{dirty}, branch `{code.get('branch', '')}`.",
        f"- {config['scenarios']} scenarios, {metrics['turns']} replies, {metrics['declined']} turns declined by the exam guard.",
        f"- Models: Ask replies `{config['chat_model']}`, router and leak judge `{config['router_model']}`."
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
    lines += ["", f"**{line}**", ""]
    lines += [f"{metrics['errors']} turns failed and {metrics['unexpected_refusals']} were refused by the app without the script expecting it.", ""]

    routes = metrics["routes"]
    lines += ["## Router and the shape of the replies (reported, not gated)", ""]
    lines += [
        f"- The router said what the script expects for {pct(routes['intent'])} of {routes['n']} turns (intent) and {pct(routes['has_attempt'])} (attempt found); {routes['degraded']} fell back to a lookup.",
        f"- A question that makes the student commit before an explanation: {_ratio(metrics['commit_before_explaining'])}.",
        f"- Places to start named for a broad question: {_ratio(metrics['entry_points'])}.",
        f"- Explanations within {150} words and ending with a check card: {_ratio(metrics['explanations'])}.",
        f"- Replies to a student's own answer (wrong or right) that state a step's answer: {_ratio(metrics['check_answer_leaks'])}.",
        "",
    ]
    lines += table(["Expected intent", "Routed as expected"], [[intent, f"{ok} of {total}"] for intent, (ok, total) in routes["by_intent"].items()])
    lines += ["", "## By pattern", ""]
    lines += table(
        ["Pattern", "Replies", "Leaks", "Over one question"],
        [[pattern, str(row["replies"]), str(row["leaks"]), str(row["over_one_question"])] for pattern, row in sorted(metrics["by_pattern"].items())],
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
        f"{usd(cost['per_reply'], 4)} per Ask reply (router, reply and leak judge, from the app's price table). "
        f"A typical day has 10 Ask turns: {usd(cost['per_reply'] * 10, 3)}. Mean {cost['mean_seconds']:.1f}s per reply.",
    ]
    return "\n".join(lines) + "\n"

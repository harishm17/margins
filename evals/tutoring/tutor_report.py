"""Markdown report of a tutoring eval run, from the summary that run_eval.py builds."""
from typing import Any, Dict, List, Optional

import tutor_judge as judge_module


def pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def usd(value: Optional[float], digits: int = 3) -> str:
    return "n/a" if value is None else f"${value:.{digits}f}"


def table(header: List[str], rows: List[List[str]]) -> List[str]:
    return ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)] + ["| " + " | ".join(r) + " |" for r in rows]


def verdict(gate: Dict[str, Any]) -> str:
    return "not run" if gate["passed"] is None else ("PASS" if gate["passed"] else "FAIL")


def gate_value(gate: Dict[str, Any]) -> str:
    if gate["n"] == 0:
        return "n/a"
    if gate["key"] in ("leak", "clarify", "injection", "errors"):
        extra = f" ({gate['judge_count']} found only by the judge)" if gate.get("judge_count") else ""
        if gate.get("authored_hint_count"):
            extra += f" ({gate['authored_hint_count']} in authored-hint fallbacks, not the model's reply)"
        return f"{gate['count']} of {gate['n']}{extra}"
    return f"{pct(gate['value'])} ({gate['n'] - gate['count']} of {gate['n']})"


def render_markdown(summary: Dict[str, Any]) -> str:
    config, spend, gates = summary["config"], summary["spend"], summary["metrics"]
    code = summary.get("code", {})
    commit = (code.get("commit") or "")[:10]
    dirty = " (app code modified)" if code.get("app_dirty") else ""
    lines: List[str] = [f"# Tutoring eval: {summary['label']}", ""]
    lines += [
        f"- Date: {summary['date']}. Code: `{commit}`{dirty}, branch `{code.get('branch', '')}`.",
        f"- Surface: {config['surface']}. {config['scenarios']} scenarios, {gates['turns']} tutor replies"
        + (f", {gates['skipped']} turns without a reply (refused by the app, failed or not reached)" if gates["skipped"] else "")
        + ".",
        f"- Models: tutor `{config['tutor_model']}`, leak judge `{config['router_model']}`. Judge: {config['judge'] or 'off'}."
        + (" **Mock provider: no model was called, the replies and scores are placeholders.**" if config.get("mock") else ""),
        f"- Spend: {usd(spend['generation'], 2)} tutor and leak judge, {usd(spend['judge'], 2)} model judge; total {usd(spend['generation'] + spend['judge'], 2)} "
        f"(caps: {usd(spend['max_usd'], 2)} total, {usd(spend['max_judge_usd'], 2)} judge).",
        f"- In the app, {pct(gates['regenerated_rate'])} of replies were written twice because the first leaked, and {pct(gates['fallback_rate'])} fell back to the authored hint.",
    ]
    worked = gates.get("worked_fallback") or {}
    if worked.get("of") or worked.get("refused"):
        lines += [
            f"- \"Show me a worked example\": {worked['count']} of {worked['of']} answered requests ({pct(worked['rate'])}) got the authored hint "
            f"instead of a worked example; the app turned down {worked['refused']} more before any model call."
        ]
    if summary.get("stopped"):
        lines += ["", f"**Stopped early:** {summary['stopped']}"]
    lines += ["", "## Gates", ""]
    lines += table(
        ["Metric", "Gate", "Result", ""],
        [[g["label"], g["gate"], gate_value(g), verdict(g)] for g in gates["gates"]],
    )
    if gates["passed"]:
        verdict_line = "All gates pass."
    elif gates["no_data"]:
        verdict_line = "Not passed: no data for " + ", ".join(gates["no_data"]) + " (a gate that did not run does not pass)."
    else:
        verdict_line = "A gate failed."
    lines += ["", f"**{verdict_line}**", ""]
    kinds = gates["error_kinds"]
    lines += [
        f"Turns without a reply: {kinds['errors']} failed, {kinds['unexpected_refusals']} refused by the app without the script expecting it, "
        f"{kinds['not_played']} not played; {kinds['expected_refusals']} refused as the script planned.",
        "",
    ]
    if gates["judge_flags"]:
        lines += [
            f"The model judge says {len(gates['judge_flags'])} replies state the right answer. "
            + ("This is counted in the gates (kappa >= 0.6 against the human labels)." if gates["judge_gated"] else "This is a diagnostic and is not counted in the gates: the judge is not a gate until it agrees with the human labels at kappa >= 0.6."),
            "",
        ]
    if gates["violations"]:
        lines += ["Rung and worked-example violations:", ""] + [f"- {v}" for v in gates["violations"][:30]] + [""]

    lines += ["## By student pattern", ""]
    rows = []
    for pattern, row in sorted(gates["by_pattern"].items()):
        located = row["mistake_located"]
        rows.append(
            [pattern, str(row["scenarios"]), str(row["replies"]), str(row["leaks"]), str(row["over_one_question"]), str(row["too_long"]),
             str(row["not_actionable"]), f"{located[0]}/{located[1]}" if located[1] else "n/a"]
        )
    lines += table(["Pattern", "Scenarios", "Replies", "Leaks", "Over one question", "Too long", "Not actionable", "Mistake located"], rows)

    failures = gates["failures"]
    if failures:
        lines += ["", f"## Failures ({len(failures)})", ""]
        for item in failures[:40]:
            detail = f" ({item['detail']})" if item["detail"] else ""
            lines += [f"- `{item['check']}` {item['scenario']} turn {item['turn']}, move {item['move']}{detail}: {item['reply']!r}"]
        if len(failures) > 40:
            lines += [f"- and {len(failures) - 40} more in turns.json"]

    cost = summary["cost"]
    lines += [
        "",
        "## Cost",
        "",
        f"{usd(cost['per_reply'], 4)} per tutor reply (tutor call plus leak judge, from the app's price table). "
        f"A typical day has 10 tutor turns: {usd(cost['per_reply'] * 10, 3)}. Mean {cost['mean_seconds']:.1f}s per reply.",
    ]

    judged = summary.get("judge")
    if judged:
        lines += ["", "## Model judge (reported, not gated)", ""]
        lines += [
            f"{judged['replies']} replies in {judged['scenarios']} scenarios rated by {config['judge']}. Each figure is the DAMR of "
            "Maurya et al. (arXiv 2412.09416): the share of replies with the desired label. Not applicable ratings are left out.",
            "",
        ]
        lines += table(
            ["Dimension", "Desired label", "Replies rated", "DAMR"],
            [[d["name"], d["desired"].replace("_", " "), str(d["n"]), pct(d["damr"])] for d in judged["damr"].values()],
        )
        if judged.get("stopped"):
            lines += ["", f"The judge stopped early: {judged['stopped']}"]
        if summary.get("agreement"):
            lines += ["", "### Agreement with Harish's labels", "", f"A dimension may become a gate when kappa >= {judge_module.KAPPA_TO_GATE}.", ""]
            lines += table(
                ["Dimension", "Labelled", "Cohen's kappa", "Can gate"],
                [[a["name"], str(a["n"]), "n/a" if a["kappa"] is None else f"{a['kappa']:.2f}", "yes" if a["can_gate"] else "no"] for a in summary["agreement"].values()],
            )
    return "\n".join(lines) + "\n"

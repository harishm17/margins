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


def assembled_lines(assembled) -> List[str]:
    """--grader-led: the turns the app answered itself, and the gates over those turns alone."""
    if not assembled:
        return []
    lines = [
        f"- The app built the reply itself, with no coach call, in {assembled['turns']} of {assembled['graded_turns']} graded turns "
        "(a probe or a new example the app has no question it can say for went to the coach model). Over those turns alone:"
    ]
    lines += [f"  - {verdict(gate)}: {gate['label']}: {gate_value(gate)}" for gate in assembled["gates"]]
    probes = assembled.get("probes")
    if probes and probes["planned"]:
        lines.append(f"- Probes: the app worded {probes['by_app']} of the {probes['planned']} the steps planned.")
        lines += [f"  - by the app, {source}: {count}" for source, count in sorted(probes["from"].items(), key=lambda kv: -kv[1])]
        lines += [f"  - by the coach model, {why}: {count}" for why, count in sorted(probes["why"].items(), key=lambda kv: -kv[1])]
    examples = (probes or {}).get("examples")
    if examples and examples["planned"]:
        lines.append(f"- New examples: the app worded {examples['by_app']} of the {examples['planned']} the steps planned, from the grader's case.")
        lines += [f"  - by the coach model, {why}: {count}" for why, count in sorted(examples["why"].items(), key=lambda kv: -kv[1])]
    questions = assembled.get("questions")
    if questions:
        lines.append(
            f"- The questions came from the app's grader ({questions['model']}, --live-questions): {questions['calls']} calls, "
            f"{questions['errors']} failed, mean {_sec(questions['mean_seconds'])} s, ${questions['cost_usd']:.2f}. The verdicts are the script's."
        )
    return lines


def yes_no_lines(yes_no) -> List[str]:
    if not yes_no or not yes_no[1]:
        return []
    return [
        f"- Probes the student could answer with yes or no: {yes_no[0]} of {yes_no[1]}. Read by wording alone; such a question is a fault "
        "only when it carries the answer, which the teaches-before-probe judge decides."
    ]


def grader_lines(grader) -> List[str]:
    """--grader: the app's recall grader on the scripted answers, against the verdicts the script gives the coach."""
    if not grader:
        return []
    lines = [
        f"- The app's recall grader (`{grader['model']}`, {usd(grader['cost_usd'], 2)}) graded {grader['graded']} of {grader['turns']} scripted answers"
        f" ({grader['abstained']} it asked to clarify, {grader['errors']} failed, {grader['not_run']} not run) and gave the script's verdict for "
        f"{grader['agree']} of {grader['claims']} claims ({pct(grader['agreement'])}). Where it differs, the coach in the app would have been told something else than here:"
    ]
    for item in grader["differences"][:20]:
        lines.append(f"  - {item['key']} ({item['kind']}): script `{item['scripted']}`, grader `{item['grader']}` for the claim {item['claim']!r}; the student said {item['answer']!r}")
    if len(grader["differences"]) > 20:
        lines.append(f"  - and {len(grader['differences']) - 20} more in summary.json")
    return lines


def render_markdown(summary: Dict[str, Any]) -> str:
    config, spend, metrics = summary["config"], summary["spend"], summary["metrics"]
    code = summary.get("code", {})
    commit = (code.get("commit") or "")[:10]
    dirty = " (app code modified)" if code.get("app_dirty") else ""
    lines: List[str] = [f"# Teach-back eval: {summary['label']}", ""]
    # The grader's calls are counted with the coach's (one cap, --max-usd): say how much of the sum is the grader's.
    graders = [g["cost_usd"] for g in (metrics.get("grader"), (metrics.get("assembled") or {}).get("questions")) if g]
    graders_share = sum(graders) if graders else None
    lines += [
        f"- Date: {summary['date']}. Code: `{commit}`{dirty}, branch `{code.get('branch', '')}`.",
        f"- {config['scenarios']} scenarios ({metrics.get('ideas', config['scenarios'])} ideas), {metrics['turns']} coach turns spoken.",
        f"- Coach model `{config['coach_model']}` (the app's voice purpose). The coach is told the scripted verdicts, not the recall grader's"
        + (
            "; the grader was run beside the script (below)."
            if metrics.get("grader")
            else "; the app's grader wrote the questions the app says (--live-questions, below)."
            if graders_share is not None
            else " (the grader is not part of this run; --grader runs it beside the script)."
        )
        + (" **Mock provider: no model was called, the turns and scores are placeholders.**" if config.get("mock") else ""),
        f"- Spend: {usd(spend['generation'], 2)} on the coach"
        + (f" and the app's grader ({usd(graders_share, 2)} of it the grader's)" if graders_share is not None else "")
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
        *yes_no_lines(metrics.get("yes_no_probes")),
        *grader_lines(metrics.get("grader")),
        *assembled_lines(metrics.get("assembled")),
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

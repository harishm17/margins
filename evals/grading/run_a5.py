"""A5: the grading eval.

    cd ai-service
    uv run python -I ../evals/grading/run_a5.py --label a5

Grades about 120 hand-labelled student answers to 24 short-answer items with the app's own short-answer grader
(`ExamGrader._grade_short_answer`, which quizzes and exams both use), once per arm:
  - haiku: today's choice for grade_short_answer (MODEL_GRADING, the fast tier: Haiku at low effort);
  - sonnet: Sonnet at low effort.
Each answer has a label: full (worth at least 70% of the points, the app's pass mark), partial, or none (under 25%). It
also has a category: right, right in other words, partly right, wrong, and one trap per question: a right number for the
wrong quantity or in the wrong unit (right_number_wrong_quantity) or the right keywords in a wrong statement
(keyword_wrong). Per arm the report gives the agreement of the grader's band with the label (also without the answers
marked borderline), agreement on pass or fail, the share of wrong answers marked right (not labelled full, graded at 70%
or more) and of right answers marked wrong, and each category's scores. Both kinds of wrong mark are gated (GATES;
RECALL_GATES for --recall) and a failed gate makes the exit code 1. `pick_model` applies the rule fixed before the
run for MODEL_GRADING (M3).

The questions are items the A2 run generated from the CC BY-NC-SA corpora, and the answers are written against them, so
the labelled answers stay in evals/.cache/grading, the run's copy of the questions and every grade stay in the run's
raw/ folder (K21), and run.json, summary.json and the report hold counts only. Calls go through the Message Batches API
at half price, both arms in one batch. --dry-run builds the dataset and prints the estimate; --mock uses the app's mock
provider; --max-usd caps the run.

--recall grades a second local dataset instead (evals/.cache/grading/recall.json: about 40 hand-labelled recall answers
to nine recall prompts, claims from the same corpora) with the app's recall grader (`grade_recall`, so its quote checks and
abstaining apply), once, on the app's own model for recall_grading. The app picks the v1 or v2 prompt and schema from
PROMPTS_V2 ("tutor"), so run it twice, with PROMPTS_V2= and PROMPTS_V2=tutor, under different --label values. The report gives
per-claim verdict agreement, the label against verdict table, the share of ungradable answers flagged, and cost.
"""
import argparse
import asyncio
import contextlib
import datetime
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# The app settings have no default ENVIRONMENT (SEC-L2); offline eval tooling runs as development.
os.environ.setdefault("ENVIRONMENT", "development")

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
REPO_ROOT = EVALS_DIR.parent
AI_SERVICE_DIR = REPO_ROOT / "ai-service"
RESULTS_DIR = EVALS_DIR / "results"
DEFAULT_DATASET = EVALS_DIR / ".cache" / "grading" / "answers.json"
DEFAULT_RECALL_DATASET = EVALS_DIR / ".cache" / "grading" / "recall.json"
UNUSED_DB = "postgresql://user:pass@localhost:5432/unused"  # app.config wants one; A5 never connects

# Arm name -> model spec (None: the app's own choice for grade_short_answer).
ARMS: Dict[str, Optional[str]] = {"haiku": None, "sonnet": "sonnet:low"}
BATCH_PRICE = 0.5
DEFAULT_MAX_USD = 2.0
PASS_MARK = 0.7  # the app's is_correct: points >= 70% of the question's points
NONE_BELOW = 0.25  # the labels' line between partial and none
QUESTION_FIELDS = ("question_type", "question_text", "sample_answer", "key_points", "points", "concept_ids")
LABELS = ("full", "partial", "none")
VERDICTS = ("covered", "partial", "missing", "incorrect")  # the recall grader's verdicts, and the recall labels
CATEGORIES = ("right", "other_words", "partly", "wrong", "right_number_wrong_quantity", "keyword_wrong")
# M3's rule, fixed before the run: Sonnet replaces Haiku only for a clear gain. Either it marks at least 5 points fewer
# wrong answers right while agreeing with the labels at most 2 points less, or it agrees at least 5 points more while
# marking no more wrong answers right. Otherwise Haiku stays: it is about 20 times cheaper and faster.
BAR = 0.05
AGREEMENT_SLACK = 0.02
EPS = 1e-9
# Gates on both kinds of wrong mark, per arm (P-I1). A prompt that reads the rubric more loosely must not pass wrong
# answers, and one that reads it to the letter must not fail right ones, so neither rate is gated alone. The lines sit one
# answer above what the v1 prompts scored on these datasets on 2026-11-10 (short answers, Haiku, two runs: 1 of 72 wrong
# marked right, 0 of 48 right marked wrong; recall: 1 of 39 claims given false credit, 12 of 113 withheld).
GATES = (
    ("wrong_marked_right", "Wrong answers marked right", 0.03),
    ("right_marked_wrong", "Right answers marked wrong", 0.03),
)
RECALL_GATES = (
    ("false_credit", "Claims not covered that were marked covered", 0.06),
    ("credit_withheld", "Covered claims not marked covered", 0.12),
)


def log(message: str = "") -> None:
    print(message, file=sys.stderr, flush=True)


def _app() -> None:
    """Make `app` and the generation eval's adapters importable without printing settings: app.config needs a
    DATABASE_URL (finding 91)."""
    os.environ.setdefault("DATABASE_URL", UNUSED_DB)
    os.environ.setdefault("EMBEDDING_PROVIDER", "local")
    for path in (AI_SERVICE_DIR, EVALS_DIR, EVALS_DIR / "generation"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))


# ---------------------------------------------------------------------------- the dataset


def build_dataset(answers: Dict[str, Any], raw_dir: Path) -> List[Dict[str, Any]]:
    """Each labelled question with its item embedded from the source run (ref: `<raw file stem>#<index in output>`)."""
    dataset: List[Dict[str, Any]] = []
    outputs: Dict[Path, List[Dict[str, Any]]] = {}
    for question in answers["questions"]:
        stem, _, index = question["ref"].partition("#")
        path = raw_dir / f"{stem}.json"
        try:
            if path not in outputs:
                outputs[path] = json.loads(path.read_text())["output"]
            item = outputs[path][int(index)]
        except (OSError, KeyError, IndexError, ValueError) as exc:
            raise SystemExit(f"{question['id']}: cannot read {question['ref']} from {raw_dir} ({type(exc).__name__})")
        if item.get("question_type") != "short_answer":
            raise SystemExit(f"{question['id']}: {question['ref']} is a {item.get('question_type')} item, not a short answer")
        dataset.append(
            {
                "qid": question["id"],
                "ref": question["ref"],
                "question": {field: item.get(field) for field in QUESTION_FIELDS},
                "answers": [
                    {
                        "n": n,
                        "category": answer["category"],
                        "label": answer["label"],
                        "borderline": bool(answer.get("borderline")),
                        "text": answer["text"],
                    }
                    for n, answer in enumerate(question["answers"])
                ],
            }
        )
    return dataset


def dataset_counts(dataset: List[Dict[str, Any]]) -> Dict[str, Any]:
    answers = [a for entry in dataset for a in entry["answers"]]
    return {
        "questions": len(dataset),
        "answers": len(answers),
        "by_category": dict(Counter(a["category"] for a in answers)),
        "by_label": dict(Counter(a["label"] for a in answers)),
        "borderline": sum(a["borderline"] for a in answers),
    }


# ---------------------------------------------------------------------------- grading


def band(fraction: float) -> str:
    if fraction >= PASS_MARK - EPS:
        return "full"
    if fraction < NONE_BELOW:
        return "none"
    return "partial"


def make_grader(llm: Any):
    """The app's grader with `llm` as its provider (its __init__ would build the app's own)."""
    _app()
    from app.services.exam_grader import ExamGrader

    grader = ExamGrader.__new__(ExamGrader)
    grader.llm = llm
    return grader


async def grade_one(grader: Any, question: Dict[str, Any], text: str) -> Dict[str, Any]:
    """Grade one answer as a quiz or exam does. A grade the app flags for review (no usable reply) is an error."""
    max_points = question.get("points", 3)
    try:
        result = await grader._grade_short_answer(question, text)
    except Exception as exc:  # the app re-raises provider-down and transient errors
        result = {"needs_review": True, "error": f"{type(exc).__name__}: {exc}"}
    if result.get("needs_review"):
        return {"outcome": "error", "points": None, "max_points": max_points, "fraction": None, "band": None, "is_correct": None, "result": result}
    fraction = result["points_earned"] / max_points if max_points else 0.0
    return {
        "outcome": "ok",
        "points": result["points_earned"],
        "max_points": max_points,
        "fraction": fraction,
        "band": band(fraction),
        "is_correct": bool(result["is_correct"]),
        "result": result,
    }


class _CapturePrompt:
    """Records the messages the grader would send and answers with a zero grade."""

    def __init__(self):
        self.messages: List[Any] = []
        self.schemas: List[Any] = []

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        self.messages.append(messages)
        self.schemas.append(schema)
        # v2's ShortAnswerChecksV2 has no points_earned (computed in code); its example() is a valid zero grade.
        return schema.example() if hasattr(schema, "example") else schema(points_earned=0, feedback="")


async def capture_requests(dataset: List[Dict[str, Any]]) -> "_CapturePrompt":
    """Every request the app's grader builds for the dataset (messages and the schema it picked), nothing sent."""
    _app()
    capture = _CapturePrompt()
    grader = make_grader(capture)
    for entry in dataset:
        for answer in entry["answers"]:
            await grader._grade_short_answer(entry["question"], answer["text"])
    return capture


async def estimate_usd(dataset: List[Dict[str, Any]], model: str, capture: Optional["_CapturePrompt"] = None) -> float:
    """Batch-price estimate for grading every answer once on `model`, from the prompts and schema the app's grader
    builds (v1 or v2, as PROMPTS_V2 says)."""
    _app()
    import adapters
    from spend import DEFAULT_OUTPUT_TOKENS, estimate_prompt_tokens

    capture = capture or await capture_requests(dataset)
    output = DEFAULT_OUTPUT_TOKENS["grade_short_answer"]
    total = 0.0
    for messages, schema in zip(capture.messages, capture.schemas):
        tokens = estimate_prompt_tokens([m.content for m in messages], schema.model_json_schema())
        total += adapters.estimate_cost(model, tokens, output, 0) or 0.0
    return total * BATCH_PRICE


# ---------------------------------------------------------------------------- scoring


def _rate(count: int, of: int) -> Dict[str, Any]:
    return {"count": count, "of": of, "rate": count / of if of else None}


def _mean(values: List[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def apply_gates(arms: Dict[str, Any], gates: Any) -> Dict[str, Any]:
    """Each arm against each gate: the rate, the line and whether it passed. A rate with nothing to count does not pass."""
    return {
        arm: [
            {"key": key, "label": label, "at_most": limit, **scores[key], "passed": scores[key]["rate"] is not None and scores[key]["rate"] <= limit + EPS}
            for key, label, limit in gates
        ]
        for arm, scores in arms.items()
    }


def gates_passed(summary: Dict[str, Any]) -> bool:
    return all(gate["passed"] for gates in summary["gates"].values() for gate in gates)


def _gates_section(summary: Dict[str, Any]) -> List[str]:
    if not summary.get("gates"):  # a summary stored before the gates existed
        return []
    names = list(summary["gates"])
    first = summary["gates"][names[0]]
    rows = [
        [gate["label"], f"at most {_pct(gate['at_most'])}"]
        + [f"{_count(summary['gates'][arm][index])}: {'pass' if summary['gates'][arm][index]['passed'] else 'FAIL'}" for arm in names]
        for index, gate in enumerate(first)
    ]
    verdict = "All gates pass." if gates_passed(summary) else "A gate failed."
    return ["", "## Gates", "", "Both kinds of wrong mark are gated, so a change cannot buy one with the other.", "", _table(["Gate", "Line"] + names, rows), "", verdict]


def _arm_scores(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    scored = [r for r in rows if r["outcome"] == "ok"]
    plain = [r for r in scored if not r["borderline"]]
    not_full = [r for r in scored if r["label"] != "full"]
    full = [r for r in scored if r["label"] == "full"]
    categories = {}
    for category in [c for c in CATEGORIES if any(r["category"] == c for r in scored)] + sorted(
        {r["category"] for r in scored} - set(CATEGORIES)
    ):
        mine = [r for r in scored if r["category"] == category]
        categories[category] = {
            "n": len(mine),
            "agreement": _mean([float(r["band"] == r["label"]) for r in mine]),
            "marked_right": _mean([float(r["is_correct"]) for r in mine]),
            "mean_fraction": _mean([r["fraction"] for r in mine]),
        }
    return {
        "scored": len(scored),
        "errors": len(rows) - len(scored),
        "agreement": _mean([float(r["band"] == r["label"]) for r in scored]),
        "agreement_not_borderline": _mean([float(r["band"] == r["label"]) for r in plain]),
        "pass_agreement": _mean([float(r["is_correct"] == (r["label"] == "full")) for r in scored]),
        "wrong_marked_right": _rate(sum(r["is_correct"] for r in not_full), len(not_full)),
        "right_marked_wrong": _rate(sum(not r["is_correct"] for r in full), len(full)),
        "confusion": {label: dict(Counter(r["band"] for r in scored if r["label"] == label)) for label in LABELS},
        "categories": categories,
    }


def aggregate(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Scores per arm. Rows carry labels and grades only; answer text never enters the summary."""
    arms = list(dict.fromkeys(r["arm"] for r in rows))
    scores = {arm: _arm_scores([r for r in rows if r["arm"] == arm]) for arm in arms}
    return {"arms": scores, "gates": apply_gates(scores, GATES)}


def pick_model(summary: Dict[str, Any]) -> Tuple[str, str]:
    """M3's rule (see BAR): the grading model to set, and why."""
    haiku, sonnet = summary["arms"].get("haiku"), summary["arms"].get("sonnet")
    if not haiku or not sonnet:
        return "haiku", "only one arm was graded, so nothing changes"
    fewer_wrong = (haiku["wrong_marked_right"]["rate"] or 0.0) - (sonnet["wrong_marked_right"]["rate"] or 0.0)
    more_agreement = (sonnet["agreement"] or 0.0) - (haiku["agreement"] or 0.0)
    gap = f"Sonnet marks {fewer_wrong * 100:+.0f} points fewer wrong answers right and agrees {more_agreement * 100:+.0f} points more"
    if fewer_wrong >= BAR - EPS and more_agreement >= -AGREEMENT_SLACK - EPS:
        return "sonnet", gap + ": a clear gain on wrong answers marked right"
    if more_agreement >= BAR - EPS and fewer_wrong >= -EPS:
        return "sonnet", gap + ": a clear gain in agreement"
    return "haiku", gap + ": under the bar, so the cheaper, faster model stays"


# ---------------------------------------------------------------------------- the report


def _pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def _count(rate: Dict[str, Any]) -> str:
    return f"{_pct(rate['rate'])} ({rate['count']} of {rate['of']})"


def _table(head: List[str], rows: List[List[str]]) -> str:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    return "\n".join(lines + ["| " + " | ".join(row) + " |" for row in rows])


def render_report(summary: Dict[str, Any], meta: Dict[str, Any]) -> str:
    arms = summary["arms"]
    names = list(arms)
    models = summary.get("models", {})
    cost = summary.get("cost", {})
    out = [f"# A5: grading eval ({meta['label']}, {meta['date']})", ""]
    counts = summary.get("dataset")
    if counts:
        out.append(
            f"{counts['answers']} hand-labelled answers to {counts['questions']} short-answer items, graded once per arm by "
            f"the app's short-answer grader. Labels: {counts['by_label']}; {counts['borderline']} marked borderline."
        )
        out.append("")
    for arm in names:
        model = models.get(arm, {})
        out.append(
            f"- **{arm}**: {model.get('model', '?')} at {model.get('effort', '?')} effort; "
            f"{arms[arm]['scored']} graded, {arms[arm]['errors']} errors; ${cost.get(arm, 0.0):.3f}"
        )
    out += ["", "## Scores", ""]
    out.append(
        _table(
            ["Score"] + names,
            [
                ["Band agrees with the label"] + [_pct(arms[a]["agreement"]) for a in names],
                ["... without borderline answers"] + [_pct(arms[a]["agreement_not_borderline"]) for a in names],
                ["Pass or fail agrees"] + [_pct(arms[a]["pass_agreement"]) for a in names],
                ["Wrong answers marked right (lower is better)"] + [_count(arms[a]["wrong_marked_right"]) for a in names],
                ["Right answers marked wrong (lower is better)"] + [_count(arms[a]["right_marked_wrong"]) for a in names],
            ],
        )
    )
    out += _gates_section(summary)
    out += ["", "## By category", "", "Per arm: agreement with the label, share marked right (passed), mean score.", ""]
    categories = list(dict.fromkeys(c for a in names for c in arms[a]["categories"]))
    rows = []
    for category in categories:
        row = [category]
        for arm in names:
            scores = arms[arm]["categories"].get(category)
            row.append(
                "n/a"
                if not scores
                else f"{_pct(scores['agreement'])} agree, {_pct(scores['marked_right'])} passed, mean {_pct(scores['mean_fraction'])}"
            )
        rows.append(row)
    out.append(_table(["Category"] + names, rows))
    out += ["", "## Label against band", ""]
    for arm in names:
        confusion = arms[arm]["confusion"]
        out.append(f"**{arm}**")
        out.append("")
        out.append(_table(["Label \\ band", *LABELS], [[label] + [str(confusion[label].get(b, 0)) for b in LABELS] for label in LABELS]))
        out.append("")
    if "pick" in summary:
        out += ["## MODEL_GRADING (M3)", "", f"**{summary['pick']['arm']}**: {summary['pick']['reason']}.", ""]
        out.append(
            "The rule, fixed before the run: Sonnet replaces Haiku only if it marks at least 5 points fewer wrong answers "
            "right while agreeing with the labels at most 2 points less, or agrees at least 5 points more while marking no "
            "more wrong answers right."
        )
        out.append("")
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------- the recall grader arm


def build_recall_dataset(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The labelled recall prompts, checked: every gradable answer has exactly one label per claim."""
    prompts = data["prompts"]
    for entry in prompts:
        ids = [claim["id"] for claim in entry["claims"]]
        for answer in entry["answers"]:
            if answer["gradable"] and list(answer["labels"]) != ids:
                raise SystemExit(f"{entry['pid']}#{answer['n']}: labels do not match the prompt's claims")
            if answer["gradable"] and set(answer["labels"].values()) - set(VERDICTS):
                raise SystemExit(f"{entry['pid']}#{answer['n']}: unknown label")
    return prompts


def recall_counts(dataset: List[Dict[str, Any]]) -> Dict[str, Any]:
    answers = [a for entry in dataset for a in entry["answers"]]
    return {
        "prompts": len(dataset),
        "answers": len(answers),
        "gradable": sum(a["gradable"] for a in answers),
        "ungradable": sum(not a["gradable"] for a in answers),
        "claims": sum(len(a["labels"]) for a in answers),
        "by_kind": dict(Counter(a["kind"] for a in answers)),
        "by_label": dict(Counter(label for a in answers for label in a["labels"].values())),
        "reasoning_gap_labels": sum(len(a.get("reasoning_gap") or {}) for a in answers),
    }


def recall_request(entry: Dict[str, Any], answer: Dict[str, Any]) -> Any:
    """The request the app's route builds for one answer."""
    _app()
    from app.services.llm.schemas import RecallClaim, RecallGradeRequest

    return RecallGradeRequest(
        prompt=entry["prompt"],
        claims=[RecallClaim(**claim) for claim in entry["claims"]],
        answer=answer["text"],
        user_id="eval",
        project_id="eval",
    )


@contextlib.contextmanager
def recall_provider(provider: Any):
    """The app's grader takes its provider from LLMFactory; point that at `provider` for the block."""
    _app()
    from app.services.llm.factory import LLMFactory

    saved = LLMFactory._instance
    LLMFactory._instance = provider
    try:
        yield
    finally:
        LLMFactory._instance = saved


async def grade_recall_answer(request: Any) -> Dict[str, Any]:
    """Grade one answer with the app's `grade_recall` (quote checks, abstaining and all). An exception is an error."""
    _app()
    from app.services.recall_grader import grade_recall

    try:
        result = await grade_recall(request)
    except Exception as exc:  # the route would answer with an error
        return {"outcome": "error", "error": f"{type(exc).__name__}: {exc}"}
    return {
        "outcome": "ok",
        "status": result.status,
        "confidence": result.confidence,
        "verdicts": {v.claim_id: {"verdict": v.verdict, "reasoning_gap": v.reasoning_gap} for v in result.verdicts},
    }


def recall_row(arm: str, entry: Dict[str, Any], answer: Dict[str, Any], graded: Dict[str, Any]) -> Dict[str, Any]:
    """Labels and the grade side by side, without the answer's text."""
    verdicts = graded.get("verdicts", {})
    claims = [
        {
            "expected": label,
            "verdict": verdicts.get(claim_id, {}).get("verdict"),
            "gap_expected": (answer.get("reasoning_gap") or {}).get(claim_id),
            "gap_got": verdicts.get(claim_id, {}).get("reasoning_gap"),
        }
        for claim_id, label in answer["labels"].items()
    ]
    return {
        "arm": arm,
        "pid": entry["pid"],
        "n": answer["n"],
        "kind": answer["kind"],
        "gradable": answer["gradable"],
        "outcome": graded["outcome"],
        "status": graded.get("status"),
        "confidence": graded.get("confidence"),
        "claims": claims,
    }


def _recall_arm_scores(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    scored = [r for r in rows if r["outcome"] == "ok"]
    gradable = [r for r in scored if r["gradable"]]
    ungradable = [r for r in scored if not r["gradable"]]
    graded = [r for r in gradable if r["status"] == "graded"]
    claims = [dict(c, kind=r["kind"]) for r in graded for c in r["claims"]]
    right = [c for c in claims if c["verdict"] == c["expected"]]
    not_covered = [c for c in claims if c["expected"] != "covered"]
    covered = [c for c in claims if c["expected"] == "covered"]
    gaps = [c for c in claims if c["gap_expected"] is not None and c["verdict"] == "covered"]
    by_kind = {}
    for kind in dict.fromkeys(c["kind"] for c in claims):
        mine = [c for c in claims if c["kind"] == kind]
        by_kind[kind] = _rate(sum(c["verdict"] == c["expected"] for c in mine), len(mine))
    return {
        "scored": len(scored),
        "errors": len(rows) - len(scored),
        "verdict_accuracy": _rate(len(right), len(claims)),
        "answers_all_right": _rate(sum(all(c["verdict"] == c["expected"] for c in r["claims"]) for r in graded), len(graded)),
        "false_credit": _rate(sum(c["verdict"] == "covered" for c in not_covered), len(not_covered)),
        "credit_withheld": _rate(sum(c["verdict"] != "covered" for c in covered), len(covered)),
        "ungradable_flagged": _rate(sum(r["status"] == "ungraded" for r in ungradable), len(ungradable)),
        "gradable_held_back": _rate(sum(r["status"] == "ungraded" for r in gradable), len(gradable)),
        "reasoning_gap_agreement": _rate(sum(c["gap_got"] == c["gap_expected"] for c in gaps), len(gaps)),
        "confusion": {
            label: dict(Counter(c["verdict"] or "none" for c in claims if c["expected"] == label)) for label in VERDICTS
        },
        "by_kind": by_kind,
    }


def aggregate_recall(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Scores per arm. Rows carry labels and verdicts only; answer text never enters the summary."""
    arms = list(dict.fromkeys(r["arm"] for r in rows))
    scores = {arm: _recall_arm_scores([r for r in rows if r["arm"] == arm]) for arm in arms}
    return {"arms": scores, "gates": apply_gates(scores, RECALL_GATES)}


async def capture_recall_requests(dataset: List[Dict[str, Any]]) -> "_CapturePrompt":
    """Every request the app's recall grader builds for the dataset (messages and the schema it picked), nothing sent.
    Answers the grader refuses to send (too short to read) build none."""
    capture = _CapturePrompt()
    with recall_provider(capture):
        for entry in dataset:
            for answer in entry["answers"]:
                await grade_recall_answer(recall_request(entry, answer))
    return capture


async def estimate_recall_usd(capture: "_CapturePrompt", model: str) -> float:
    _app()
    import adapters
    from spend import DEFAULT_OUTPUT_TOKENS, estimate_prompt_tokens

    output = DEFAULT_OUTPUT_TOKENS["recall_grading"]
    total = 0.0
    for messages, schema in zip(capture.messages, capture.schemas):
        tokens = estimate_prompt_tokens([m.content for m in messages], schema.model_json_schema())
        total += adapters.estimate_cost(model, tokens, output, 0) or 0.0
    return total * BATCH_PRICE


def render_recall_report(summary: Dict[str, Any], meta: Dict[str, Any]) -> str:
    arms = summary["arms"]
    names = list(arms)
    models = summary.get("models", {})
    cost = summary.get("cost", {})
    counts = summary["dataset"]
    prompts = summary.get("prompts", {})
    out = [f"# A5 recall grader ({meta['label']}, {meta['date']})", ""]
    out.append(
        f"{counts['answers']} hand-labelled recall answers ({counts['gradable']} gradable, {counts['ungradable']} not) to "
        f"{counts['prompts']} recall prompts, {counts['claims']} claim labels {counts['by_label']}, graded once per arm by the "
        f"app's recall grader (`grade_recall`, prompts {prompts.get('revision', '?')}, PROMPTS_V2={prompts.get('PROMPTS_V2', '')!r})."
    )
    out.append("")
    for arm in names:
        model = models.get(arm, {})
        out.append(
            f"- **{arm}**: {model.get('model', '?')} at {model.get('effort', '?')} effort; "
            f"{arms[arm]['scored']} graded, {arms[arm]['errors']} errors; ${cost.get(arm, 0.0):.3f}"
        )
    out += ["", "## Scores", ""]
    rows = [
        ["Verdict agrees with the label (per claim)", "verdict_accuracy"],
        ["Answers with every claim right", "answers_all_right"],
        ["Claims not covered that were marked covered (lower is better)", "false_credit"],
        ["Covered claims not marked covered (lower is better)", "credit_withheld"],
        ["Ungradable answers flagged (higher is better)", "ungradable_flagged"],
        ["Gradable answers held back (lower is better)", "gradable_held_back"],
        ["Reasoning gap agrees (covered claims with a gap label)", "reasoning_gap_agreement"],
    ]
    out.append(_table(["Score"] + names, [[label] + [_count(arms[a][key]) for a in names] for label, key in rows]))
    out += _gates_section(summary)
    out += ["", "## By answer kind", "", "Per-claim verdict agreement, on answers that were graded.", ""]
    kinds = list(dict.fromkeys(k for a in names for k in arms[a]["by_kind"]))
    out.append(_table(["Kind"] + names, [[k] + [_count(arms[a]["by_kind"][k]) if k in arms[a]["by_kind"] else "n/a" for a in names] for k in kinds]))
    out += ["", "## Label against verdict", ""]
    columns = [*VERDICTS, "none"]
    for arm in names:
        confusion = arms[arm]["confusion"]
        out.append(f"**{arm}**")
        out.append("")
        out.append(_table(["Label \\ verdict", *columns], [[label] + [str(confusion[label].get(v, 0)) for v in columns] for label in VERDICTS]))
        out.append("")
    return "\n".join(out).rstrip() + "\n"


async def _grade_recall_arm(arm: str, dataset: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    import adapters

    async def one(entry, answer):
        with adapters.call_sink() as calls:
            graded = await grade_recall_answer(recall_request(entry, answer))
        outcome = graded["outcome"] if calls or graded["outcome"] == "ok" else "not sent (spend cap)"
        return {**recall_row(arm, entry, answer, graded), "outcome": outcome, "graded": graded, "calls": calls}

    return list(await asyncio.gather(*(one(entry, answer) for entry in dataset for answer in entry["answers"])))


async def run_recall(args: argparse.Namespace) -> int:
    _app()
    import adapters
    from app.services.llm.models import resolve_model
    from common.revision import prompt_revision, request_summary
    from spend import GENERATION, SpendTracker

    dataset = build_recall_dataset(json.loads(args.recall_dataset.read_text()))
    counts = recall_counts(dataset)
    app_choice = resolve_model("recall_grading")
    models = {"app": {"model": app_choice.model, "effort": app_choice.effort, "app_choice": True}}
    price = 1.0 if args.mock else BATCH_PRICE
    capture = await capture_recall_requests(dataset)
    estimate = await estimate_recall_usd(capture, app_choice.model)
    revision = prompt_revision("tutor")
    request = request_summary(capture.messages[0], capture.schemas[0]) if capture.messages else {}

    log("Plan (recall grader)")
    log(f"  prompts: PROMPTS_V2={revision['PROMPTS_V2']!r} -> tutor {revision['areas']['tutor']}; first request: {request}")
    log(f"  {counts['answers']} answers ({counts['ungradable']} ungradable) to {counts['prompts']} prompts; {len(capture.messages)} reach the model; kinds {counts['by_kind']}")
    log(f"  app {app_choice.model} at {app_choice.effort} effort: about ${estimate:.3f} on the Batch API (output tokens guessed; thinking not counted)")
    log(f"  cap --max-usd {args.max_usd}")
    if not args.mock and estimate > args.max_usd:
        raise SystemExit(f"the estimate ${estimate:.3f} passes the cap ${args.max_usd}; raise --max-usd")
    if args.dry_run:
        log("  Nothing was sent.")
        return 0

    date = datetime.date.today().isoformat()
    run_dir = RESULTS_DIR / f"{date}-{args.label}"
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)
    (run_dir / "raw" / "dataset.json").write_text(json.dumps(dataset, indent=1) + "\n")

    api_key = "" if args.mock else adapters.load_api_key(args.env_file or (AI_SERVICE_DIR / ".env"))
    if not args.mock and not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is not set and ai-service/.env has none. Use --mock to test without a key.")
    inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
    batched = None
    if price == BATCH_PRICE:
        from common.batching import install_batching

        batched = install_batching(inner, poll=args.batch_poll, log=log)
    tracker = SpendTracker(args.max_usd, args.max_usd, lambda *a: (adapters.estimate_cost(*a) or 0.0) * price)
    metered = adapters.MeteredProvider(inner, None, tracker, GENERATION)
    metered.price_factor = price

    log("Grading")
    with recall_provider(metered):
        records = await _grade_recall_arm("app", dataset)
    (run_dir / "raw" / "app.json").write_text(json.dumps(records, indent=1) + "\n")

    rows = [{k: v for k, v in r.items() if k not in ("graded", "calls")} for r in records]
    summary = aggregate_recall(rows)
    summary["dataset"] = counts
    summary["models"] = models
    summary["prompts"] = revision
    summary["cost"] = {"app": round(sum(c["cost_usd"] for r in records for c in r["calls"]), 6)}
    meta = {"label": args.label, "date": date}
    summary["run"] = {
        **meta,
        "dataset_kind": "recall",
        "commit": git("rev-parse", "--short", "HEAD"),
        "dirty": bool(git("status", "--porcelain", "--", "evals", "ai-service/app")),
        "arms": models,
        "prompts": {**revision, "request": request},
        "estimate_usd": {"app": round(estimate, 4)},
        "cost_usd": summary["cost"],
        "total_cost_usd": summary["cost"]["app"],
        "price_factor": price,
        "mock": args.mock,
        "batches": batched.batches if batched else [],
        "outcomes": dict(Counter(f"{r['arm']}: {r['outcome']}" for r in rows)),
    }
    (run_dir / "run.json").write_text(json.dumps(summary["run"], indent=2) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    report = RESULTS_DIR / f"{date}-{args.label}.md"
    report.write_text(render_recall_report(summary, meta))
    log(f"Cost: ${summary['run']['total_cost_usd']:.4f}")
    log(f"Report: {report}")
    return _gate_exit(summary, args.mock)


# ---------------------------------------------------------------------------- the run


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", default=None, help="default a5, or a5-recall with --recall")
    parser.add_argument("--arms", default=",".join(ARMS), help="comma-separated, from: " + ", ".join(ARMS) + " (not used with --recall)")
    parser.add_argument("--recall", action="store_true", help="grade the recall dataset with the app's recall grader (one arm: the app's own model)")
    parser.add_argument("--recall-dataset", type=Path, default=DEFAULT_RECALL_DATASET, help="the hand-labelled recall answers")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET, help="the hand-labelled answers")
    parser.add_argument("--dry-run", action="store_true", help="build the dataset and print the estimate; nothing is sent")
    parser.add_argument("--mock", action="store_true", help="the app's mock provider: free, checks the plumbing only")
    parser.add_argument("--max-usd", type=float, default=DEFAULT_MAX_USD)
    parser.add_argument("--batch-poll", type=float, default=15.0)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--env-file", type=Path, help="default ai-service/.env")
    args = parser.parse_args(argv)
    args.label = args.label or ("a5-recall" if args.recall else "a5")
    args.arm_list = [a.strip() for a in args.arms.split(",") if a.strip()]
    unknown = [a for a in args.arm_list if a not in ARMS]
    if unknown and not args.recall:
        parser.error(f"unknown arms {unknown}; choose from {list(ARMS)}")
    return args


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True).stdout.strip()


async def _grade_arm(arm: str, grader: Any, dataset: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    import adapters

    async def one(entry, answer):
        with adapters.call_sink() as calls:
            graded = await grade_one(grader, entry["question"], answer["text"])
        outcome = graded["outcome"] if calls or graded["outcome"] == "ok" else "not sent (spend cap)"
        return {
            "arm": arm,
            "qid": entry["qid"],
            "n": answer["n"],
            "category": answer["category"],
            "label": answer["label"],
            "borderline": answer["borderline"],
            **{k: graded[k] for k in ("points", "max_points", "fraction", "band", "is_correct")},
            "outcome": outcome,
            "result": graded["result"],
            "calls": calls,
        }

    return list(await asyncio.gather(*(one(entry, answer) for entry in dataset for answer in entry["answers"])))


async def run(args: argparse.Namespace) -> int:
    _app()
    import adapters
    from app.services.llm.models import resolve_model
    from spend import GENERATION, SpendTracker

    answers = json.loads(args.dataset.read_text())
    dataset = build_dataset(answers, REPO_ROOT / answers["source_run"] / "raw")
    counts = dataset_counts(dataset)
    today = resolve_model("grade_short_answer")
    specs = {arm: adapters.parse_model_spec(ARMS[arm]) if ARMS[arm] else None for arm in args.arm_list}
    models = {
        arm: {"model": spec.model_id, "effort": spec.effort} if spec else {"model": today.model, "effort": today.effort, "app_choice": True}
        for arm, spec in specs.items()
    }
    price = 1.0 if args.mock else BATCH_PRICE
    capture = await capture_requests(dataset)
    estimates = {arm: await estimate_usd(dataset, models[arm]["model"], capture) for arm in args.arm_list}
    from common.revision import prompt_revision, request_summary

    revision = prompt_revision("grading")
    request = request_summary(capture.messages[0], capture.schemas[0]) if capture.messages else {}

    log("Plan")
    log(f"  prompts: PROMPTS_V2={revision['PROMPTS_V2']!r} -> grading {revision['areas']['grading']}; first request: {request}")
    log(f"  {counts['answers']} answers to {counts['questions']} questions; by category {counts['by_category']}")
    for arm in args.arm_list:
        log(f"  {arm:<7} {models[arm]['model']} at {models[arm]['effort']} effort: about ${estimates[arm]:.3f} on the Batch API")
    total = sum(estimates.values())
    log(f"  estimated total ${total:.3f}; cap --max-usd {args.max_usd}")
    if not args.mock and total > args.max_usd:
        raise SystemExit(f"the estimate ${total:.3f} passes the cap ${args.max_usd}; raise --max-usd or narrow --arms")
    if args.dry_run:
        log("  Nothing was sent.")
        return 0

    date = datetime.date.today().isoformat()
    run_dir = RESULTS_DIR / f"{date}-{args.label}"
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)
    (run_dir / "raw" / "dataset.json").write_text(json.dumps(dataset, indent=1) + "\n")

    api_key = "" if args.mock else adapters.load_api_key(args.env_file or (AI_SERVICE_DIR / ".env"))
    if not args.mock and not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is not set and ai-service/.env has none. Use --mock to test without a key.")
    inner = adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout)
    batched = None
    if price == BATCH_PRICE:
        from common.batching import install_batching

        batched = install_batching(inner, poll=args.batch_poll, log=log)
    tracker = SpendTracker(args.max_usd, args.max_usd, lambda *a: (adapters.estimate_cost(*a) or 0.0) * price)
    graders = {}
    for arm, spec in specs.items():
        metered = adapters.MeteredProvider(inner, spec, tracker, GENERATION)
        metered.price_factor = price
        graders[arm] = make_grader(metered)

    log("Grading")
    per_arm = await asyncio.gather(*(_grade_arm(arm, graders[arm], dataset) for arm in args.arm_list))
    records = [record for rows in per_arm for record in rows]
    for arm, rows in zip(args.arm_list, per_arm):
        (run_dir / "raw" / f"{arm}.json").write_text(json.dumps(rows, indent=1) + "\n")

    rows = [{k: v for k, v in r.items() if k not in ("result", "calls")} for r in records]
    summary = aggregate(rows)
    summary["dataset"] = counts
    summary["models"] = models
    summary["cost"] = {arm: round(sum(c["cost_usd"] for r in rows_ for c in r["calls"]), 6) for arm, rows_ in zip(args.arm_list, per_arm)}
    if "haiku" in summary["arms"] and "sonnet" in summary["arms"]:
        arm, reason = pick_model(summary)
        summary["pick"] = {"arm": arm, "reason": reason}
    meta = {"label": args.label, "date": date}
    summary["run"] = {
        **meta,
        "commit": git("rev-parse", "--short", "HEAD"),
        "dirty": bool(git("status", "--porcelain", "--", "evals", "ai-service/app")),
        "arms": models,
        "prompts": {**revision, "request": request},
        "estimate_usd": {arm: round(v, 4) for arm, v in estimates.items()},
        "cost_usd": summary["cost"],
        "total_cost_usd": round(sum(summary["cost"].values()), 6),
        "price_factor": price,
        "mock": args.mock,
        "batches": batched.batches if batched else [],
        "outcomes": dict(Counter(f"{r['arm']}: {r['outcome']}" for r in rows)),
    }
    (run_dir / "run.json").write_text(json.dumps(summary["run"], indent=2) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    report = RESULTS_DIR / f"{date}-{args.label}.md"
    report.write_text(render_report(summary, meta))
    log(f"Cost: ${summary['run']['total_cost_usd']:.4f} ({', '.join(f'{a} ${c:.4f}' for a, c in summary['cost'].items())})")
    log(f"Report: {report}")
    return _gate_exit(summary, args.mock)


def _gate_exit(summary: Dict[str, Any], mock: bool) -> int:
    """Logs each gate and gives the exit code: 1 when one failed. A mock run grades nothing, so its gates decide nothing."""
    for arm, gates in summary["gates"].items():
        for gate in gates:
            log(f"  {'pass' if gate['passed'] else 'FAIL':<5} {arm}: {gate['label']}: {_count(gate)} (at most {_pct(gate['at_most'])})")
    return 0 if mock or gates_passed(summary) else 1


def main() -> int:
    args = parse_args()
    return asyncio.run(run_recall(args) if args.recall else run(args))


if __name__ == "__main__":
    sys.exit(main())

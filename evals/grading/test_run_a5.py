"""Tests for the grading eval's runner. No database, no model, no network; every question and answer here is neutral
text written for the test (K21: nothing from the course corpora)."""
import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_a5  # noqa: E402

QUESTION = {
    "question_type": "short_answer",
    "question_text": "Why does a metal spoon feel colder than a wooden one at the same temperature?",
    "sample_answer": "Metal conducts heat away from the hand faster than wood does.",
    "key_points": ["metal conducts heat well", "heat leaves the hand faster", "both are at the same temperature"],
    "points": 3,
    "concept_ids": ["c-heat"],
    "topic_name": "Heat",
}


class StubLLM:
    """Answers the grader's one structured call with a fixed score, or raises."""

    def __init__(self, points=None, error=None):
        self.points = points
        self.error = error
        self.purposes = []

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        self.purposes.append(purpose)
        if self.error is not None:
            raise self.error
        return schema(points_earned=self.points, feedback="Stub feedback.")


def row(label, fraction, *, category="right", borderline=False, outcome="ok", arm="haiku"):
    return {
        "arm": arm,
        "qid": "q01",
        "n": 0,
        "category": category,
        "label": label,
        "borderline": borderline,
        "fraction": fraction,
        "band": None if fraction is None else run_a5.band(fraction),
        "is_correct": fraction is not None and fraction >= 0.7,
        "outcome": outcome,
    }


@pytest.mark.parametrize(
    "fraction, expected",
    [(0.7, "full"), (0.69, "partial"), (0.25, "partial"), (0.24, "none")],
)
def test_band_follows_the_apps_pass_mark_and_the_labels_none_line(fraction, expected):
    assert run_a5.band(fraction) == expected


def test_grade_one_runs_the_apps_grader_and_bands_its_score():
    stub = StubLLM(points=2)
    graded = asyncio.run(run_a5.grade_one(run_a5.make_grader(stub), QUESTION, "Metal moves heat."))
    assert stub.purposes == ["grade_short_answer"]
    assert graded["outcome"] == "ok"
    assert graded["points"] == 2 and graded["max_points"] == 3
    assert graded["fraction"] == pytest.approx(2 / 3)
    assert graded["band"] == "partial"
    assert graded["is_correct"] is False


def test_grade_one_uses_the_apps_clamped_score():
    graded = asyncio.run(run_a5.grade_one(run_a5.make_grader(StubLLM(points=7)), QUESTION, "Metal moves heat."))
    assert graded["points"] == 3
    assert graded["band"] == "full"
    assert graded["is_correct"] is True


def test_a_grade_the_app_flags_for_review_is_an_error_not_a_zero():
    graded = asyncio.run(run_a5.grade_one(run_a5.make_grader(StubLLM(error=RuntimeError("no reply"))), QUESTION, "Metal."))
    assert graded["outcome"] == "error"
    assert graded["fraction"] is None
    assert graded["band"] is None


def test_aggregate_counts_agreement_and_both_kinds_of_wrong_mark():
    rows = [
        row("full", 1.0),
        row("full", 0.5),  # right marked wrong
        row("none", 0.8, category="keyword_wrong", borderline=True),  # wrong marked right
        row("partial", 0.5, category="partly"),
        row("none", None, outcome="error"),
    ]
    arm = run_a5.aggregate(rows)["arms"]["haiku"]
    assert arm["scored"] == 4 and arm["errors"] == 1
    assert arm["agreement"] == pytest.approx(0.5)
    assert arm["agreement_not_borderline"] == pytest.approx(2 / 3)
    assert arm["pass_agreement"] == pytest.approx(0.5)
    assert arm["wrong_marked_right"] == {"count": 1, "of": 2, "rate": pytest.approx(0.5)}
    assert arm["right_marked_wrong"] == {"count": 1, "of": 2, "rate": pytest.approx(0.5)}
    assert arm["categories"]["keyword_wrong"] == {"n": 1, "agreement": 0.0, "marked_right": 1.0, "mean_fraction": 0.8}
    assert arm["categories"]["right"]["n"] == 2


def test_the_summary_holds_counts_and_never_answer_text():
    rows = [dict(row("full", 1.0), text="Metal moves heat.")]
    summary = run_a5.aggregate(rows)
    assert "Metal moves heat" not in json.dumps(summary)
    assert "Metal moves heat" not in run_a5.render_report(summary, {"label": "t", "date": "2026-01-01"})


def _summary(haiku_agree, haiku_wmr, sonnet_agree, sonnet_wmr):
    def arm(agree, wmr):
        return {"agreement": agree, "wrong_marked_right": {"rate": wmr}}

    return {"arms": {"haiku": arm(haiku_agree, haiku_wmr), "sonnet": arm(sonnet_agree, sonnet_wmr)}}


@pytest.mark.parametrize(
    "scores, pick",
    [
        ((0.80, 0.15, 0.80, 0.05), "sonnet"),  # 10 points fewer wrong answers marked right, same agreement
        ((0.80, 0.10, 0.86, 0.10), "sonnet"),  # 6 points more agreement, no more wrong marked right
        ((0.80, 0.10, 0.80, 0.10), "haiku"),  # no difference: keep the cheaper, faster model
    ],
)
def test_pick_model_switches_to_sonnet_only_for_a_clear_gain(scores, pick):
    assert run_a5.pick_model(_summary(*scores))[0] == pick


@pytest.mark.parametrize("flag, schema, grader_prompt", [("", "ShortAnswerGrade", "v1"), ("grading", "ShortAnswerChecksV2", "v2")])
def test_the_captured_request_follows_the_grading_flag(monkeypatch, flag, schema, grader_prompt):
    from app.config import settings
    from app.services.exam_grader import GRADER_SYSTEM_PROMPT, GRADER_SYSTEM_PROMPT_V2

    monkeypatch.setattr(settings, "PROMPTS_V2", flag)
    dataset = [{"qid": "q01", "question": QUESTION, "answers": [{"n": 0, "text": "Metal moves heat."}]}]
    capture = asyncio.run(run_a5.capture_requests(dataset))
    assert capture.schemas[0].__name__ == schema
    assert capture.messages[0][0].content == (GRADER_SYSTEM_PROMPT_V2 if grader_prompt == "v2" else GRADER_SYSTEM_PROMPT)


# ---------------------------------------------------------------------------- the recall grader arm

RECALL_ENTRY = {
    "pid": "p1",
    "prompt": "Why does a metal spoon feel colder than a wooden one?",
    "claims": [
        {"id": "c1", "concept_name": "Heat", "text": "Metal conducts heat away from the hand faster than wood does.", "quote": "", "page": 3},
        {"id": "c2", "concept_name": "Heat", "text": "Both spoons are at the same temperature.", "quote": "", "page": 3},
    ],
}
RECALL_ANSWER = {
    "n": 0,
    "kind": "full",
    "gradable": True,
    "text": "The metal pulls heat out of your hand much faster than the wood does.",
    "labels": {"c1": "covered", "c2": "missing"},
    "reasoning_gap": {},
}


@pytest.mark.parametrize("flag, schema", [("", "RecallGradeResult"), ("tutor", "RecallGradeResultV2")])
def test_the_captured_recall_requests_follow_the_flag_and_skip_unreadable_answers(monkeypatch, flag, schema):
    from app.config import settings

    monkeypatch.setattr(settings, "PROMPTS_V2", flag)
    unreadable = dict(RECALL_ANSWER, n=1, gradable=False, labels={}, text="idk")
    dataset = [dict(RECALL_ENTRY, answers=[RECALL_ANSWER, unreadable])]
    capture = asyncio.run(run_a5.capture_recall_requests(dataset))
    assert [s.__name__ for s in capture.schemas] == [schema]


def recall_row_for(kind, gradable, status, claims):
    return {"arm": "app", "pid": "p1", "n": 0, "kind": kind, "gradable": gradable, "outcome": "ok", "status": status, "claims": claims}


def claim(expected, verdict, gap_expected=None, gap_got=None):
    return {"expected": expected, "verdict": verdict, "gap_expected": gap_expected, "gap_got": gap_got}


def test_recall_aggregate_counts_agreement_confusion_and_flagged_answers():
    rows = [
        recall_row_for("full", True, "graded", [claim("covered", "covered", True, True), claim("covered", "covered", False, True)]),
        recall_row_for("contradicted", True, "graded", [claim("incorrect", "covered"), claim("covered", "missing")]),
        recall_row_for("full", True, "ungraded", [claim("covered", None), claim("covered", None)]),
        recall_row_for("noise", False, "ungraded", []),
        recall_row_for("noise", False, "graded", []),
    ]
    arm = run_a5.aggregate_recall(rows)["arms"]["app"]
    assert arm["verdict_accuracy"] == {"count": 2, "of": 4, "rate": pytest.approx(0.5)}
    assert (arm["answers_all_right"]["count"], arm["answers_all_right"]["of"]) == (1, 2)
    assert (arm["false_credit"]["count"], arm["false_credit"]["of"]) == (1, 1)
    assert (arm["credit_withheld"]["count"], arm["credit_withheld"]["of"]) == (1, 3)
    assert arm["ungradable_flagged"] == {"count": 1, "of": 2, "rate": pytest.approx(0.5)}
    assert arm["gradable_held_back"] == {"count": 1, "of": 3, "rate": pytest.approx(1 / 3)}
    assert arm["reasoning_gap_agreement"] == {"count": 1, "of": 2, "rate": pytest.approx(0.5)}
    assert arm["confusion"]["incorrect"] == {"covered": 1}
    assert arm["by_kind"]["full"]["of"] == 2

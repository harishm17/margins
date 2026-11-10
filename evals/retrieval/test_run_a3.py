"""Tests for A3's runner: question loading, gold chunks, hit scoring, the excerpt-count rule and the report. No
database, no model, no network."""
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_a3  # noqa: E402

TOPICS = {"t-heat": {"id": "t-heat"}, "t-light": {"id": "t-light"}}


def write_questions(tmp_path, rows):
    path = tmp_path / "questions.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    return path


def test_the_committed_questions_load_against_the_committed_topics():
    questions = run_a3.load_questions(run_a3.QUESTIONS_FILE, run_a3.load_topic_ids())
    assert len(questions) == 38
    assert {q["kind"] for q in questions} == set(run_a3.FOLLOWUP_KINDS)


def test_load_questions_refuses_an_unknown_topic_or_kind(tmp_path):
    base = {"id": "q1", "topic": "t-heat", "first": "Why is metal cold?", "followup": "Why?", "kind": "bare"}
    assert run_a3.load_questions(write_questions(tmp_path, [base]), TOPICS)[0]["id"] == "q1"
    with pytest.raises(SystemExit, match="q1"):
        run_a3.load_questions(write_questions(tmp_path, [dict(base, topic="t-sound")]), TOPICS)
    with pytest.raises(SystemExit, match="q1"):
        run_a3.load_questions(write_questions(tmp_path, [dict(base, kind="vague")]), TOPICS)
    with pytest.raises(SystemExit, match="q1"):
        run_a3.load_questions(write_questions(tmp_path, [dict(base, kind="contrast", also=["t-sound"])]), TOPICS)


def test_a_contrast_followup_counts_either_topics_chunks_as_gold():
    gold = {"t-heat": {"c1", "c2"}, "t-light": {"c9"}}
    question = {"topic": "t-heat", "kind": "contrast", "also": ["t-light"]}
    assert run_a3.gold_for(question, "first", gold) == {"c1", "c2"}
    assert run_a3.gold_for(question, "followup", gold) == {"c1", "c2", "c9"}


def test_score_ranked_finds_the_first_gold_rank():
    assert run_a3.score_ranked(["x", "c2", "c1"], {"c1", "c2"}) == {"hit": True, "first_rank": 2, "found": 3}
    assert run_a3.score_ranked(["x", "y"], {"c1"}) == {"hit": False, "first_rank": None, "found": 2}
    assert run_a3.score_ranked([], {"c1"}) == {"hit": False, "first_rank": None, "found": 0}


def record(k, turn, kind, hit, first_rank=None, found=5):
    return {"id": "q", "turn": turn, "kind": kind, "k": k, "hit": hit, "first_rank": first_rank, "found": found}


def test_aggregate_retrieval_groups_by_count_turn_and_followup_kind():
    records = [
        record(8, "first", "bare", True, 1),
        record(8, "followup", "bare", False, found=0),
        record(8, "first", "leaning", True, 3),
        record(8, "followup", "leaning", True, 5),
    ]
    by_k = run_a3.aggregate_retrieval(records)["by_k"]
    assert by_k[8]["all"] == {"n": 4, "hits": 3, "hit_rate": 0.75, "empty": 1, "empty_rate": 0.25, "mean_first_rank": 3.0}
    assert by_k[8]["first"]["hits"] == 2
    assert by_k[8]["followup"]["hit_rate"] == 0.5
    assert by_k[8]["followup:bare"] == {"n": 1, "hits": 0, "hit_rate": 0.0, "empty": 1, "empty_rate": 1.0, "mean_first_rank": None}


def _sweep(hits_by_k):
    return {"by_k": {k: {"all": {"hits": hits, "n": 76}} for k, hits in hits_by_k.items()}}


@pytest.mark.parametrize(
    "hits_by_k, pick",
    [
        ({8: 60, 12: 60, 20: 61}, 8),  # 8 finds as many as today's 12
        ({8: 59, 12: 60, 20: 60}, 12),  # 8 loses a turn: today's count stays
    ],
)
def test_pick_excerpt_count_is_the_smallest_with_no_drop_from_today(hits_by_k, pick):
    assert run_a3.pick_excerpt_count(_sweep(hits_by_k), today=12)[0] == pick


def test_score_answer_reads_the_cited_chunks_from_the_done_event():
    events = [
        {"type": "retrieved", "count": 3},
        {"type": "text", "delta": "Heat moves."},
        {"type": "done", "text": "Heat moves.", "sources": [{"marker": 1, "chunk_id": "c2"}, {"marker": 2, "chunk_id": "x"}], "stop_reason": "end_turn", "retrieved": 3},
    ]
    assert run_a3.score_answer(200, events, {"c1", "c2"}) == {
        "status": 200,
        "cited": ["c2", "x"],
        "cites": True,
        "cited_hit": True,
        "not_in_materials": False,
        "stop_reason": "end_turn",
        "retrieved": 3,
        "text": "Heat moves.",
    }


def test_aggregate_answers_leaves_errors_out_of_the_rates():
    rows = [
        {"k": 12, "turn": "first", "kind": "bare", "status": 200, "cited_hit": True, "cites": True, "not_in_materials": False, "cost_usd": 0.03},
        {"k": 12, "turn": "followup", "kind": "bare", "status": 200, "cited_hit": False, "cites": False, "not_in_materials": True, "cost_usd": 0.0},
        {"k": 12, "turn": "followup", "kind": "bare", "status": 503, "cited_hit": None, "cites": None, "not_in_materials": None, "cost_usd": 0.0},
    ]
    by_k = run_a3.aggregate_answers(rows)["by_k"]
    assert by_k[12]["all"]["n"] == 2 and by_k[12]["all"]["errors"] == 1
    assert by_k[12]["all"]["cited_hit_rate"] == 0.5
    assert by_k[12]["followup"]["not_in_materials_rate"] == 1.0
    assert by_k[12]["all"]["cost_usd"] == pytest.approx(0.03)


def test_run_a3_leaves_the_module_name_run_eval_to_the_tutoring_eval():
    # CI collects every eval in one session, and the tutoring tests `import run_eval`: their runner, not this folder's.
    loaded = sys.modules.get("run_eval")
    assert getattr(loaded, "__file__", None) is None or Path(loaded.__file__).resolve() != Path(run_a3.HERE) / "run_eval.py"
    assert run_a3.load_chunks.__module__ == "retrieval_run_eval"

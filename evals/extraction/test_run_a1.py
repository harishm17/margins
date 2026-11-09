"""The A1 runner's own logic (run_a1.py): the text arm, costs, the spend cap, the aggregates and the report. No network.
Neutral text only; the committed pages are OpenStax (CC BY 4.0)."""
import os
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pages  # noqa: E402
import run_a1  # noqa: E402
import score  # noqa: E402


def _entry(page_id):
    return next(e for e in pages.load_corpus()["pages"] if e["id"] == page_id)


def test_the_text_arm_reads_a_typed_page_as_the_app_does_and_a_scan_as_nothing():
    corpus = pages.load_corpus()
    typed = run_a1.text_read(corpus, _entry("os-tables-1"))
    assert typed["how"] in ("document", "page") and typed["outcome"] == "ok"
    key = score.parse_markdown(pages.key_path(_entry("os-tables-1")).read_text())
    assert score.score_page(key, score.parse_markdown(typed["markdown"]))["words_dropped"] < 0.3

    scan = run_a1.text_read(corpus, _entry("os-scans-1"))
    assert scan == {"markdown": "", "how": "page", "outcome": "empty"}


def test_a_batched_call_costs_half_the_app_price():
    usage = NS(input_tokens=1_000_000, output_tokens=100_000, cache_read_input_tokens=None, cache_creation_input_tokens=0)
    assert run_a1.batch_cost_usd("claude-sonnet-5-5", usage) == pytest.approx((2.00 + 1.00) / 2)


def test_the_estimate_counts_the_picture_the_prompt_the_text_layer_and_the_answer():
    small = run_a1.estimate_usd("claude-opus-5-5", width=1000, height=1000, prompt_chars=3500, text_chars=0)
    with_text = run_a1.estimate_usd("claude-opus-5-5", width=1000, height=1000, prompt_chars=3500, text_chars=3500)
    tokens_in = 1000 * 1000 / 750 + 1000
    assert small == pytest.approx((tokens_in * 4.00 + run_a1.EST_OUTPUT_TOKENS * 20.00) / 1e6 * run_a1.BATCH_PRICE)
    assert with_text == pytest.approx(small + 1000 * 4.00 / 1e6 * run_a1.BATCH_PRICE)


def test_a_run_whose_estimate_passes_the_cap_is_refused():
    run_a1.check_cap(estimate=2.0, spent=1.0, max_usd=3.5)
    with pytest.raises(SystemExit, match="cap"):
        run_a1.check_cap(estimate=2.0, spent=2.0, max_usd=3.5)


def _record(page_id, cls, arm, outcome="ok", **scores):
    full = {name: None for name in score.SCORES}
    full.update(scores)
    return {"id": page_id, "class": cls, "arm": arm, "outcome": outcome, "usd": 0.01, "scores": None if outcome.startswith("error") else full}


def test_scores_are_averaged_per_class_and_arm_over_the_pages_that_have_them():
    records = [
        _record("t1", "tables", "haiku", table_cells=1.0, words_dropped=0.0),
        _record("t2", "tables", "haiku", table_cells=0.5, words_dropped=0.2),
        _record("m1", "maths", "haiku", formulas_exact=0.25, words_dropped=0.1),
        _record("t1", "tables", "text", table_cells=0.0, words_dropped=0.4),
        _record("t2", "tables", "text", outcome="error: overloaded"),
    ]
    summary = run_a1.aggregate(records)
    haiku_tables = summary["by_class"]["tables"]["haiku"]
    assert haiku_tables["table_cells"] == pytest.approx(0.75) and haiku_tables["pages"] == 2
    assert haiku_tables["formulas_exact"] is None
    assert summary["by_class"]["tables"]["text"]["pages"] == 1
    assert summary["by_class"]["all"]["haiku"]["words_dropped"] == pytest.approx(0.1)
    assert summary["outcomes"]["text"] == {"ok": 1, "error: overloaded": 1}
    assert summary["usd"]["haiku"] == pytest.approx(0.03)


def test_a_read_that_stopped_or_broke_is_scored_as_an_empty_read():
    key = score.parse_markdown("# Title\n\nSome words here.")
    assert run_a1.scores_for(key, "", "max_tokens")["words_dropped"] == 1.0
    assert run_a1.scores_for(key, "", "error: overloaded") is None


def test_the_report_shows_each_class_by_arm_and_the_cost_and_no_page_text():
    records = [
        _record("t1", "tables", "text", table_cells=0.0, words_dropped=0.4),
        _record("t1", "tables", "haiku", table_cells=1.0, words_dropped=0.0),
    ]
    summary = run_a1.aggregate(records)
    summary["run"] = {"label": "a1", "date": "2026-11-09", "commit": "abc1234", "arms": {"text": None, "haiku": "claude-haiku-5-5"}}
    report = run_a1.render_report(summary)
    assert "## tables" in report and "| Table cells found | 0% | 100% |" in report
    assert "| Words dropped (lower is better) | 40% | 0% |" in report
    assert "$0.01" in report and "t1" in report

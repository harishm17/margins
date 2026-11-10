"""Tests for the spend gate. No database, no model, no network."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from spend import GENERATION, JUDGE, SpendLimitReached, SpendTracker  # noqa: E402


def cost_fn(model, input_tokens, output_tokens, cache_write_tokens):
    """$1 per million input, $10 per million output, $2 per million cache write."""
    if model == "unpriced":
        return None
    return (input_tokens * 1 + output_tokens * 10 + cache_write_tokens * 2) / 1_000_000


def test_estimate_prices_input_as_plain_input_and_uses_default_output():
    tracker = SpendTracker(10, 3, cost_fn)
    # 100k prompt tokens at $1/M = $0.10; default 6000 output tokens (solved_examples) at $10/M = $0.06
    assert tracker.estimate_call("m", "solved_examples", 100_000) == pytest.approx(0.16)
    assert tracker.estimate_call("unpriced", "solved_examples", 100_000) == 0.0


def test_reserve_refuses_a_call_that_would_pass_the_cap():
    tracker = SpendTracker(0.30, 3, cost_fn)
    token, _ = tracker.reserve(GENERATION, "m", "section_notes", 20_000)  # $0.02 + $0.04
    tracker.settle(token, "m", "section_notes", 0.25, output_tokens=None)
    with pytest.raises(SpendLimitReached) as stop:
        tracker.reserve(GENERATION, "m", "section_notes", 20_000)  # 0.25 + 0.08 > 0.30
    assert stop.value.kind == GENERATION
    assert GENERATION in tracker.stops
    assert tracker.total_spent == pytest.approx(0.25)


def test_calls_in_flight_count_against_the_cap():
    tracker = SpendTracker(0.15, 3, cost_fn)
    tracker.reserve(GENERATION, "m", "section_notes", 20_000)  # estimate 0.06, not settled yet
    tracker.reserve(GENERATION, "m", "section_notes", 20_000)  # 0.12 reserved
    with pytest.raises(SpendLimitReached):
        tracker.reserve(GENERATION, "m", "section_notes", 20_000)  # 0.18 > 0.15


def test_judge_cap_is_separate_and_does_not_stop_generation():
    tracker = SpendTracker(10, 0.10, cost_fn)
    token, _ = tracker.reserve(JUDGE, "m", "judge", 5_000)  # 0.01 + 0.08
    tracker.settle(token, "m", "judge", 0.09, output_tokens=None)
    with pytest.raises(SpendLimitReached) as stop:
        tracker.reserve(JUDGE, "m", "judge", 5_000)
    assert stop.value.kind == JUDGE and stop.value.cap == 0.10
    tracker.reserve(GENERATION, "m", "section_notes", 5_000)  # generation is unaffected
    assert set(tracker.stops) == {JUDGE}


def test_total_cap_covers_judge_and_generation_together():
    tracker = SpendTracker(0.50, 3, cost_fn)
    tracker.add_past_spend(GENERATION, 0.45)
    with pytest.raises(SpendLimitReached):
        tracker.reserve(JUDGE, "m", "judge", 5_000)
    assert tracker.total_spent == pytest.approx(0.45)


def test_past_spend_from_an_earlier_run_counts():
    tracker = SpendTracker(1.0, 3, cost_fn)
    tracker.add_past_spend(GENERATION, 0.99)
    with pytest.raises(SpendLimitReached):
        tracker.reserve(GENERATION, "m", "topic_quiz", 5_000)



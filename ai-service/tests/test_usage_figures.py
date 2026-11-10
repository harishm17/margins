"""The figures one billed piece of work writes (A4): the ledger row, with cache reads and writes kept apart from the
input they are part of, and a job's usage summary, split by purpose so the calls inside one job can be told apart."""
import pytest

from app.services.chat import _add_usage, usage_payload
from app.services.llm.base import LLMUsage
from app.services.llm.usage import estimate_cost_usd, ledger_figures, summarize_usage

OPUS = "claude-opus-5-5"
HAIKU = "claude-haiku-5-5"


def call(purpose="", model=OPUS, fresh=0, out=0, read=0, write=0):
    return LLMUsage(
        model=model, purpose=purpose, input_tokens=fresh, output_tokens=out,
        cache_read_input_tokens=read, cache_creation_input_tokens=write,
    )


def test_ledger_figures_count_cache_tokens_as_input_and_give_them_apart():
    usages = [call("tutor", fresh=1000, out=100, read=8000), call("leak_check", model=HAIKU, fresh=500, out=10, write=2000)]
    figures = ledger_figures(usages)
    assert figures["models"] == f"{HAIKU},{OPUS}"
    assert figures["input_tokens"] == 1000 + 8000 + 500 + 2000
    assert figures["output_tokens"] == 110
    assert (figures["cache_read_tokens"], figures["cache_write_tokens"]) == (8000, 2000)
    assert figures["cost_usd"] == pytest.approx(sum(estimate_cost_usd(u) for u in usages), abs=1e-6)


def test_ledger_figures_of_no_calls_are_zero():
    assert ledger_figures([]) == {
        "models": "", "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0.0,
    }


def test_a_job_summary_keeps_its_totals_and_splits_them_by_purpose():
    usages = [
        call("topic_quiz", fresh=100, out=50, read=900),
        call("topic_quiz", fresh=100, out=40, write=900),
        call("support_check", model=HAIKU, fresh=300, out=5),
    ]
    summary = summarize_usage(usages)
    assert (summary["calls"], summary["input_tokens"], summary["cache_read_input_tokens"]) == (3, 500, 900)
    by_purpose = summary["by_purpose"]
    assert set(by_purpose) == {"topic_quiz", "support_check"}
    quiz = by_purpose["topic_quiz"]
    assert (quiz["calls"], quiz["models"], quiz["output_tokens"]) == (2, [OPUS], 90)
    assert (quiz["cache_read_input_tokens"], quiz["cache_creation_input_tokens"]) == (900, 900)
    assert by_purpose["support_check"]["models"] == [HAIKU]
    assert sum(p["estimated_cost_usd"] for p in by_purpose.values()) == pytest.approx(summary["estimated_cost_usd"], abs=2e-6)
    assert "by_purpose" not in quiz


def test_a_call_without_a_purpose_is_grouped_as_unnamed():
    assert set(summarize_usage([call(fresh=10, out=1)])["by_purpose"]) == {"unnamed"}


def test_an_ask_reply_carries_its_cache_reads_and_writes_and_they_add_up():
    first = usage_payload(call("chat", fresh=1000, out=100, read=6000, write=0))
    assert (first["input_tokens"], first["cache_read_tokens"], first["cache_write_tokens"]) == (7000, 6000, 0)
    routed = usage_payload(call("chat_route", model=HAIKU, fresh=200, out=5, write=300))
    total = _add_usage(routed, first)
    assert (total["input_tokens"], total["cache_read_tokens"], total["cache_write_tokens"]) == (7500, 6000, 300)
    assert usage_payload(None)["cache_read_tokens"] == 0 and usage_payload(None)["cache_write_tokens"] == 0
    # A total from before the cache figures existed still adds up.
    assert _add_usage({"model": OPUS, "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.0}, first)["cache_read_tokens"] == 6000

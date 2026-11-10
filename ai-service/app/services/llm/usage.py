"""Collect token usage per job so cost can be stored and capped."""
from contextlib import contextmanager
from contextvars import ContextVar
from itertools import groupby
from typing import Dict, Generator, List, Optional, Sequence, TypedDict

from app.services.llm.base import LLMUsage

_collector: ContextVar[Optional[List[LLMUsage]]] = ContextVar("llm_usage_collector", default=None)

# USD per million tokens: (input, output, cache read, cache write).
# Cache writes use the 5-minute TTL rate (1.25x input).
_PRICES: Dict[str, tuple[float, float, float, float]] = {
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
}


def record_usage(usage: LLMUsage) -> None:
    collector = _collector.get()
    if collector is not None:
        collector.append(usage)


@contextmanager
def track_llm_usage() -> Generator[List[LLMUsage]]:
    """Collect every call made inside the block (including concurrent tasks it starts)."""
    collected: List[LLMUsage] = []
    token = _collector.set(collected)
    try:
        yield collected
    finally:
        _collector.reset(token)


def estimate_cost_usd(usage: LLMUsage) -> Optional[float]:
    prices = _PRICES.get(usage.model)
    if prices is None:
        return None
    input_price, output_price, cache_read_price, cache_write_price = prices
    total = (
        usage.input_tokens * input_price
        + usage.output_tokens * output_price
        + usage.cache_read_input_tokens * cache_read_price
        + usage.cache_creation_input_tokens * cache_write_price
    )
    return total / 1_000_000


def summarize_usage(usages: List[LLMUsage]) -> Dict[str, object]:
    """Totals for a job's result_data, and the same totals for each purpose (a call with none is "unnamed"), so the
    calls inside one job (the writing call and its checks, say) can be told apart (A4)."""
    def purpose(usage: LLMUsage) -> str:
        return usage.purpose or "unnamed"

    by_purpose = {name: _totals(list(group)) for name, group in groupby(sorted(usages, key=purpose), key=purpose)}
    return {**_totals(usages), "by_purpose": by_purpose}


class LedgerFigures(TypedDict):
    models: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float


def ledger_figures(usages: Sequence[LLMUsage]) -> LedgerFigures:
    """The figures of one ledger row (`budget.record_usage_event`) for the calls of one billed piece of work: a job
    attempt, a tutor or grading reply, a voice turn. Input counts cache reads and writes, as the API bills them; they
    are also given apart (A4)."""
    cost = sum(c for c in (estimate_cost_usd(u) for u in usages) if c is not None)
    return LedgerFigures(
        models=",".join(sorted({u.model for u in usages})),
        input_tokens=sum(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens for u in usages),
        output_tokens=sum(u.output_tokens for u in usages),
        cache_read_tokens=sum(u.cache_read_input_tokens for u in usages),
        cache_write_tokens=sum(u.cache_creation_input_tokens for u in usages),
        cost_usd=round(cost, 6),
    )


def _totals(usages: Sequence[LLMUsage]) -> Dict[str, object]:
    costs = [estimate_cost_usd(u) for u in usages]
    known_costs = [c for c in costs if c is not None]
    return {
        "calls": len(usages),
        "models": sorted({u.model for u in usages}),
        "input_tokens": sum(u.input_tokens for u in usages),
        "output_tokens": sum(u.output_tokens for u in usages),
        "cache_read_input_tokens": sum(u.cache_read_input_tokens for u in usages),
        "cache_creation_input_tokens": sum(u.cache_creation_input_tokens for u in usages),
        "estimated_cost_usd": round(sum(known_costs), 6) if known_costs else None,
    }

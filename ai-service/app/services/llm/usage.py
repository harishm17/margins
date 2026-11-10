"""Token usage: collected per job for its totals, and handed to the billing scope (app/services/billing.py) call by
call so every call reaches the ledger."""
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from itertools import groupby
from typing import Dict, Generator, List, Optional, Protocol, Sequence, TypedDict

from app.services.llm.base import LLMUsage

logger = logging.getLogger(__name__)

_collector: ContextVar[Optional[List[LLMUsage]]] = ContextVar("llm_usage_collector", default=None)


class UsageSink(Protocol):
    """The billing provider's record of one call (billing.py)."""

    def add(self, usage: LLMUsage) -> None: ...

    def partial(self, usage: LLMUsage) -> None: ...


# Set by the billing provider around each call it makes.
_billing_sink: ContextVar[Optional[UsageSink]] = ContextVar("llm_billing_sink", default=None)

# USD per million tokens: (input, output, cache read, cache write).
# Cache writes use the 5-minute TTL rate (1.25x input).
_PRICES: Dict[str, tuple[float, float, float, float]] = {
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
}


def record_usage(usage: LLMUsage, *, bill: bool = True) -> None:
    """Providers call this the moment a call's usage is known (also when the call then fails). The job's collector
    keeps it for the job row; the billing scope writes it to the ledger. `bill=False` is for a provider that repeats
    usage an inner provider already reported (the replay provider recording a real call)."""
    collector = _collector.get()
    if collector is not None:
        collector.append(usage)
    sink = _billing_sink.get()
    if bill and sink is not None:
        sink.add(usage)


def note_partial_usage(usage: LLMUsage) -> None:
    """A stream reports what it has seen of its usage so far (the input tokens at its first event, the output tokens
    as they grow), so a stream that is cut off is billed for that instead of nothing. A final `record_usage` wins."""
    sink = _billing_sink.get()
    if sink is not None:
        sink.partial(usage)


@contextmanager
def billing_sink(sink: UsageSink) -> Generator[None]:
    """Route the usage recorded inside the block to `sink` (the billing provider's one call)."""
    token = _billing_sink.set(sink)
    try:
        yield
    finally:
        try:
            _billing_sink.reset(token)
        except ValueError:  # an abandoned stream closed from another task: its context is gone with it
            pass


@contextmanager
def track_llm_usage() -> Generator[List[LLMUsage]]:
    """Collect every call made inside the block (including concurrent tasks it starts)."""
    collected: List[LLMUsage] = []
    token = _collector.set(collected)
    try:
        yield collected
    finally:
        _collector.reset(token)


_priciest = tuple(max(prices[i] for prices in _PRICES.values()) for i in range(4))
_unpriced_logged: set[str] = set()


def has_price(model: str) -> bool:
    return model in _PRICES


def estimate_cost_usd(usage: LLMUsage) -> float:
    """What the call cost. A model with no price is billed at the most expensive known price, never $0, and logged
    once (the start-up check in app/config.py keeps every configured model priced, so this is a stray response.model)."""
    prices = _PRICES.get(usage.model)
    if prices is None:
        if usage.model not in _unpriced_logged:
            _unpriced_logged.add(usage.model)
            logger.error("No price for model %r: billing its calls at the most expensive known price", usage.model)
        prices = _priciest
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
    cost = sum(estimate_cost_usd(u) for u in usages)
    return LedgerFigures(
        models=",".join(sorted({u.model for u in usages})),
        input_tokens=sum(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens for u in usages),
        output_tokens=sum(u.output_tokens for u in usages),
        cache_read_tokens=sum(u.cache_read_input_tokens for u in usages),
        cache_write_tokens=sum(u.cache_creation_input_tokens for u in usages),
        cost_usd=round(cost, 6),
    )


def _totals(usages: Sequence[LLMUsage]) -> Dict[str, object]:
    return {
        "calls": len(usages),
        "models": sorted({u.model for u in usages}),
        "input_tokens": sum(u.input_tokens for u in usages),
        "output_tokens": sum(u.output_tokens for u in usages),
        "cache_read_input_tokens": sum(u.cache_read_input_tokens for u in usages),
        "cache_creation_input_tokens": sum(u.cache_creation_input_tokens for u in usages),
        "estimated_cost_usd": round(sum(estimate_cost_usd(u) for u in usages), 6) if usages else None,
    }

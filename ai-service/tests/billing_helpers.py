"""A provider that reports the usage a test scripts, put behind the real billing provider, so tests see the ledger
rows and allowance checks that production calls get."""
from typing import Any, List, Union

from app.services.billing import BillingProvider
from app.services.llm.base import LLMProvider, LLMResponse, LLMUsage
from app.services.llm.factory import LLMFactory
from app.services.llm.usage import record_usage


class UsageProvider(LLMProvider):
    """Each call takes the next entry of `script`: a usage (or a list of them) to report and return from, or an
    exception to report the listed usage for and raise (`(usage, exc)`). Past the end, calls report nothing."""

    def __init__(self, *script: Union[LLMUsage, List[LLMUsage], BaseException, tuple]):
        self.script = list(script)
        self.calls = 0

    async def generate_text(self, messages, *, purpose, max_tokens=16000) -> LLMResponse:
        self.calls += 1
        entry = self.script.pop(0) if self.script else []
        error = None
        if isinstance(entry, tuple):
            entry, error = entry
        if isinstance(entry, BaseException):
            entry, error = [], entry
        for usage in entry if isinstance(entry, list) else [entry]:
            record_usage(usage.model_copy(update={"purpose": purpose}))
        if error is not None:
            raise error
        return LLMResponse(content="ok", model="m", stop_reason="end_turn", usage=LLMUsage(model="m", purpose=purpose))

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000) -> Any:
        raise NotImplementedError

    def stream_cited_answer(self, **kwargs):
        raise NotImplementedError

    def stream_turn(self, **kwargs):
        raise NotImplementedError


def install_billed(monkeypatch, inner: LLMProvider) -> BillingProvider:
    """Make `LLMFactory.get_provider()` return the billing provider around `inner` for this test."""
    provider = BillingProvider(inner)
    monkeypatch.setattr(LLMFactory, "_instance", provider)
    return provider

"""The provider every caller gets: the configured one, reporting each call's outcome to the
shared AI status (app/services/ai_status.py).

Wrapping the provider, rather than each caller, means every model call (jobs, chat, voice turns,
drills, grading) feeds the same status, and a new call site cannot forget to.
"""
from typing import Any, AsyncIterator, List, Optional, Type

from app.services import ai_status
from app.services.llm.base import (
    AnswerEvent,
    LLMError,
    LLMMessage,
    LLMProvider,
    LLMResponse,
    SchemaT,
    TurnEvent,
)


class ObservedProvider(LLMProvider):
    def __init__(self, inner: LLMProvider):
        self.inner = inner

    def __getattr__(self, name: str) -> Any:
        # Anything else (the SDK client, test hooks) is the wrapped provider's.
        return getattr(self.inner, name)

    def model_for(self, purpose: str) -> Optional[str]:
        return self.inner.model_for(purpose)

    async def generate_text(
        self, messages: List[LLMMessage], *, purpose: str, max_tokens: int = 16000
    ) -> LLMResponse:
        try:
            response = await self.inner.generate_text(messages, purpose=purpose, max_tokens=max_tokens)
        except LLMError as exc:
            await ai_status.record_failure(exc)
            raise
        await ai_status.record_success()
        return response

    async def generate_structured(
        self, messages: List[LLMMessage], schema: Type[SchemaT], *, purpose: str, max_tokens: int = 16000
    ) -> SchemaT:
        try:
            result = await self.inner.generate_structured(
                messages, schema, purpose=purpose, max_tokens=max_tokens
            )
        except LLMError as exc:
            await ai_status.record_failure(exc)
            raise
        await ai_status.record_success()
        return result

    async def stream_cited_answer(self, **kwargs: Any) -> AsyncIterator[AnswerEvent]:
        try:
            async for event in self.inner.stream_cited_answer(**kwargs):
                yield event
        except LLMError as exc:
            await ai_status.record_failure(exc)
            raise
        await ai_status.record_success()

    async def stream_turn(self, **kwargs: Any) -> AsyncIterator[TurnEvent]:
        try:
            async for event in self.inner.stream_turn(**kwargs):
                yield event
        except LLMError as exc:
            await ai_status.record_failure(exc)
            raise
        await ai_status.record_success()

"""Placeholder provider for local runs and end-to-end tests: no API calls, no cost."""
import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Type

from app.services.llm.base import (
    LLMAuthError,
    LLMCreditError,
    LLMError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMUnavailableError,
    AnswerCitation,
    AnswerDone,
    AnswerEvent,
    AnswerText,
    Excerpt,
    LLMMessage,
    LLMOutputError,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    SchemaT,
    TurnDone,
    TurnEvent,
    TurnText,
    TurnToolUse,
)
from app.config import settings
from app.services.llm.limiter import llm_slot
from app.services.llm.models import PURPOSES
from app.services.llm.usage import record_usage

logger = logging.getLogger(__name__)

MOCK_NOTES = """# Study notes (mock)

## Overview
This is placeholder text: the sections below follow the lesson format the real notes use.

## What you'll learn
- Tell what the mock provider does and does not do.
- Find where to switch to a real model.

## The idea
LLM_PROVIDER is set to `mock`, so these notes were not written by a model. They stand in
for real notes so that the rest of the app can be exercised without an API key or any cost.

## Key concepts
- Upload, validation, chunking, embedding and retrieval ran for real on your files.
- The course plan, quizzes, exams and grading return placeholder output.
- Every job still goes through the real job runner, so retries, leases and usage tracking work.

## Worked example
The mock provider returns a fixed example for each output schema and this text for notes.
It records zero token usage, so the daily budget is never reached.

## Check yourself
```check
Q: Which setting turns the mock provider on?
A: Set `LLM_PROVIDER=mock`.
```

## Common pitfalls
- Placeholder questions are the same for every topic.
- Short answers are always graded zero.

## Summary
- Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to generate real content.
- Run `scripts/reembed_chunks.py` after changing the embedding model.
"""


def _first_paragraph(text: str) -> str:
    """The first paragraph that is more than a heading line, or the first one."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    for paragraph in paragraphs:
        if not paragraph.startswith("#") or "\n" in paragraph:
            return paragraph
    return paragraphs[0] if paragraphs else text.strip()


def _first_sentence(text: str, limit: int = 220) -> str:
    body = "\n".join(line for line in _first_paragraph(text).splitlines() if not line.startswith("#"))
    flat = re.sub(r"\s+", " ", body or text).strip()
    match = re.search(r"[.!?](\s|$)", flat)
    sentence = flat[: match.end()].strip() if match else flat
    return sentence if len(sentence) <= limit else sentence[: limit - 1].rstrip() + "..."


def _blocks(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [block for block in content or [] if isinstance(block, dict)]


def _tool_calls(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every tool_use block in the conversation, oldest first."""
    return [
        block
        for message in messages
        if message.get("role") == "assistant"
        for block in _blocks(message)
        if block.get("type") == "tool_use"
    ]


def _latest_question_index(messages: List[Dict[str, Any]], call: Dict[str, Any], default: int) -> int:
    """The question_index in the tool result for `call` (a get_next_question), or `default`."""
    for message in messages:
        for block in _blocks(message):
            if block.get("type") == "tool_result" and block.get("tool_use_id") == call.get("id"):
                content = block.get("content")
                if isinstance(content, list):
                    content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                try:
                    index = json.loads(content or "{}").get("question_index")
                except (TypeError, ValueError, AttributeError):
                    return default
                return index if isinstance(index, int) else default
    return default


def _mock_turn(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> tuple[str, Optional[Dict[str, Any]]]:
    """(text, tool call) for the next reply: deterministic, driven only by the conversation.

    With tools: the first turn asks for a question (get_next_question); the next plain user
    message is treated as the answer (record_answer for the latest question); a tool result is
    answered with one short sentence. Without tools it is a short scripted reply.
    """
    last = _blocks(messages[-1]) if messages else []
    results = [block for block in last if block.get("type") == "tool_result"]
    available = {tool.get("name") for tool in tools}
    calls = _tool_calls(messages)

    if results:
        called = {call.get("id"): call for call in calls}
        call = called.get(results[-1].get("tool_use_id"), {})
        name = call.get("name")
        output = str(results[-1].get("content") or "")
        if '"done": true' in output or '"done":true' in output:
            return "That was the last question. Well done, and goodbye.", None
        if name == "get_next_question":
            return "Here is your question. Take your time and answer out loud.", None
        if name == "record_answer":
            return "Thanks, I have noted that. Say next when you are ready for another question.", None
        if name == "get_hint":
            return "Here is a nudge. Think about how the key ideas connect.", None
        return "Okay.", None

    utterance = " ".join(block.get("text", "") for block in last if block.get("type") == "text").strip()
    if "get_next_question" in available:
        asked = [call for call in calls if call.get("name") == "get_next_question"]
        recorded = [call for call in calls if call.get("name") == "record_answer"]
        if asked and len(recorded) < len(asked):
            return "", {
                "name": "record_answer",
                "input": {"question_index": _latest_question_index(messages, asked[-1], len(recorded)),
                          "user_answer": utterance or "no answer"},
            }
        return "", {"name": "get_next_question", "input": {}}
    if utterance and not utterance.startswith("["):
        return f"Mock coach here. You said: {utterance[:80]}. Tell me more.", None
    return "Hi, I am your mock coach. What would you like to talk about?", None


# End-to-end tests make the mock fail like the real API by putting "MOCK_LLM_FAIL:<code>" in a
# prompt (a question, a topic name). Only the mock reads it; the real provider never sees it.
_FAILURE_MARKER = re.compile(r"MOCK_LLM_FAIL:([A-Z_]+)")
_SIMULATED_FAILURES: Dict[str, type] = {
    LLMCreditError.code: LLMCreditError,
    LLMAuthError.code: LLMAuthError,
    LLMRateLimitError.code: LLMRateLimitError,
    LLMUnavailableError.code: LLMUnavailableError,
    LLMRefusalError.code: LLMRefusalError,
    LLMOutputError.code: LLMOutputError,
}


def _raise_if_asked(*texts: str) -> None:
    for text in texts:
        match = _FAILURE_MARKER.search(text or "")
        if match:
            error_type = _SIMULATED_FAILURES.get(match.group(1), LLMError)
            raise error_type(f"Simulated by the mock provider ({match.group(1)})")


class MockProvider(LLMProvider):
    """Returns each schema's `example()` and fixed markdown, and records zero usage."""

    def model_for(self, purpose: str) -> str:
        config = PURPOSES.get(purpose)
        return f"mock-{config.fallback_tier if config else 'main'}"

    async def _simulate_call(self) -> None:
        """The model call itself, which takes MOCK_LLM_LATENCY_SECONDS (none by default). Tests
        override it to fail or to watch how many calls run at once."""
        if settings.MOCK_LLM_LATENCY_SECONDS > 0:
            await asyncio.sleep(settings.MOCK_LLM_LATENCY_SECONDS)

    async def generate_text(
        self,
        messages: List[LLMMessage],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> LLMResponse:
        _raise_if_asked(*(message.content for message in messages))
        async with llm_slot():
            await self._simulate_call()
        usage = LLMUsage(model=self.model_for(purpose), purpose=purpose)
        record_usage(usage)
        return LLMResponse(content=MOCK_NOTES, model=usage.model, stop_reason="end_turn", usage=usage)

    async def generate_structured(
        self,
        messages: List[LLMMessage],
        schema: Type[SchemaT],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> SchemaT:
        example = getattr(schema, "example", None)
        if example is None:
            raise LLMOutputError(f"MockProvider has no example for {schema.__name__}")
        _raise_if_asked(*(message.content for message in messages))
        async with llm_slot():
            await self._simulate_call()
        record_usage(LLMUsage(model=self.model_for(purpose), purpose=purpose))
        # A schema whose valid output depends on the request (the course planner must place the
        # sections it was given) builds its example from the prompt.
        example_for = getattr(schema, "example_for", None)
        if example_for is not None:
            return example_for("\n".join(message.content for message in messages))
        return example()

    async def stream_cited_answer(
        self,
        *,
        system: str,
        history: List[LLMMessage],
        question: str,
        excerpts: List[Excerpt],
        max_tokens: int = 4000,
        purpose: str = "chat",
    ) -> AsyncIterator[AnswerEvent]:
        """A fixed-shape answer that quotes the first two excerpts and cites each."""
        if not excerpts:
            raise LLMOutputError("The mock provider needs at least one excerpt")
        _raise_if_asked(question)
        async with llm_slot():  # the wait for the first token
            await self._simulate_call()
        parts: List[tuple[str, Optional[Excerpt]]] = [
            (f"Mock answer to \"{question[:80]}\" (LLM_PROVIDER is mock, no model was called). ", None)
        ]
        for index, excerpt in enumerate(excerpts[:2]):
            lead = "The materials say: " if index == 0 else " It also covers: "
            parts.append((f"{lead}{_first_sentence(excerpt.text)}", excerpt))

        text = ""
        citations: List[AnswerCitation] = []
        for chunk, excerpt in parts:
            for word in re.findall(r"\s*\S+\s*", chunk):
                text += word
                yield AnswerText(text=word)
                await asyncio.sleep(0.005)
            if excerpt is not None:
                citation = AnswerCitation(
                    ref=excerpt.ref,
                    cited_text=_first_paragraph(excerpt.text),
                    start_block_index=0,
                    end_block_index=1,
                    offset=len(text),
                )
                citations.append(citation)
                yield citation

        usage = LLMUsage(model=self.model_for(purpose), purpose=purpose)
        record_usage(usage)
        yield AnswerDone(text=text, citations=citations, stop_reason="end_turn", usage=usage)

    async def stream_turn(
        self,
        *,
        system: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        max_tokens: int = 800,
        purpose: str = "voice",
    ) -> AsyncIterator[TurnEvent]:
        """A scripted reply (see _mock_turn). Reports a few nominal tokens, at no cost."""
        _raise_if_asked(system, json.dumps(messages))
        async with llm_slot():  # the wait for the first token
            await self._simulate_call()
        text, call = _mock_turn(messages, tools)
        content: List[Dict[str, Any]] = []
        if text:
            for word in re.findall(r"\s*\S+\s*", text):
                yield TurnText(text=word)
                await asyncio.sleep(0.005)
            content.append({"type": "text", "text": text})
        if call is not None:
            tool_id = f"toolu_mock_{sum(1 for m in messages if m.get('role') == 'assistant') + 1}"
            content.append({"type": "tool_use", "id": tool_id, "name": call["name"], "input": call["input"]})
            yield TurnToolUse(id=tool_id, name=call["name"], input=call["input"])

        # Nominal counts so the usage ledger gets a row; the model name is unpriced, so it costs $0.
        usage = LLMUsage(model=self.model_for(purpose), purpose=purpose, input_tokens=100, output_tokens=20)
        record_usage(usage)
        yield TurnDone(
            stop_reason="tool_use" if call is not None else "end_turn", content=content, usage=usage
        )

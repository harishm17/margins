"""Claude (Anthropic API) provider."""
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Type

import anthropic
from anthropic import AsyncAnthropic
from pydantic import ValidationError

from app.services.llm.base import (
    AnswerCitation,
    AnswerDone,
    AnswerEvent,
    AnswerReset,
    AnswerText,
    Excerpt,
    LLMAuthError,
    LLMCreditError,
    LLMError,
    LLMMessage,
    LLMNotConfiguredError,
    LLMOutputError,
    LLMProvider,
    LLMRateLimitError,
    LLMRefusalError,
    LLMRequestError,
    LLMResponse,
    LLMUnavailableError,
    LLMUsage,
    SchemaT,
    TurnDone,
    TurnEvent,
    TurnText,
    TurnToolUse,
)
from app.services.llm.limiter import llm_slot
from app.services.llm.models import resolve_model
from app.services.llm.usage import estimate_cost_usd, note_partial_usage, record_usage
from app.validation_errors import describe_validation_error

logger = logging.getLogger(__name__)

# Models that accept the server-side refusal fallback. On a safety decline the API
# re-runs the request on Anthropic's recommended fallback model inside the same call.
_SERVER_FALLBACK_PREFIXES = ("claude-opus-5", "claude-sonnet-5-5", "claude-fable-5")
_SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _supports_server_fallback(model: str) -> bool:
    return model.startswith(_SERVER_FALLBACK_PREFIXES)


def _text_block(text: str, cache: bool) -> Dict[str, Any]:
    block: Dict[str, Any] = {"type": "text", "text": text}
    if cache:
        block["cache_control"] = {"type": "ephemeral"}
    return block


def _to_request_messages(
    messages: List[LLMMessage],
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split into (system blocks, conversation), merging consecutive turns of the same role."""
    system: List[Dict[str, Any]] = []
    conversation: List[Dict[str, Any]] = []
    for message in messages:
        if not message.content:
            continue
        if message.role == "system":
            system.append(_text_block(message.content, message.cache))
            continue
        role = "assistant" if message.role == "assistant" else "user"
        block = _text_block(message.content, message.cache)
        if conversation and conversation[-1]["role"] == role:
            conversation[-1]["content"].append(block)
        else:
            conversation.append({"role": role, "content": [block]})

    # Only what a message marks with `cache` is cached (the breakpoint covers the system prompt
    # before it): a first generation writes nothing, a regeneration caches its excerpts.
    return system, conversation


def _final_text(content: List[Any]) -> str:
    """Text written by the model that produced the answer.

    When a server-side fallback runs, the declined model's partial output comes before
    the `fallback` block; only the text after the last one is the answer.
    """
    start = 0
    for index, block in enumerate(content):
        if getattr(block, "type", None) == "fallback":
            start = index + 1
    return "".join(
        block.text for block in content[start:] if getattr(block, "type", None) == "text"
    ).strip()


# Excerpts are sent as several text blocks, one paragraph each, because Claude cites whole
# blocks: one block per chunk would make every citation quote the entire chunk.
_BLOCK_TARGET_CHARS = 450
# A paragraph longer than this is split at sentence boundaries into blocks near the target.
_BLOCK_MAX_CHARS = 600
_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")
_HEADING_LINE = re.compile(r"^#{1,6}[ \t]+\S[^\n]*$")


def _split_long_paragraph(paragraph: str, target_chars: int) -> List[str]:
    pieces: List[str] = []
    current = ""
    for sentence in _SENTENCE_BREAK.split(paragraph):
        if current and len(current) + 1 + len(sentence) > target_chars:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}" if current else sentence
    if current:
        pieces.append(current)
    return pieces


def split_excerpt_blocks(
    text: str, target_chars: int = _BLOCK_TARGET_CHARS, max_chars: int = _BLOCK_MAX_CHARS
) -> List[str]:
    """Split text into citable blocks, one paragraph each; never returns an empty list.

    A heading line is kept with the paragraph that follows it. A paragraph longer than
    `max_chars` is split at sentence boundaries into blocks of about `target_chars` (a single
    sentence is never cut). Short paragraphs are not merged: a citation should quote the
    paragraph that supports the claim, not its neighbours.
    """
    cleaned = text.strip()
    if not cleaned:
        return [text or " "]

    blocks: List[str] = []
    heading = ""
    for paragraph in _PARAGRAPH_BREAK.split(cleaned):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if _HEADING_LINE.match(paragraph):
            # Two headings in a row stay together, then go with the next paragraph.
            heading = f"{heading}\n\n{paragraph}" if heading else paragraph
            continue
        if heading:
            paragraph = f"{heading}\n\n{paragraph}"
            heading = ""
        if len(paragraph) > max_chars:
            blocks.extend(_split_long_paragraph(paragraph, target_chars))
        else:
            blocks.append(paragraph)
    if heading:  # a heading with nothing after it
        blocks.append(heading)
    return blocks


def _search_result_block(excerpt: Excerpt) -> Dict[str, Any]:
    return {
        "type": "search_result",
        "source": excerpt.ref,
        "title": excerpt.title,
        "content": [{"type": "text", "text": block} for block in split_excerpt_blocks(excerpt.text)],
        "citations": {"enabled": True},
    }


def _answer_conversation(
    history: List[LLMMessage], question: str, excerpts: List[Excerpt]
) -> List[Dict[str, Any]]:
    """Earlier turns as plain text, then one user turn: the excerpts, then the question.

    Search results may only appear in user messages. The conversation must start with a
    user turn and alternate, so a leading assistant turn is dropped and neighbours with the
    same role are merged.
    """
    conversation: List[Dict[str, Any]] = []
    for message in history:
        if not message.content.strip() or message.role == "system":
            continue
        role = "assistant" if message.role == "assistant" else "user"
        if not conversation and role == "assistant":
            continue
        block = {"type": "text", "text": message.content}
        if conversation and conversation[-1]["role"] == role:
            conversation[-1]["content"].append(block)
        else:
            conversation.append({"role": role, "content": [block]})

    final = [_search_result_block(excerpt) for excerpt in excerpts]
    final.append({"type": "text", "text": question})
    if conversation and conversation[-1]["role"] == "user":
        conversation[-1]["content"].extend(final)
    else:
        conversation.append({"role": "user", "content": final})
    return conversation


def _content_block_param(block: Any) -> Optional[Dict[str, Any]]:
    """An assistant content block as the request format wants it back, or None to leave it out.

    Only the fields the API accepts on input are kept (a response block can carry more).
    Thinking blocks stay: a tool-use turn must be sent back whole.
    """
    kind = getattr(block, "type", None)
    if kind == "text":
        return {"type": "text", "text": block.text}
    if kind == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    if kind == "thinking":
        return {"type": "thinking", "thinking": block.thinking, "signature": block.signature}
    if kind == "redacted_thinking":
        return {"type": "redacted_thinking", "data": block.data}
    if kind == "fallback":
        return None
    dump = getattr(block, "model_dump", None)
    return dump(exclude_none=True) if dump else None


# The longest wait we pass on to the dispatcher, whatever the API asked for.
_MAX_RETRY_AFTER_SECONDS = 120.0


def _retry_after(exc: anthropic.APIStatusError) -> Optional[float]:
    """Seconds the API asked us to wait (retry-after-ms, then retry-after), if it said."""
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if not headers:
        return None
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        try:
            seconds = float(headers.get(name)) * scale
        except (TypeError, ValueError):
            continue
        if seconds > 0:
            return min(seconds, _MAX_RETRY_AFTER_SECONDS)
    return None


def _cost_text(cost: Optional[float]) -> str:
    return "?" if cost is None else "%.5f" % cost


def _translate_api_error(exc: anthropic.APIError) -> Exception:
    """Map SDK exceptions to the provider-neutral errors the job handlers classify.

    A rate limit (429) or overload (529, 5xx) that survived the SDK's own retries is transient:
    the job fails as retryable and the dispatcher tries again, after `retry_after` if the API
    gave one.
    """
    # The SDK's text can echo the request (an answer key, a student's words): it goes in `detail`, which no log prints.
    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return LLMAuthError(detail=detail)
    if isinstance(exc, anthropic.RateLimitError):
        error: LLMError = LLMRateLimitError(detail=detail)
        error.retry_after = _retry_after(exc)
        return error
    if isinstance(exc, anthropic.BadRequestError):
        if "credit balance" in str(exc).lower():
            return LLMCreditError(detail=detail)
        return LLMRequestError(detail=detail)
    if isinstance(exc, anthropic.APIConnectionError):  # includes APITimeoutError
        return LLMUnavailableError(detail=detail)
    if isinstance(exc, anthropic.APIStatusError):
        if exc.status_code >= 500:  # includes 529 overloaded
            error = LLMUnavailableError(detail=detail)
            error.retry_after = _retry_after(exc)
            return error
        return LLMRequestError(detail=detail)
    return LLMUnavailableError(detail=detail)


class AnthropicProvider(LLMProvider):
    """Claude via the Messages API, with structured outputs for every JSON call."""

    def __init__(self, api_key: str, timeout: float = 180.0, max_retries: int = 4):
        if not api_key or not api_key.strip():
            raise LLMNotConfiguredError("ANTHROPIC_API_KEY is not configured")
        # The SDK retries connection errors, 408, 409, 429 and 5xx with backoff (honouring
        # retry-after) before it raises.
        self.client = AsyncAnthropic(api_key=api_key, timeout=timeout, max_retries=max_retries)

    def model_for(self, purpose: str) -> Optional[str]:
        return resolve_model(purpose).model

    async def _create(
        self,
        messages: List[LLMMessage],
        *,
        max_tokens: int,
        purpose: str,
        output_format: Optional[Dict[str, Any]] = None,
    ) -> tuple[str, LLMUsage, str]:
        """Make one call; return (text, usage, stop reason)."""
        choice = resolve_model(purpose)
        model = choice.model
        system, conversation = _to_request_messages(messages)
        if not conversation:
            raise LLMRequestError("An LLM request needs at least one user message")

        output_config: Dict[str, Any] = {}
        if choice.effort:
            output_config["effort"] = choice.effort
        if output_format is not None:
            output_config["format"] = output_format

        params: Dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": conversation,
        }
        if system:
            params["system"] = system
        if output_config:
            params["output_config"] = output_config
        if _supports_server_fallback(model):
            params["betas"] = [_SERVER_FALLBACK_BETA]
            params["fallbacks"] = "default"

        try:
            async with llm_slot():
                response = await self.client.beta.messages.create(**params)
        except anthropic.APIError as exc:
            raise _translate_api_error(exc) from exc

        usage = LLMUsage(
            model=response.model or model,
            purpose=purpose,
            input_tokens=response.usage.input_tokens or 0,
            output_tokens=response.usage.output_tokens or 0,
            cache_read_input_tokens=response.usage.cache_read_input_tokens or 0,
            cache_creation_input_tokens=response.usage.cache_creation_input_tokens or 0,
        )
        record_usage(usage)
        cost = estimate_cost_usd(usage)
        logger.info(
            "llm call purpose=%s model=%s stop=%s in=%s out=%s cache_read=%s cache_write=%s cost_usd=%s request_id=%s",
            purpose or "-",
            usage.model,
            response.stop_reason,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            _cost_text(cost),
            getattr(response, "_request_id", None),
        )

        stop_reason = response.stop_reason or ""
        if stop_reason == "refusal":
            details = response.stop_details
            category = getattr(details, "category", None) if details else None
            raise LLMRefusalError(f"Claude declined the request (category: {category or 'unspecified'})")
        if stop_reason == "max_tokens":
            raise LLMOutputError(
                f"Output was cut off at max_tokens={max_tokens} ({purpose or 'llm call'})"
            )

        text = _final_text(response.content)
        if not text:
            raise LLMOutputError(f"Claude returned no text ({purpose or 'llm call'})")
        return text, usage, stop_reason

    async def generate_text(
        self,
        messages: List[LLMMessage],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> LLMResponse:
        text, usage, stop_reason = await self._create(messages, max_tokens=max_tokens, purpose=purpose)
        return LLMResponse(content=text, model=usage.model, stop_reason=stop_reason, usage=usage)

    async def generate_structured(
        self,
        messages: List[LLMMessage],
        schema: Type[SchemaT],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> SchemaT:
        output_format = {"type": "json_schema", "schema": anthropic.transform_schema(schema)}
        text, _, _ = await self._create(
            messages,
            max_tokens=max_tokens,
            purpose=purpose,
            output_format=output_format,
        )
        try:
            return schema.model_validate_json(text)
        except ValidationError as exc:
            raise LLMOutputError(
                f"Output did not match {schema.__name__} ({purpose or 'llm call'}): "
                f"{describe_validation_error(exc)}"
            ) from exc

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
        if not excerpts:
            raise LLMRequestError("A cited answer needs at least one excerpt")
        choice = resolve_model(purpose)
        model = choice.model

        params: Dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": _answer_conversation(history, question, excerpts),
        }
        if system:
            params["system"] = [{"type": "text", "text": system}]
        if choice.effort:
            params["output_config"] = {"effort": choice.effort}
        if _supports_server_fallback(model):
            params["betas"] = [_SERVER_FALLBACK_BETA]
            params["fallbacks"] = "default"

        refs = [excerpt.ref for excerpt in excerpts]
        partial: Optional[LLMUsage] = None
        text_parts: List[str] = []
        written = 0
        citations: List[AnswerCitation] = []
        # A citation arrives before the text of the block it quotes, so its marker belongs at the end
        # of that block. Citations wait here until the block ends.
        pending: List[Any] = []

        def settle() -> List[AnswerCitation]:
            settled = []
            for raw in pending:
                citation = _to_answer_citation(raw, refs, written)
                if citation is not None:
                    citations.append(citation)
                    settled.append(citation)
            pending.clear()
            return settled

        try:
            async with llm_slot(), self.client.beta.messages.stream(**params) as stream:
                async for event in stream:
                    partial = _partial_usage(event, partial, model, purpose)
                    kind = getattr(event, "type", None)
                    if kind == "content_block_start":
                        for citation in settle():
                            yield citation
                        if event.content_block.type == "fallback":
                            # The declined model's partial answer is void.
                            text_parts, written, citations = [], 0, []
                            yield AnswerReset()
                    elif kind == "content_block_stop":
                        for citation in settle():
                            yield citation
                    elif kind == "content_block_delta":
                        delta = event.delta
                        if delta.type == "text_delta" and delta.text:
                            text_parts.append(delta.text)
                            written += len(delta.text)
                            yield AnswerText(text=delta.text)
                        elif delta.type == "citations_delta":
                            pending.append(delta.citation)
                for citation in settle():
                    yield citation
                final = await stream.get_final_message()
        except anthropic.APIError as exc:
            raise _translate_api_error(exc) from exc

        usage = LLMUsage(
            model=final.model or model,
            purpose=purpose,
            input_tokens=final.usage.input_tokens or 0,
            output_tokens=final.usage.output_tokens or 0,
            cache_read_input_tokens=final.usage.cache_read_input_tokens or 0,
            cache_creation_input_tokens=final.usage.cache_creation_input_tokens or 0,
        )
        record_usage(usage)
        cost = estimate_cost_usd(usage)
        logger.info(
            "llm stream purpose=%s model=%s stop=%s in=%s out=%s cache_read=%s cache_write=%s "
            "excerpts=%s citations=%s cost_usd=%s request_id=%s",
            purpose or "-",
            usage.model,
            final.stop_reason,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            len(excerpts),
            len(citations),
            _cost_text(cost),
            getattr(final, "_request_id", None),
        )

        stop_reason = final.stop_reason or ""
        if stop_reason == "refusal":
            details = final.stop_details
            category = getattr(details, "category", None) if details else None
            error: LLMError = LLMRefusalError(
                f"Claude declined the request (category: {category or 'unspecified'})"
            )
        elif stop_reason == "max_tokens":
            error = LLMOutputError(f"The answer was cut off at max_tokens={max_tokens} ({purpose})")
        elif not "".join(text_parts).strip():
            error = LLMOutputError(f"Claude returned no text ({purpose})")
        else:
            yield AnswerDone(
                text="".join(text_parts),
                citations=citations,
                stop_reason=stop_reason,
                usage=usage,
            )
            return
        error.usage = usage
        raise error

    async def stream_turn(
        self,
        *,
        system: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        max_tokens: int = 800,
        purpose: str = "voice",
    ) -> AsyncIterator[TurnEvent]:
        if not messages:
            raise LLMRequestError("A turn needs at least one message")
        choice = resolve_model(purpose)
        model = choice.model

        params: Dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if system:
            # Tools render before the system prompt, so this one breakpoint caches both.
            params["system"] = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        if tools:
            # tool_choice stays auto: forced tool use is not supported on these models.
            params["tools"] = tools
            params["tool_choice"] = {"type": "auto"}
        if choice.effort:
            params["output_config"] = {"effort": choice.effort}
        if _supports_server_fallback(model):
            params["betas"] = [_SERVER_FALLBACK_BETA]
            params["fallbacks"] = "default"

        partial: Optional[LLMUsage] = None
        try:
            async with llm_slot(), self.client.beta.messages.stream(**params) as stream:
                async for event in stream:
                    partial = _partial_usage(event, partial, model, purpose)
                    if getattr(event, "type", None) != "content_block_delta":
                        continue
                    delta = event.delta
                    if delta.type == "text_delta" and delta.text:
                        yield TurnText(text=delta.text)
                final = await stream.get_final_message()
        except anthropic.APIError as exc:
            raise _translate_api_error(exc) from exc

        usage = LLMUsage(
            model=final.model or model,
            purpose=purpose,
            input_tokens=final.usage.input_tokens or 0,
            output_tokens=final.usage.output_tokens or 0,
            cache_read_input_tokens=final.usage.cache_read_input_tokens or 0,
            cache_creation_input_tokens=final.usage.cache_creation_input_tokens or 0,
        )
        record_usage(usage)
        cost = estimate_cost_usd(usage)
        logger.info(
            "llm turn purpose=%s model=%s stop=%s in=%s out=%s cache_read=%s cache_write=%s "
            "tools=%s cost_usd=%s request_id=%s",
            purpose or "-",
            usage.model,
            final.stop_reason,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            len(tools),
            _cost_text(cost),
            getattr(final, "_request_id", None),
        )

        stop_reason = final.stop_reason or ""
        if stop_reason == "refusal":
            details = final.stop_details
            category = getattr(details, "category", None) if details else None
            error: LLMError = LLMRefusalError(
                f"Claude declined the request (category: {category or 'unspecified'})"
            )
            error.usage = usage
            raise error

        content = [param for param in map(_content_block_param, final.content) if param is not None]
        tool_uses = [block for block in content if block["type"] == "tool_use"]
        has_text = any(block["type"] == "text" and block["text"].strip() for block in content)
        if not tool_uses and not has_text:
            error = LLMOutputError(f"Claude returned no text or tool call ({purpose})")
            error.usage = usage
            raise error
        for block in tool_uses:
            yield TurnToolUse(id=block["id"], name=block["name"], input=block["input"] or {})
        yield TurnDone(stop_reason=stop_reason, content=content, usage=usage)


def _partial_usage(event: Any, seen: Optional[LLMUsage], model: str, purpose: str) -> Optional[LLMUsage]:
    """What a stream has said about its usage so far: the input tokens come with its first event (message_start), the
    output tokens as message_delta events report them. Reported to the billing scope, so a stream that is cut off is
    billed for what it used (the final figures replace this when the stream completes)."""
    kind = getattr(event, "type", None)
    if kind == "message_start":
        start = event.message
        seen = LLMUsage(
            model=getattr(start, "model", None) or model,
            purpose=purpose,
            input_tokens=start.usage.input_tokens or 0,
            output_tokens=start.usage.output_tokens or 0,
            cache_read_input_tokens=getattr(start.usage, "cache_read_input_tokens", 0) or 0,
            cache_creation_input_tokens=getattr(start.usage, "cache_creation_input_tokens", 0) or 0,
        )
    elif kind == "message_delta" and seen is not None:
        seen = seen.model_copy(update={"output_tokens": getattr(event.usage, "output_tokens", 0) or seen.output_tokens})
    else:
        return seen
    note_partial_usage(seen)
    return seen


def _to_answer_citation(citation: Any, refs: List[str], offset: int) -> Optional[AnswerCitation]:
    """Map a search_result_location citation back to the excerpt it quotes.

    The `source` we sent identifies the excerpt; `search_result_index` (position among the
    search results in the request) is the fallback. Other citation kinds are ignored.
    """
    if getattr(citation, "type", None) != "search_result_location":
        return None
    ref = citation.source if citation.source in refs else None
    if ref is None and 0 <= citation.search_result_index < len(refs):
        ref = refs[citation.search_result_index]
    if ref is None:
        logger.warning("Citation points at an unknown source: %s", citation.source)
        return None
    return AnswerCitation(
        ref=ref,
        cited_text=citation.cited_text,
        start_block_index=citation.start_block_index,
        end_block_index=citation.end_block_index,
        offset=offset,
    )

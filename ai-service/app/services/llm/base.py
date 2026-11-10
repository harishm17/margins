"""Provider-neutral LLM interface, errors and usage records."""
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Dict, List, Literal, Optional, Type, TypeVar, Union

from pydantic import BaseModel

SchemaT = TypeVar("SchemaT", bound=BaseModel)


class LLMMessage(BaseModel):
    """One message in a request.

    `cache=True` marks the end of a prefix that later requests repeat (for example a
    topic's source excerpts), so the provider can cache it. Nothing is cached unless a message
    asks for it: writing a cache entry costs more than a plain read of the same tokens, so
    only a prefix that will be read again should be marked.
    """

    role: str  # 'system', 'user', 'assistant'
    content: str
    cache: bool = False


class LLMUsage(BaseModel):
    """Token usage for one call."""

    model: str
    purpose: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class LLMResponse(BaseModel):
    """A text response."""

    content: str
    model: str
    stop_reason: str
    usage: LLMUsage


class LLMError(Exception):
    """Base for every provider failure. `code` is stored on failed jobs.

    Nothing reads `str(exc)` to answer or store anything: the code and its public message (app/errors.py) do that, and
    the log filter writes the exception as `ClassName(code)`. A provider's own wording, which can echo the request (an
    answer key, a student's words), goes in `detail` and the exception's text stays the public message.
    """

    code = "LLM_ERROR"
    retryable = True
    detail: str = ""

    def __init__(self, message: object = "", *, detail: object = "") -> None:
        from app.errors import public_message

        super().__init__(message or public_message(self.code))
        self.detail = str(detail) if detail else ""
    # Tokens a failed call still used (a refusal or cut-off answer is billed), so callers can
    # record the cost. None when the call produced no usage.
    usage: Optional["LLMUsage"] = None
    # Seconds the API asked us to wait before trying again (its retry-after header), if it did.
    retry_after: Optional[float] = None


class LLMNotConfiguredError(LLMError):
    code = "LLM_NOT_CONFIGURED"
    retryable = False


class LLMAuthError(LLMError):
    code = "LLM_AUTH_FAILED"
    retryable = False


class LLMCreditError(LLMError):
    code = "LLM_CREDIT_EXHAUSTED"
    retryable = False


class LLMRequestError(LLMError):
    """The API rejected the request itself (bad parameters, too large, unknown model)."""

    code = "LLM_REQUEST_REJECTED"
    retryable = False


class LLMRefusalError(LLMError):
    code = "LLM_REFUSED"
    retryable = False


class LLMRateLimitError(LLMError):
    code = "LLM_RATE_LIMITED"
    retryable = True


class LLMUnavailableError(LLMError):
    """Timeouts, connection failures, overload and 5xx responses."""

    code = "LLM_UNAVAILABLE"
    retryable = True


class LLMBusyError(LLMError):
    """Every model slot stayed taken for LLM_INTERACTIVE_WAIT_SECONDS (see limiter.py): try again in a moment."""

    code = "LLM_BUSY"
    retryable = True


class LLMOutputError(LLMError):
    """The model answered, but the output was empty, cut off or failed validation."""

    code = "LLM_BAD_OUTPUT"
    retryable = True


class Excerpt(BaseModel):
    """One passage the model may quote when it answers a question.

    `ref` is a stable identifier the caller can map back to its own record (for example
    `chunk:<id>`). It travels to the model as the search result's `source`.
    """

    ref: str
    title: str
    text: str


class AnswerText(BaseModel):
    """A piece of the answer, in the order it was written."""

    type: Literal["text"] = "text"
    text: str


class AnswerCitation(BaseModel):
    """The model cited an excerpt. It belongs to the text block it arrived with.

    `offset` is the number of characters of answer text written up to the end of that block,
    so a marker for this citation goes at that position, after the words it supports.
    """

    type: Literal["citation"] = "citation"
    ref: str  # Excerpt.ref
    cited_text: str
    start_block_index: int
    end_block_index: int
    offset: int


class AnswerReset(BaseModel):
    """Everything sent so far is void: a fallback model is writing the answer instead."""

    type: Literal["reset"] = "reset"


class AnswerDone(BaseModel):
    """The last event: the whole answer, its citations and what the call cost."""

    type: Literal["done"] = "done"
    text: str
    citations: List[AnswerCitation]
    stop_reason: str
    usage: LLMUsage


AnswerEvent = Union[AnswerText, AnswerCitation, AnswerReset, AnswerDone]


class TurnText(BaseModel):
    """A piece of the reply, as it is written."""

    type: Literal["text"] = "text"
    text: str


class TurnToolUse(BaseModel):
    """The model wants a tool run. The caller runs it and sends a tool_result next turn."""

    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: Dict[str, Any]


class TurnDone(BaseModel):
    """The last event: why the model stopped, the assistant content blocks exactly as
    returned (to append to the conversation), and what the call cost."""

    type: Literal["done"] = "done"
    stop_reason: str
    content: List[Dict[str, Any]]
    usage: LLMUsage


TurnEvent = Union[TurnText, TurnToolUse, TurnDone]


class LLMProvider(ABC):
    """Interface every provider implements."""

    @abstractmethod
    async def generate_text(
        self,
        messages: List[LLMMessage],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> LLMResponse:
        """Return free text (markdown). Raises LLMOutputError when the text is empty or cut off."""

    @abstractmethod
    async def generate_structured(
        self,
        messages: List[LLMMessage],
        schema: Type[SchemaT],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> SchemaT:
        """Return output constrained to `schema` and validated against it."""

    @abstractmethod
    def stream_cited_answer(
        self,
        *,
        system: str,
        history: List[LLMMessage],
        question: str,
        excerpts: List[Excerpt],
        max_tokens: int = 4000,
        purpose: str = "chat",
        cache_system: bool = False,
    ) -> AsyncIterator[AnswerEvent]:
        """Answer `question` from `excerpts`, streaming the answer and the citations.

        Yields AnswerText pieces and AnswerCitation events as they arrive and ends with one
        AnswerDone. An AnswerReset means a fallback model took over: discard what came
        before. Raises LLMRefusalError when the model declines and LLMOutputError when the
        answer is empty or cut off (both with `usage` set). Free text only: search result
        citations cannot be combined with structured outputs. `cache_system` puts a cache
        breakpoint on the system prompt (Ask v2's is the same for every turn, prompt audit R8).
        """

    async def stream_turn(
        self,
        *,
        system: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        max_tokens: int = 800,
        purpose: str = "voice",
    ) -> AsyncIterator[TurnEvent]:
        """One model call of a text conversation that may use tools.

        `messages` are Anthropic-format messages (content may hold tool_use and tool_result
        blocks) and `tools` are Anthropic tool definitions; tool_choice is always auto.
        Yields TurnText pieces as they arrive, one TurnToolUse per tool call, and ends with
        one TurnDone. Raises LLMRefusalError when the model declines (with `usage` set) and
        LLMOutputError when it returned neither text nor a tool call.

        Not abstract: a provider without a conversation mode (a test double) need not
        implement it.
        """
        raise NotImplementedError(f"{type(self).__name__} does not support voice turns")
        yield  # pragma: no cover  (makes this an async generator)

    def model_for(self, purpose: str) -> Optional[str]:
        """The model a purpose maps to, for logging."""
        return None

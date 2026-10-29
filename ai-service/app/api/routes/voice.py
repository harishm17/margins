"""Voice coach endpoints for Margins.

The browser does speech-to-text and text-to-speech, so the model only ever sees text:
POST /voice/turn is one model call of that conversation, streamed back as newline-delimited
JSON (see `turn` below). The Next.js server owns the conversation and runs the tools.
"""
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Union

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.db.connection import execute_one
from app.services import ai_status
from app.services.budget import over_budget_message, record_usage_event
from app.services.chat import usage_payload
from app.services.llm.base import (
    LLMError,
    LLMMessage,
    LLMNotConfiguredError,
    LLMProvider,
    LLMUsage,
    TurnDone,
    TurnText,
    TurnToolUse,
)
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import DrillQuestionSet

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/voice")

# Questions that need working out on paper. Bare digits are allowed ("layer 4", "Python 3")
# unless they form an expression; keywords need word boundaries ("sum" is not "summarize").
MATH_PATTERN = re.compile(
    r"(\d\s*[-+*/^=<>]\s*\d|[=±√∑∫]"
    r"|\b(?:sqrt|integral|integrate|derivative|differentiate|calculate|compute|solve|equation"
    r"|formula|sum|delta|percent|percentage)\b)",
    re.IGNORECASE,
)


# Requested on top of `count`, because the math filter drops some questions.
DRILL_EXTRA_QUESTIONS = 3


def _is_conceptual_text(value: Optional[str]) -> bool:
    if not value:
        return True
    return MATH_PATTERN.search(value) is None


def _filter_concept_questions(questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    filtered: List[Dict[str, Any]] = []
    for q in questions:
        question_text = str(q.get("question_text", ""))
        explanation = str(q.get("explanation", ""))
        sample_answer = str(q.get("sample_answer", ""))
        correct_answer = str(q.get("correct_answer", ""))
        key_points = " ".join(str(point) for point in (q.get("key_points") or []))
        concepts_tested = " ".join(str(point) for point in (q.get("concepts_tested") or []))
        options_text = " ".join(str(opt.get("text", "")) for opt in (q.get("options") or []) if isinstance(opt, dict))
        if str(q.get("question_type", "")).lower() == "numerical":
            continue
        if not (_is_conceptual_text(question_text)
                and _is_conceptual_text(explanation)
                and _is_conceptual_text(sample_answer)
                and _is_conceptual_text(correct_answer)
                and _is_conceptual_text(key_points)
                and _is_conceptual_text(concepts_tested)
                and _is_conceptual_text(options_text)):
            continue
        filtered.append(q)
    return filtered


class DrillGenerateRequest(BaseModel):
    topic: Optional[str] = None
    notes: str
    count: int = Field(default=10, ge=3, le=20)
    difficulty: str = Field(default="medium")


class VoiceTurnRequest(BaseModel):
    user_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    system: str = Field(max_length=40_000)
    # Anthropic message format; content may hold tool_use and tool_result blocks.
    messages: List[Dict[str, Any]] = Field(min_length=1, max_length=100)
    # Anthropic tool definitions. Empty for a plain conversation.
    tools: List[Dict[str, Any]] = Field(default_factory=list, max_length=10)


def _fail(status: int, code: str, message: str, retryable: bool = False) -> JSONResponse:
    """The same body shape as the LLMError handler in main.py."""
    return JSONResponse(
        status_code=status,
        content={"detail": message, "error_code": code, "retryable": retryable},
    )


async def _record_voice_usage(payload: VoiceTurnRequest, usage: Optional[LLMUsage]) -> None:
    """One ledger row per model call, so voice counts toward the daily budget."""
    if usage is None:
        return
    figures = usage_payload(usage)
    await record_usage_event(
        user_id=payload.user_id,
        project_id=payload.project_id,
        source="voice",
        source_id=payload.session_id,
        models=usage.model,
        input_tokens=figures["input_tokens"],
        output_tokens=figures["output_tokens"],
        cost_usd=figures["cost_usd"],
    )


async def stream_voice_turn(provider: LLMProvider, payload: VoiceTurnRequest) -> AsyncIterator[Dict[str, Any]]:
    """Events for one model call. Failures become an `error` event, never an exception."""
    try:
        async for event in provider.stream_turn(
            system=payload.system,
            messages=payload.messages,
            tools=payload.tools,
            max_tokens=settings.VOICE_MAX_TOKENS,
            purpose="voice",
        ):
            if isinstance(event, TurnText):
                yield {"type": "text", "delta": event.text}
            elif isinstance(event, TurnToolUse):
                yield {"type": "tool_use", "id": event.id, "name": event.name, "input": event.input}
            elif isinstance(event, TurnDone):
                await _record_voice_usage(payload, event.usage)
                yield {
                    "type": "done",
                    "stop_reason": event.stop_reason,
                    "content": event.content,
                    "usage": usage_payload(event.usage),
                }
    except LLMError as exc:
        logger.warning("Voice turn failed: %s: %s", exc.code, exc)
        await _record_voice_usage(payload, exc.usage)
        yield {"type": "error", "code": exc.code, "message": str(exc), "retryable": exc.retryable}
    except Exception as exc:  # the stream has started: report it in-band
        logger.exception("Voice turn crashed")
        yield {
            "type": "error",
            "code": "VOICE_TURN_FAILED",
            "message": f"The coach could not reply: {exc}",
            "retryable": True,
        }


async def _ndjson(events: AsyncIterator[Dict[str, Any]]) -> AsyncIterator[bytes]:
    async for event in events:
        yield (json.dumps(event, ensure_ascii=False) + "\n").encode()


@router.post("/turn", response_model=None)
async def turn(payload: VoiceTurnRequest) -> Union[StreamingResponse, JSONResponse]:
    """One model call of a voice coaching conversation, streamed as NDJSON.

    Events, one JSON object per line:
        {"type": "text", "delta": "..."}
        {"type": "tool_use", "id": "...", "name": "...", "input": {...}}
        {"type": "done", "stop_reason": "end_turn" | "tool_use" | "max_tokens", "content": [...], "usage": {...}}
        {"type": "error", "code": "LLM_...", "message": "...", "retryable": bool}
    `content` is the assistant message exactly as returned (text, tool_use and thinking
    blocks): the caller appends it to the conversation, then sends its tool results back.

    Problems found before the model runs (not configured, unknown project, daily budget) are
    ordinary HTTP errors with an `error_code`, like /chat/answer.
    """
    if not settings.llm_configured:
        return _fail(503, LLMNotConfiguredError.code, "ANTHROPIC_API_KEY is not configured")

    project = await execute_one(
        "SELECT id FROM projects WHERE id = $1 AND user_id = $2", payload.project_id, payload.user_id
    )
    if project is None:
        return _fail(404, "PROJECT_NOT_FOUND", "Project not found")

    # Known to be down (out of credit, say): refuse before anything is stored or streamed.
    unavailable = (await ai_status.get_status()).as_error()
    if unavailable is not None:
        return _fail(503, unavailable.code, str(unavailable), unavailable.retryable)

    over_budget = await over_budget_message(payload.user_id)
    if over_budget:
        return _fail(429, "LLM_DAILY_BUDGET", over_budget)

    return StreamingResponse(
        _ndjson(stream_voice_turn(LLMFactory.get_provider(), payload)),
        media_type="application/x-ndjson",
        # No proxy may hold the stream back.
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post("/generate-drill")
async def generate_concept_drill(
    payload: DrillGenerateRequest,
):
    """Generate concept-only oral drill questions from notes."""
    llm = LLMFactory.get_provider()
    topic_label = payload.topic or "the study topic"

    system_prompt = (
        "You are the oral exam coach in Margins, a study app. Generate conceptual questions only. "
        "Do NOT include calculations, equations, formulas, or numeric problem solving. "
        "Focus on definitions, intuition, relationships, trade-offs, comparisons, and reasoning."
    )

    user_prompt = f"""
Topic: {topic_label}
Difficulty: {payload.difficulty}
Number of questions: {payload.count}

Source notes:
{payload.notes}

Write {payload.count + DRILL_EXTRA_QUESTIONS} questions a student can answer out loud in under a minute each.
For each, give 2-4 key points a listener can check, a short sample answer, and the concepts it tests.
"""

    messages = [
        LLMMessage(role="system", content=system_prompt),
        LLMMessage(role="user", content=user_prompt),
    ]

    result = await llm.generate_structured(
        messages,
        DrillQuestionSet,
        max_tokens=8000,
        purpose="voice_drill",
    )

    cleaned: List[Dict[str, Any]] = []
    for q in result.questions:
        if not q.question_text.strip():
            continue
        cleaned.append(
            {
                "question_type": "conceptual",
                "question_text": q.question_text.strip(),
                "key_points": [point.strip() for point in q.key_points if point.strip()],
                "sample_answer": q.sample_answer,
                "explanation": q.explanation,
                "difficulty": payload.difficulty,
                "concepts_tested": [point.strip() for point in q.concepts_tested if point.strip()],
                "source": "generated",
            }
        )

    # Extra questions were requested so the set is still full after the math filter.
    cleaned = _filter_concept_questions(cleaned)[: payload.count]

    return {
        "questions": cleaned,
        "total": len(cleaned),
    }

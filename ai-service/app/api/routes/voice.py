"""Voice coach endpoints for Margins.

The browser does speech-to-text and text-to-speech, so the model only ever sees text:
POST /voice/turn is one model call of that conversation, streamed back as newline-delimited
JSON (see `turn` below). The Next.js server owns the conversation and runs the tools.
"""
import hashlib
import json
import logging
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Union

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.api.disconnect import run_unless_disconnected
from app.config import settings
from app.errors import error_body, describe_exception, public_message
from app.db.connection import execute_one, execute_update
from app.services import ai_status
from app.services.billing import billed
from app.services.budget import DailyBudgetExceeded, allowance_today
from app.services.chat import usage_payload
from app.services.content_generator.context import fetch_concepts, format_concept_block, resolve_concept_ids
from app.services.llm.base import (
    LLMError,
    LLMMessage,
    LLMNotConfiguredError,
    LLMProvider,
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
    # The call is billed to this user and project (billing.py).
    user_id: str = Field(min_length=1, max_length=100)
    project_id: str = Field(min_length=1, max_length=100)
    topic: Optional[str] = None
    # When given, the questions are tagged with this topic's concepts.
    topic_id: Optional[str] = None
    notes: str
    count: int = Field(default=10, ge=3, le=20)
    difficulty: str = Field(default="medium")


# Part of the drill's cache key: bump it when the prompt below changes, so old sets are not served for the new prompt.
DRILL_PROMPT_VERSION = 1


def _inputs_hash(payload: DrillGenerateRequest, concepts: List[Dict[str, Any]]) -> str:
    """What decides the questions: the request's fields that reach the prompt, the topic's concepts and the prompt."""
    inputs = {
        "v": DRILL_PROMPT_VERSION,
        "topic": payload.topic,
        "notes": payload.notes,
        "count": payload.count,
        "difficulty": payload.difficulty,
        "concepts": [[str(concept.get("id")), concept.get("name"), concept.get("summary")] for concept in concepts],
    }
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


class VoiceTurnRequest(BaseModel):
    user_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    system: str = Field(max_length=40_000)
    # Anthropic message format; content may hold tool_use and tool_result blocks.
    messages: List[Dict[str, Any]] = Field(min_length=1, max_length=100)
    # Anthropic tool definitions. Empty for a plain conversation.
    tools: List[Dict[str, Any]] = Field(default_factory=list, max_length=10)


def _fail(status: int, code: str, retryable: bool = False, **extra: str) -> JSONResponse:
    """The same body shape as the LLMError handler in main.py: the code and its public message."""
    return JSONResponse(status_code=status, content=error_body(code, retryable, **extra))


async def stream_voice_turn(provider: LLMProvider, payload: VoiceTurnRequest) -> AsyncIterator[Dict[str, Any]]:
    """Events for one model call. Failures become an `error` event, never an exception.

    The `done` event carries `timing` (spec 19.10): milliseconds from the start of the call to its first text or tool call,
    and to the end. The same is logged, so the service's own share of a turn's latency is visible apart from the web app's.
    """
    started = time.perf_counter()
    first_token_ms: Optional[int] = None
    try:
        async for event in provider.stream_turn(
            system=payload.system,
            messages=payload.messages,
            tools=payload.tools,
            max_tokens=settings.VOICE_MAX_TOKENS,
            purpose="voice",
        ):
            if first_token_ms is None and isinstance(event, (TurnText, TurnToolUse)):
                first_token_ms = round((time.perf_counter() - started) * 1000)
            if isinstance(event, TurnText):
                yield {"type": "text", "delta": event.text}
            elif isinstance(event, TurnToolUse):
                yield {"type": "tool_use", "id": event.id, "name": event.name, "input": event.input}
            elif isinstance(event, TurnDone):
                timing = {"ttft_ms": first_token_ms, "total_ms": round((time.perf_counter() - started) * 1000)}
                logger.info("Voice call session=%s ttft_ms=%s total_ms=%s", payload.session_id, timing["ttft_ms"], timing["total_ms"])
                yield {
                    "type": "done",
                    "stop_reason": event.stop_reason,
                    "content": event.content,
                    "usage": usage_payload(event.usage),
                    "timing": timing,
                }
    except LLMError as exc:
        logger.warning("Voice turn failed: %s", describe_exception(exc))
        yield {"type": "error", "code": exc.code, "message": public_message(exc.code), "retryable": exc.retryable}
    except DailyBudgetExceeded as exc:  # the allowance ran out between the route's check and this call
        logger.info("Voice turn refused: %s", exc.code)
        yield {"type": "error", "code": exc.code, "message": public_message(exc.code), "retryable": False}
    except Exception as exc:  # the stream has started: report it in-band
        logger.exception("Voice turn crashed")
        yield {
            "type": "error",
            "code": "VOICE_TURN_FAILED",
            "message": public_message("VOICE_TURN_FAILED"),
            "retryable": True,
        }


async def _billed_turn(payload: VoiceTurnRequest) -> AsyncIterator[Dict[str, Any]]:
    """The turn's events, with every model call billed to the student as it is made (a turn the browser drops is billed
    for what it used). The scope is opened here, not in the route: Starlette iterates this in another task."""
    async with billed(payload.user_id, payload.project_id, "voice", payload.session_id):
        async for event in stream_voice_turn(LLMFactory.get_provider(), payload):
            yield event


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
        return _fail(503, LLMNotConfiguredError.code)

    project = await execute_one(
        "SELECT id FROM projects WHERE id = $1 AND user_id = $2", payload.project_id, payload.user_id
    )
    if project is None:
        return _fail(404, "PROJECT_NOT_FOUND")

    # Known to be down (out of credit, say): refuse before anything is stored or streamed.
    unavailable = (await ai_status.get_status()).as_error()
    if unavailable is not None:
        return _fail(503, unavailable.code, unavailable.retryable)

    # Refuse before the first byte when the allowance is spent (the scope checks again on every model call).
    allowance = await allowance_today(payload.user_id)
    if allowance.refused:
        return _fail(429, "LLM_DAILY_BUDGET", budget_reason=allowance.refused)

    return StreamingResponse(
        _ndjson(_billed_turn(payload)),
        media_type="application/x-ndjson",
        # No proxy may hold the stream back.
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post("/retention")
async def purge_transcripts():
    """Delete the voice transcripts older than VOICE_RETENTION_DAYS now (the timer does it daily). Evidence events stay."""
    from app.services.voice_retention import purge_voice_transcripts

    return await purge_voice_transcripts()


@router.post("/generate-drill")
async def generate_concept_drill(
    payload: DrillGenerateRequest,
    request: Request,
):
    """Generate concept-only oral drill questions from notes. With a topic, the set is kept (voice_drill_sets) and the
    next request with the same inputs gets it back without a model call."""
    topic_label = payload.topic or "the study topic"

    system_prompt = (
        "You are the oral exam coach in Margins, a study app. Generate conceptual questions only. "
        "Do NOT include calculations, equations, formulas, or numeric problem solving. "
        "Focus on definitions, intuition, relationships, trade-offs, comparisons, and reasoning."
    )

    concepts: List[Dict[str, Any]] = []
    if payload.topic_id:
        try:
            concepts = await fetch_concepts(payload.topic_id)
        except Exception as exc:  # tagging is a bonus: never fail a drill for it
            logger.warning("Concepts for topic %s unavailable, drill is untagged: %s", payload.topic_id, exc)

    inputs_hash = _inputs_hash(payload, concepts) if payload.topic_id else None
    if inputs_hash is not None:
        stored = await execute_one(
            "SELECT questions FROM voice_drill_sets WHERE topic_id = $1 AND inputs_hash = $2",
            payload.topic_id,
            inputs_hash,
        )
        if stored is not None:
            questions = json.loads(stored["questions"]) if isinstance(stored["questions"], str) else stored["questions"]
            return {"questions": questions, "total": len(questions)}

    user_prompt = f"""
Topic: {topic_label}
Difficulty: {payload.difficulty}
Number of questions: {payload.count}

Source notes:
{payload.notes}
{format_concept_block(concepts)}
Write {payload.count + DRILL_EXTRA_QUESTIONS} questions a student can answer out loud in under a minute each.
For each, give 2-4 key points a listener can check, a short sample answer, and the concepts it tests.
"""

    messages = [
        LLMMessage(role="system", content=system_prompt),
        LLMMessage(role="user", content=user_prompt),
    ]

    async with billed(payload.user_id, payload.project_id, "drill", payload.topic_id):
        result = await run_unless_disconnected(request, LLMFactory.get_provider().generate_structured(
            messages,
            DrillQuestionSet,
            max_tokens=8000,
            purpose="voice_drill",
        ))

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
                "concept_ids": q.concept_ids,
                "source": "generated",
            }
        )

    # Extra questions were requested so the set is still full after the math filter.
    cleaned = _filter_concept_questions(cleaned)[: payload.count]
    resolve_concept_ids(cleaned, concepts, [])

    if inputs_hash is not None and cleaned:
        try:
            await execute_update(
                """
                INSERT INTO voice_drill_sets (id, topic_id, inputs_hash, count, questions, created_at)
                VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, NOW() AT TIME ZONE 'UTC')
                ON CONFLICT (topic_id, inputs_hash) DO NOTHING
                """,
                payload.topic_id,
                inputs_hash,
                payload.count,
                json.dumps(cleaned),
            )
        except Exception as exc:  # the topic was deleted meanwhile, or a blip: the set is still returned
            logger.warning("Could not keep the drill set for topic %s: %s", payload.topic_id, exc)

    return {
        "questions": cleaned,
        "total": len(cleaned),
    }

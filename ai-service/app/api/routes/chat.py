"""POST /chat/answer: a cited answer to a question about a project's materials.

Called by the Next.js server only. Everything that can fail before the model runs (unknown
project, budget, retrieval) is an ordinary HTTP error with an `error_code`. Once the answer
starts it is newline-delimited JSON (see services/chat.py for the events; the first is the route of
the turn), and a failure after that point is an `error` event, because the status line has already
been sent.
"""
import asyncio
import json
import logging
from typing import AsyncIterator, Dict, List, Literal, Optional, Union

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.config import settings
from app.db.connection import execute_one
from app.services import chat as chat_service
from app.services import ai_status, exam_guard
from app.services.budget import over_budget_message
from app.services.llm.base import LLMNotConfiguredError
from app.services.llm.factory import LLMFactory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat")


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatAnswerRequest(BaseModel):
    project_id: str = Field(min_length=1)
    user_id: str = Field(min_length=1)
    question: str
    history: List[ChatTurn] = Field(default_factory=list, max_length=50)
    topic_id: Optional[str] = None
    # The thread's tutor state, read by the app: the rung allowed, whether the student has their own
    # correct answer, and whether to ask which part of the last hint is unclear. Absent: rung 0.
    tutor: chat_service.TutorParams = Field(default_factory=chat_service.TutorParams)

    @field_validator("question")
    @classmethod
    def _question_fits(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("question is empty")
        if len(value) > settings.CHAT_MAX_QUESTION_CHARS:
            raise ValueError(f"question is longer than {settings.CHAT_MAX_QUESTION_CHARS} characters")
        return value


def _fail(status: int, code: str, message: str, retryable: bool = False) -> JSONResponse:
    """The same body shape as the LLMError handler in main.py."""
    return JSONResponse(
        status_code=status,
        content={"detail": message, "error_code": code, "retryable": retryable},
    )


async def _ndjson(events: AsyncIterator[Dict]) -> AsyncIterator[bytes]:
    async for event in events:
        yield (json.dumps(event, ensure_ascii=False) + "\n").encode()


@router.post("/answer", response_model=None)
async def answer(payload: ChatAnswerRequest) -> Union[StreamingResponse, JSONResponse]:
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

    history = chat_service.clean_history([turn.model_dump() for turn in payload.history])
    # Routing never raises (a router that fails leaves a lookup); retrieval failing is the 503 it
    # always was. With a topic, the concepts to route against are known up front and routing runs
    # beside retrieval (and is cancelled if retrieval fails). Without one, the project's concepts
    # are ordered by the topics of the retrieved chunks, so routing follows retrieval.
    routing = None
    worked = payload.tutor.show_worked
    if payload.topic_id and not worked:
        routing = asyncio.create_task(
            chat_service.route_question(payload.project_id, payload.topic_id, payload.question, history)
        )
    # The worked-example button is one fixed sentence that says nothing about the problem, so the passages
    # are found from what the student has written in the conversation.
    search = payload.question
    if worked:
        written = [turn.content for turn in history if turn.role == "user"][-2:]
        search = " ".join(written) or payload.question
    try:
        chunks = await chat_service.retrieve(payload.project_id, search, payload.topic_id)
    except Exception as exc:
        if routing is not None:
            routing.cancel()
        logger.exception("Retrieval failed for project %s", payload.project_id)
        return _fail(503, "RETRIEVAL_FAILED", f"Could not search the materials: {exc}", True)
    if worked:
        route = chat_service.RouteResult.worked_example()
    else:
        if routing is None:
            routing = chat_service.route_question(
                payload.project_id, None, payload.question, history, [str(chunk["id"]) for chunk in chunks]
            )
        route = await routing

    events = chat_service.stream_answer(
        LLMFactory.get_provider(), chunks, payload.question, history, route=route, tutor=payload.tutor
    )
    return StreamingResponse(
        _ndjson(events),
        media_type="application/x-ndjson",
        # No proxy may hold the stream back.
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


class ExamGuardRequest(BaseModel):
    message: str = Field(min_length=1, max_length=settings.CHAT_MAX_QUESTION_CHARS * 2)
    # The student's earlier messages in the conversation, newest last, not including this one.
    recent: List[str] = Field(default_factory=list, max_length=6)
    # The texts of the questions of the mock exam in progress (each stem, and the stem with its options).
    exam_texts: List[str] = Field(default_factory=list, max_length=exam_guard.MAX_EXAM_TEXTS)


@router.post("/exam-guard")
async def exam_guard_check(payload: ExamGuardRequest) -> Dict:
    """Whether the message is, in meaning, one of the exam's questions (reworded or in another language)."""
    similarity = await exam_guard.semantic_similarity(payload.message, payload.recent, payload.exam_texts)
    return {"match": similarity >= settings.EXAM_GUARD_SEMANTIC_THRESHOLD, "similarity": round(similarity, 4)}

"""POST /chat/answer: a cited answer to a question about a project's materials.

Called by the Next.js server only. Everything that can fail before the model runs (unknown
project, budget, retrieval) is an ordinary HTTP error with an `error_code`. Once the answer
starts it is newline-delimited JSON (see services/chat.py for the events), and a failure
after that point is an `error` event, because the status line has already been sent.
"""
import json
import logging
from typing import AsyncIterator, Dict, List, Literal, Optional, Union

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.config import settings
from app.db.connection import execute_one
from app.services import chat as chat_service
from app.services import ai_status
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

    try:
        chunks = await chat_service.retrieve(payload.project_id, payload.question, payload.topic_id)
    except Exception as exc:
        logger.exception("Retrieval failed for project %s", payload.project_id)
        return _fail(503, "RETRIEVAL_FAILED", f"Could not search the materials: {exc}", True)

    history = chat_service.clean_history([turn.model_dump() for turn in payload.history])
    events = chat_service.stream_answer(LLMFactory.get_provider(), chunks, payload.question, history)
    return StreamingResponse(
        _ndjson(events),
        media_type="application/x-ndjson",
        # No proxy may hold the stream back.
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )

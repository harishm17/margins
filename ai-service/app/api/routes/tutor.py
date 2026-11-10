"""Practice and reader tutor endpoints.

The Next.js server picks the move and the rung and sends them with the problem, the authored
answers and the student's working; the browser never calls these routes. The reply has been through
the leak check before it comes back (see app/services/tutor).
"""
import logging
from typing import List, Literal, Union

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api.disconnect import run_unless_disconnected
from app.services import ai_status
from app.services.budget import over_budget_message, record_usage_event
from app.services.llm.base import LLMUsage
from app.services.llm.schemas import PracticeTutorReply, PracticeTutorRequest, ReaderCheckReply, ReaderTutorRequest
from app.services.llm.usage import ledger_figures, track_llm_usage
from app.services.tutor.practice import tutor_reply
from app.services.tutor.reader import reader_reply

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tutor")

# Sent only by evals/tutoring: adds `claimed_rung` (the model's own rung before it is clamped) and `rejected_drafts`.
EVAL_HEADER = "x-margins-eval"


async def _record_usage(payload: Union[PracticeTutorRequest, ReaderTutorRequest], usages: List[LLMUsage]) -> None:
    """One ledger row for the reply (the tutor call and the leak checks), so it counts toward the budget."""
    if not payload.user_id or not usages:
        return
    await record_usage_event(
        user_id=payload.user_id,
        project_id=payload.project_id,
        source="tutor",
        source_id=payload.session_id or "",
        **ledger_figures(usages),
    )


@router.post("/practice", response_model=PracticeTutorReply)
async def practice(payload: PracticeTutorRequest, request: Request) -> Union[PracticeTutorReply, JSONResponse]:
    """One tutor reply for the move and rung given: at most 80 words, checked for leaks.

    `leaked` says a generation was held back as a leak; `from_authored_hint` says the reply is the
    authored hint of the rung because the second generation leaked too. Model failures and an AI
    marked unavailable are typed errors (main.py); a user over the daily budget gets a 429 with the
    same body shape.
    """
    unavailable = (await ai_status.get_status()).as_error()
    if unavailable is not None:
        raise unavailable  # typed 502/503 by the LLMError handler in main.py
    if payload.user_id:
        over_budget = await over_budget_message(payload.user_id)
        if over_budget:
            return JSONResponse(
                status_code=429,
                content={"detail": over_budget, "error_code": "LLM_DAILY_BUDGET", "retryable": False},
            )
    with track_llm_usage() as usages:
        try:
            reply = await run_unless_disconnected(request, tutor_reply(payload))
            if request.headers.get(EVAL_HEADER) == "1":
                # The tutoring eval reads the rung the model claimed, which the reply clamps, and the drafts held back.
                return JSONResponse(
                    {
                        **reply.model_dump(),
                        "claimed_rung": reply.claimed_rung,
                        "rejected_drafts": [d.model_dump() for d in reply.rejected_drafts],
                    }
                )
            return reply
        finally:
            await _record_usage(payload, usages)


class ReaderReply(BaseModel):
    """What the route returns for a passage (an explanation or a restatement): the statements and the one check question that ends them."""

    reply: str
    check_question: str


class ReaderCheckAnswer(BaseModel):
    """What the route returns for the student's answer to a check question: a verdict, one line, and one more question when the answer is not right."""

    verdict: Literal["right", "partly", "not_yet"]
    reply: str
    follow_up_question: str
    # The reply is the fixed fallback because two generations leaked: the verdict was not made from the answer.
    from_fallback: bool = False


@router.post("/reader", response_model=Union[ReaderCheckAnswer, ReaderReply])
async def reader(payload: ReaderTutorRequest, request: Request) -> Union[ReaderCheckAnswer, ReaderReply, JSONResponse]:
    """One reply about one passage after the student's own take, with one check question.

    A question the passage's source claims answer is held to the leak check (see app/services/tutor/reader.py).
    Model failures and an AI marked unavailable are typed errors (main.py); a user over the daily budget
    gets a 429 with the same body shape as the practice tutor.
    """
    unavailable = (await ai_status.get_status()).as_error()
    if unavailable is not None:
        raise unavailable
    if payload.user_id:
        over_budget = await over_budget_message(payload.user_id)
        if over_budget:
            return JSONResponse(
                status_code=429,
                content={"detail": over_budget, "error_code": "LLM_DAILY_BUDGET", "retryable": False},
            )
    with track_llm_usage() as usages:
        try:
            out = await run_unless_disconnected(request, reader_reply(payload))
            if isinstance(out, ReaderCheckReply):
                return ReaderCheckAnswer(verdict=out.verdict, reply=out.reply, follow_up_question=out.follow_up_question, from_fallback=out.from_fallback)
            return ReaderReply(reply=out.reply, check_question=out.check_question)
        finally:
            await _record_usage(payload, usages)

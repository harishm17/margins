"""Synchronous grading for quizzes and voice drills.

The caller (the Next.js server) loads the questions, with their answer keys, from its own
database and sends them here with the student's answers. The browser never calls this
route, and nothing here reads keys from anywhere else.
"""
import math
from typing import Any, Dict, List, Literal, Optional, Union

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services import ai_status
from app.services.billing import billed
from app.services.exam_grader import ExamGrader
from app.services.llm.schemas import RecallGradeRequest, RecallGradeResult
from app.services.recall_grader import grade_recall

router = APIRouter(prefix="/grade")

MAX_QUESTIONS = 100
MAX_ANSWER_CHARS = 5000
MAX_THINKING_CHARS = 4000

AnswerValue = Union[str, int, float, bool, None]


class GradableQuestion(BaseModel):
    """A stored question. Extra fields (options, sample_answer, key_points...) pass through."""

    model_config = ConfigDict(extra="allow")

    question_type: Literal["multiple_choice", "true_false", "numerical", "short_answer"]
    question_text: str
    points: float = 1

    @field_validator("points", mode="before")
    @classmethod
    def _usable_points(cls, value: Any) -> float:
        try:
            points = float(value)
        except (TypeError, ValueError):
            return 1
        return points if math.isfinite(points) and points > 0 else 1


class RichAnswer(BaseModel):
    """An answer with the student's own account of how they got there (confidence is not read here)."""

    model_config = ConfigDict(extra="ignore")

    answer: AnswerValue = None
    thinking: Optional[str] = Field(default=None, max_length=MAX_THINKING_CHARS)


class GradeQuizRequest(BaseModel):
    # The model-graded items are billed to this user and project (billing.py). A quiz of rule-graded items only never
    # calls the model, so it stays free whatever the allowance.
    user_id: str = Field(min_length=1, max_length=100)
    project_id: str = Field(min_length=1, max_length=100)
    questions: List[GradableQuestion] = Field(min_length=1, max_length=MAX_QUESTIONS)
    answers: Dict[str, Union[AnswerValue, RichAnswer]] = Field(
        default_factory=dict,
        description="question index -> answer, or {answer, thinking} when the student showed their thinking",
    )

    @field_validator("answers")
    @classmethod
    def _short_answers(cls, answers: Dict[str, Any]) -> Dict[str, Any]:
        for value in answers.values():
            answer = value.answer if isinstance(value, RichAnswer) else value
            if isinstance(answer, str) and len(answer) > MAX_ANSWER_CHARS:
                raise ValueError(f"answers are limited to {MAX_ANSWER_CHARS} characters")
        return answers

    def plain_answers(self) -> Dict[str, AnswerValue]:
        """The answers alone, whichever form they came in."""
        return {key: value.answer if isinstance(value, RichAnswer) else value for key, value in self.answers.items()}

    def thinking(self) -> Dict[str, str]:
        """The thinking the student wrote, by question index."""
        return {
            key: value.thinking
            for key, value in self.answers.items()
            if isinstance(value, RichAnswer) and value.thinking and value.thinking.strip()
        }


class GradeQuizResponse(BaseModel):
    graded_questions: List[Dict[str, Any]]
    total_points: float
    earned_points: float
    overall_score: float
    # True when a short answer could not be graded (model failure). The caller should not
    # store the attempt: those answers scored 0 only because grading was unavailable.
    needs_review: bool
    graded_at: Optional[str] = None


@router.post("/quiz", response_model=GradeQuizResponse)
async def grade_quiz(payload: GradeQuizRequest) -> GradeQuizResponse:
    """Grade answers against the supplied questions: by rule where possible, Claude for short answers. A quiz with
    short answers over the daily allowance gets a 429 LLM_DAILY_BUDGET (main.py)."""
    async with billed(payload.user_id, payload.project_id, "quiz"):
        result = await ExamGrader().grade_submission(
            "quiz",
            [question.model_dump() for question in payload.questions],
            payload.plain_answers(),
            payload.thinking(),
        )
    return GradeQuizResponse(
        graded_questions=result["graded_questions"],
        total_points=result["total_points"],
        earned_points=result["earned_points"],
        overall_score=result["overall_score"],
        needs_review=any(q.get("needs_review") for q in result["graded_questions"]),
        graded_at=result["graded_at"],
    )


@router.post("/recall", response_model=RecallGradeResult, response_model_exclude={"analysis"})
async def grade_recall_answer(payload: RecallGradeRequest) -> RecallGradeResult:
    """Verdicts on what a student recalled, claim by claim, or one clarifying question when the answer can't be graded.

    Model failures and an AI marked unavailable are typed errors (main.py); a user over the daily allowance gets
    a 429 LLM_DAILY_BUDGET with the same body shape as the tutor routes.
    """
    unavailable = (await ai_status.get_status()).as_error()
    if unavailable is not None:
        raise unavailable
    async with billed(payload.user_id, payload.project_id, "recall", payload.session_id):
        return await grade_recall(payload)

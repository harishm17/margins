"""Pydantic models for job processing."""
from datetime import datetime
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class JobPayload(BaseModel):
    """Payload the dispatcher posts to a job endpoint."""

    jobId: str
    jobType: str
    data: Dict[str, Any]


class MaterialValidationInput(BaseModel):
    """Input for material validation job."""

    materialId: str


class ContentGenerationInput(BaseModel):
    """Input for content generation job."""

    topicId: str
    contentType: str  # section_notes, solved_examples, interactive_examples, topic_quiz
    preferences: Dict[str, Any] = Field(default_factory=dict)


class ExamGenerationInput(BaseModel):
    """Input for exam generation job."""

    projectId: str
    topicIds: list[str]
    config: Dict[str, Any]  # total_questions, duration_minutes, question_type_distribution, difficulty_level


class JobUpdateData(BaseModel):
    """Data for updating job status."""

    status: str
    progress_percent: int = 0
    result_data: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None

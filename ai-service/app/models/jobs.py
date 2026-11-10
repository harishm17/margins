"""Pydantic models for job processing."""
from datetime import datetime
from typing import Any, Dict, Optional
from pydantic import AliasChoices, BaseModel, ConfigDict, Field


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
    contentType: str  # concepts, warmup, section_notes, solved_examples, interactive_examples, topic_quiz
    preferences: Dict[str, Any] = Field(default_factory=dict)


class ConceptExtractionInput(BaseModel):
    """Input for the concept extraction job."""

    topicId: str


class ConceptRequoteInput(BaseModel):
    """Input for the requote_concepts job: the topic whose claimless concepts get new claims, and its course. The web app
    writes camelCase keys like every other job; snake_case is accepted too."""

    model_config = ConfigDict(populate_by_name=True)

    topicId: str = Field(validation_alias=AliasChoices("topicId", "topic_id"))
    projectId: str = Field(validation_alias=AliasChoices("projectId", "project_id"))


class ConceptLinkingInput(BaseModel):
    """Input for the concept linking job."""

    unitId: str


class ReviewItemRequest(BaseModel):
    """Concepts that need a new review item in one mode and difficulty."""

    conceptIds: list[str]
    mode: str  # recall, discrimination, composition
    difficulty: str  # easy, medium, hard


class ReviewItemsInput(BaseModel):
    """Input for the review-item job: one topic, and what its concepts need."""

    topicId: str
    requests: list[ReviewItemRequest]


class GapExplainerInput(BaseModel):
    """Input for the gap-explainer job: one recall attempt."""

    attemptId: str


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

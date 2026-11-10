"""Validation errors name the field that failed, never the value (finding 91).

Pydantic's default message prints the input: for `Settings()` that is every environment value,
secrets included; for a job, the student's text; for a model reply, the model's output. These
tests send a sentinel through each path and check it never comes back in the error text.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.services.job_runner import PermanentJobError, parse_input
from app.services.llm.anthropic_provider import AnthropicProvider
from app.services.llm.base import LLMMessage, LLMOutputError

SENTINEL = "sentinel-value-7f3a9c"


class _Input(BaseModel):
    topic_id: str
    count: int


def test_settings_error_names_the_missing_field_and_hides_every_value(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", SENTINEL)
    monkeypatch.setenv("AI_INTERNAL_TOKEN", SENTINEL)

    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=None)

    message = str(caught.value)
    assert "DATABASE_URL" in message
    assert SENTINEL not in message


def test_bad_job_input_names_the_field_and_hides_the_student_text():
    with pytest.raises(PermanentJobError) as caught:
        parse_input(_Input, {"topic_id": "t1", "count": SENTINEL})

    assert "count" in str(caught.value)
    assert SENTINEL not in str(caught.value)


@pytest.mark.asyncio
async def test_a_model_reply_that_misses_the_schema_is_not_echoed():
    provider = AnthropicProvider.__new__(AnthropicProvider)
    reply = '{"topic_id": "t1", "count": "' + SENTINEL + '"}'
    provider._create = AsyncMock(return_value=(reply, None, None))

    with pytest.raises(LLMOutputError) as caught:
        await provider.generate_structured(
            [LLMMessage(role="user", content="q")], _Input, purpose="topic_quiz"
        )

    assert "_Input" in str(caught.value)
    assert "count" in str(caught.value)
    assert SENTINEL not in str(caught.value)

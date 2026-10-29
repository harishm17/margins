"""Tests for the Claude provider, the mock provider and the factory."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import anthropic
import httpx2
import pytest
from pydantic import BaseModel

from app.services.llm.anthropic_provider import AnthropicProvider
from app.services.llm.base import (
    LLMAuthError,
    LLMCreditError,
    LLMMessage,
    LLMNotConfiguredError,
    LLMOutputError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMRequestError,
    LLMUnavailableError,
)
from app.services.llm.factory import LLMFactory
from app.services.llm.observed import ObservedProvider
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import MaterialCheck, QuestionSet
from app.services.llm.usage import summarize_usage, track_llm_usage


class Verdict(BaseModel):
    ok: bool
    reason: str


def _usage(input_tokens=100, output_tokens=20, cache_read=0, cache_write=0):
    return SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_input_tokens=cache_read,
        cache_creation_input_tokens=cache_write,
    )


def _response(*texts, stop_reason="end_turn", model="claude-opus-5-5", content=None, stop_details=None):
    blocks = content if content is not None else [SimpleNamespace(type="text", text=t) for t in texts]
    return SimpleNamespace(
        model=model,
        stop_reason=stop_reason,
        stop_details=stop_details,
        content=blocks,
        usage=_usage(),
    )


def _provider(reply) -> tuple[AnthropicProvider, AsyncMock]:
    provider = AnthropicProvider(api_key="test-key")
    create = AsyncMock(side_effect=reply) if isinstance(reply, BaseException) else AsyncMock(return_value=reply)
    provider.client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    return provider, create


MESSAGES = [
    LLMMessage(role="system", content="You are a grader."),
    LLMMessage(role="user", content="Shared excerpts", cache=True),
    LLMMessage(role="user", content="Task instructions"),
]


class TestRequestShape:
    @pytest.mark.asyncio
    async def test_main_model_request(self):
        provider, create = _provider(_response('{"ok": true, "reason": "fine"}'))
        await provider.generate_structured(MESSAGES, Verdict, max_tokens=4000, purpose="topic_quiz")

        params = create.call_args.kwargs
        assert params["model"] == "claude-opus-5-5"
        assert params["max_tokens"] == 4000
        # Only the block a message marks is cached; consecutive user turns merge into one message.
        assert params["system"] == [{"type": "text", "text": "You are a grader."}]
        assert len(params["messages"]) == 1
        first, second = params["messages"][0]["content"]
        assert first["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in second
        assert params["output_config"]["effort"] == "medium"
        assert params["output_config"]["format"]["type"] == "json_schema"
        assert params["output_config"]["format"]["schema"]["additionalProperties"] is False
        # Opus gets the server-side refusal fallback.
        assert params["fallbacks"] == "default"
        assert params["betas"] == ["server-side-fallback-2026-07-01"]
        assert "thinking" not in params and "temperature" not in params

    @pytest.mark.asyncio
    async def test_fast_model_without_fallback(self):
        provider, create = _provider(_response("text", model="claude-haiku-5-5"))
        await provider.generate_text([LLMMessage(role="user", content="hi")], purpose="validate_material")

        params = create.call_args.kwargs
        assert params["model"] == "claude-haiku-5-5"
        assert params["output_config"] == {"effort": "low"}
        assert "fallbacks" not in params and "betas" not in params
        assert "system" not in params

    def test_missing_key_is_a_configuration_error(self):
        with pytest.raises(LLMNotConfiguredError):
            AnthropicProvider(api_key="")


class TestResponses:
    @pytest.mark.asyncio
    async def test_structured_output_is_validated(self):
        provider, _ = _provider(_response('{"ok": true, "reason": "fine"}'))
        result = await provider.generate_structured(MESSAGES, Verdict, purpose="topic_quiz")
        assert result == Verdict(ok=True, reason="fine")

    @pytest.mark.asyncio
    async def test_schema_mismatch_is_an_output_error(self):
        provider, _ = _provider(_response('{"ok": "maybe"}'))
        with pytest.raises(LLMOutputError, match="Verdict"):
            await provider.generate_structured(MESSAGES, Verdict, purpose="topic_quiz")

    @pytest.mark.asyncio
    async def test_empty_text_is_an_output_error(self):
        provider, _ = _provider(_response("   "))
        with pytest.raises(LLMOutputError, match="no text"):
            await provider.generate_text(MESSAGES, purpose="section_notes")

    @pytest.mark.asyncio
    async def test_truncated_output_is_an_output_error(self):
        provider, _ = _provider(_response('{"ok": tr', stop_reason="max_tokens"))
        with pytest.raises(LLMOutputError, match="max_tokens"):
            await provider.generate_structured(MESSAGES, Verdict, purpose="topic_quiz")

    @pytest.mark.asyncio
    async def test_refusal_is_not_retryable(self):
        provider, _ = _provider(
            _response("", stop_reason="refusal", stop_details=SimpleNamespace(category="cyber"))
        )
        with pytest.raises(LLMRefusalError, match="cyber") as excinfo:
            await provider.generate_text(MESSAGES, purpose="section_notes")
        assert excinfo.value.retryable is False

    @pytest.mark.asyncio
    async def test_only_text_after_a_fallback_block_counts(self):
        content = [
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text='{"ok": false, "re'),
            SimpleNamespace(type="fallback"),
            SimpleNamespace(type="text", text='{"ok": true, "reason": "rescued"}'),
        ]
        provider, _ = _provider(_response(content=content))
        result = await provider.generate_structured(MESSAGES, Verdict, purpose="topic_quiz")
        assert result.reason == "rescued"

    @pytest.mark.asyncio
    async def test_usage_is_recorded_with_cost(self):
        provider, _ = _provider(_response("hello"))
        with track_llm_usage() as usages:
            await provider.generate_text(MESSAGES, purpose="section_notes")
            await provider.generate_text(MESSAGES, purpose="section_notes")
        assert [u.purpose for u in usages] == ["section_notes", "section_notes"]
        summary = summarize_usage(usages)
        assert summary["calls"] == 2
        assert summary["input_tokens"] == 200
        # 200 input at $4/M + 40 output at $20/M
        assert summary["estimated_cost_usd"] == pytest.approx(0.0016)


def _status_error(cls, status, message="error"):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(message, response=httpx2.Response(status, request=request), body=None)


class TestErrorTranslation:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "error,expected,retryable",
        [
            (_status_error(anthropic.AuthenticationError, 401), LLMAuthError, False),
            (_status_error(anthropic.PermissionDeniedError, 403), LLMAuthError, False),
            (
                _status_error(anthropic.BadRequestError, 400, "Your credit balance is too low"),
                LLMCreditError,
                False,
            ),
            (_status_error(anthropic.BadRequestError, 400, "max_tokens too large"), LLMRequestError, False),
            (_status_error(anthropic.NotFoundError, 404, "model not found"), LLMRequestError, False),
            (_status_error(anthropic.RateLimitError, 429), LLMRateLimitError, True),
            (_status_error(anthropic.OverloadedError, 529), LLMUnavailableError, True),
            (_status_error(anthropic.InternalServerError, 500), LLMUnavailableError, True),
            (
                anthropic.APITimeoutError(request=httpx2.Request("POST", "https://api.anthropic.com")),
                LLMUnavailableError,
                True,
            ),
        ],
    )
    async def test_sdk_errors_map_to_typed_errors(self, error, expected, retryable):
        provider, _ = _provider(error)
        with pytest.raises(expected) as excinfo:
            await provider.generate_text(MESSAGES, purpose="section_notes")
        assert excinfo.value.retryable is retryable


class TestMockProvider:
    @pytest.mark.asyncio
    async def test_returns_schema_examples(self):
        provider = MockProvider()
        check = await provider.generate_structured(MESSAGES, MaterialCheck, purpose="validate_material")
        assert check.is_valid is True
        questions = await provider.generate_structured(MESSAGES, QuestionSet, purpose="topic_quiz")
        assert len(questions.usable()) == 24
        text = await provider.generate_text(MESSAGES, purpose="section_notes")
        assert "mock" in text.content.lower()

    @pytest.mark.asyncio
    async def test_mock_question_set_covers_every_type_with_distinct_valid_questions(self):
        questions = (await MockProvider().generate_structured(MESSAGES, QuestionSet, purpose="topic_quiz")).usable()

        by_type = {}
        for question in questions:
            by_type.setdefault(question["question_type"], []).append(question)
        assert {t: len(qs) for t, qs in by_type.items()} == {
            "multiple_choice": 6, "true_false": 6, "short_answer": 6, "numerical": 6,
        }
        assert len({q["question_text"] for q in questions}) == len(questions)
        for question in by_type["multiple_choice"]:
            texts = [o["text"] for o in question["options"]]
            assert len(set(texts)) == len(texts) == 4
            assert question["correct_answer"] in {o["id"] for o in question["options"]}

    @pytest.mark.asyncio
    async def test_schema_without_example_fails_clearly(self):
        with pytest.raises(LLMOutputError, match="Verdict"):
            await MockProvider().generate_structured(MESSAGES, Verdict, purpose="topic_quiz")


class TestFactory:
    def teardown_method(self):
        LLMFactory.reset()

    def test_anthropic_provider(self):
        with patch("app.services.llm.factory.settings") as settings:
            settings.LLM_PROVIDER = "anthropic"
            settings.ANTHROPIC_API_KEY = "test-key"
            settings.LLM_TIMEOUT_SECONDS = 30
            settings.LLM_MAX_RETRIES = 2
            LLMFactory.reset()
            provider = LLMFactory.get_provider()
            # Every caller gets the configured provider wrapped so its calls feed the AI status.
            assert isinstance(provider, ObservedProvider)
            assert isinstance(provider.inner, AnthropicProvider)
            assert provider.model_for("validate_material") == "claude-haiku-5-5"
            assert LLMFactory.get_provider() is provider

    def test_mock_provider(self):
        with patch("app.services.llm.factory.settings") as settings:
            settings.LLM_PROVIDER = "mock"
            LLMFactory.reset()
            assert isinstance(LLMFactory.get_provider().inner, MockProvider)

    def test_unknown_provider(self):
        with patch("app.services.llm.factory.settings") as settings:
            settings.LLM_PROVIDER = "openai"
            LLMFactory.reset()
            with pytest.raises(LLMNotConfiguredError):
                LLMFactory.get_provider()

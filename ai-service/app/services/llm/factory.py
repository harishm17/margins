"""Factory for the configured LLM provider."""
from typing import Optional

from app.config import settings
from app.services.llm.base import LLMNotConfiguredError, LLMProvider


class LLMFactory:
    """Creates the provider once per process."""

    _instance: Optional[LLMProvider] = None

    @classmethod
    def get_provider(cls) -> LLMProvider:
        if cls._instance is None:
            cls._instance = cls._create_provider()
        return cls._instance

    @classmethod
    def _create_provider(cls) -> LLMProvider:
        from app.services.llm.observed import ObservedProvider

        # Every call reports to the shared AI status (app/services/ai_status.py).
        return ObservedProvider(cls._create_inner())

    @classmethod
    def _create_inner(cls) -> LLMProvider:
        provider_name = settings.LLM_PROVIDER.lower()

        if provider_name == "anthropic":
            from app.services.llm.anthropic_provider import AnthropicProvider

            return AnthropicProvider(
                api_key=settings.ANTHROPIC_API_KEY,
                timeout=settings.LLM_TIMEOUT_SECONDS,
                max_retries=settings.LLM_MAX_RETRIES,
            )
        if provider_name == "replay":
            # Settings refuses this at startup; checked again here in case the setting was changed after.
            if settings.is_production:
                raise LLMNotConfiguredError("LLM_PROVIDER=replay is not allowed when ENVIRONMENT=production")
            from app.services.llm.anthropic_provider import AnthropicProvider
            from app.services.llm.replay_provider import ReplayProvider

            on_miss = settings.LLM_REPLAY_MISS.strip().lower()
            inner = None
            if on_miss == "record":
                inner = AnthropicProvider(
                    api_key=settings.ANTHROPIC_API_KEY,
                    timeout=settings.LLM_TIMEOUT_SECONDS,
                    max_retries=settings.LLM_MAX_RETRIES,
                )
            return ReplayProvider(settings.LLM_CASSETTE_DIR, on_miss=on_miss, inner=inner)
        if provider_name == "mock":
            # Settings refuses this at startup; checked again here in case the setting was changed after.
            if settings.is_production:
                raise LLMNotConfiguredError("LLM_PROVIDER=mock is not allowed when ENVIRONMENT=production")
            from app.services.llm.mock_provider import MockProvider

            return MockProvider()
        raise LLMNotConfiguredError(f"Unknown LLM_PROVIDER: {provider_name} (use anthropic, mock or replay)")

    @classmethod
    def reset(cls):
        """Reset singleton (useful for testing)."""
        cls._instance = None

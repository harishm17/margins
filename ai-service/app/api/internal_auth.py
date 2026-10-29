"""Shared-secret check for calls into the AI service.

Only the Margins web app (and this service calling itself) may start jobs or voice
sessions. Every router except health checks depends on `require_internal_token`.
"""
import hmac
from typing import Dict, Optional

from fastapi import Header, HTTPException

from app.config import settings

INTERNAL_TOKEN_HEADER = "x-ai-internal-token"


def require_internal_token(
    x_ai_internal_token: Optional[str] = Header(default=None),
) -> None:
    expected = settings.AI_INTERNAL_TOKEN
    if not expected:
        # Local development runs without a token; anything else fails closed.
        if settings.is_development:
            return
        raise HTTPException(status_code=503, detail="AI_INTERNAL_TOKEN is not configured")
    if not x_ai_internal_token or not hmac.compare_digest(
        x_ai_internal_token.encode(), expected.encode()
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


def internal_headers() -> Dict[str, str]:
    """Headers for this service's own calls back into its job routes."""
    headers = {"Content-Type": "application/json"}
    if settings.AI_INTERNAL_TOKEN:
        headers[INTERNAL_TOKEN_HEADER] = settings.AI_INTERNAL_TOKEN
    return headers

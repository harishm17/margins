"""GET /status/ai: whether AI features can be used now, and a user's allowance for today.

Called by the web app's server (getAiStatus) before it starts any model work, and for the banner
and the disabled AI buttons. Dollar figures stay on the server: the web app turns them into a
share of the allowance before anything reaches a browser.
"""
from typing import Optional

from fastapi import APIRouter

from app.config import settings
from app.services import ai_status
from app.services.budget import global_spent_today_usd, spent_today_usd

router = APIRouter(prefix="/status")


def _iso(value) -> Optional[str]:
    return value.isoformat().replace("+00:00", "Z") if value else None


@router.get("/ai")
async def ai_status_route(user_id: Optional[str] = None):
    status = await ai_status.get_status()
    resets_at = _iso(ai_status.next_reset_utc())

    global_budget = settings.GLOBAL_DAILY_LLM_BUDGET_USD
    global_cap_hit = global_budget > 0 and await global_spent_today_usd() >= global_budget

    allowance = None
    if user_id:
        limit = settings.DAILY_LLM_BUDGET_USD
        allowance = {
            "used": round(await spent_today_usd(user_id), 6),
            # None: no per-user cap.
            "limit": limit if limit > 0 else None,
            "resets_at": resets_at,
        }

    return {
        "available": status.available,
        "reason": status.reason,
        "since": _iso(status.since) if not status.available else None,
        "allowance": allowance,
        "global_cap_hit": global_cap_hit,
        "resets_at": resets_at,
    }

"""Health endpoints (SEC-L4, OPS-L1, OPS-H3).

`/health` is public and says only pass or fail: 200 `{"status": "ok"}` once the database answers and holds the
migration this code needs (app/db/schema_version.py), 503 `{"status": "unavailable"}` otherwise. Railway's deploy
healthcheck and the web app's /api/health/ready read it.

`/health/dependencies` is the detail (database, migration, provider status, configuration, watchdog and backup
facts) and needs the internal token like every other route.
"""
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.api.internal_auth import require_internal_token
from app.config import settings
from app.db.connection import get_db_pool
from app.db.schema_version import REQUIRED_MIGRATION, migration_applied
from app.services import ops
from app.services.ai_status import get_status as get_ai_status

logger = logging.getLogger(__name__)
router = APIRouter()


async def ready() -> bool:
    """The database answers and holds the migration this code needs."""
    try:
        pool = await get_db_pool()
        await pool.fetchval("SELECT 1")
        return await migration_applied()
    except Exception as exc:
        logger.warning("Health check: not ready: %s", exc)
        return False


@router.get("/health")
async def health_check():
    if await ready():
        return {"status": "ok"}
    return JSONResponse({"status": "unavailable"}, status_code=503)


def _check(name: str, ok: bool, good: str, bad: str, severity: str = "warn") -> dict:
    return {"name": name, "status": "pass" if ok else severity, "message": good if ok else bad}


@router.get("/health/dependencies", dependencies=[Depends(require_internal_token)])
async def dependency_health_check():
    """Every dependency's state, for the operator (needs the internal token)."""
    checks = []

    try:
        pool = await get_db_pool()
        await pool.fetchval("SELECT 1")
        checks.append(_check("database", True, "Database reachable", ""))
        checks.append(_check("migration", await migration_applied(), f"{REQUIRED_MIGRATION} applied",
                             f"Waiting for migration {REQUIRED_MIGRATION}", "fail"))
        for key in ("watchdog_last_run", "backup_last_success", "voice_retention_last_run", "embedding_model"):
            value = await ops.get_state(key)
            checks.append(_check(key, bool(value), value or "", "not recorded"))
    except Exception as exc:
        checks.append(_check("database", False, "", f"Database check failed: {exc}", "fail"))

    checks.append(_check("llm_key", settings.llm_configured, f"LLM provider {settings.LLM_PROVIDER} configured",
                         "ANTHROPIC_API_KEY missing", "fail"))
    # A key being set says nothing about credit (app/services/ai_status.py; the status comes from real calls).
    status = await get_ai_status()
    checks.append(_check("llm_status", status.available, "No provider failure on record",
                         f"AI marked unavailable ({status.reason}) since {status.since}"))
    checks.append(_check("voice", settings.voice_enabled, "Voice coach available", "LLM not configured: voice is off"))
    checks.append(_check("internal_token", bool(settings.AI_INTERNAL_TOKEN), "AI_INTERNAL_TOKEN configured",
                         "AI_INTERNAL_TOKEN not set (allowed in local/dev only)"))
    s3 = bool(settings.S3_ACCESS_KEY_ID and settings.S3_SECRET_ACCESS_KEY)
    checks.append(_check("s3_config", s3, "S3 credentials configured", "No S3 credentials (local file mode)"))
    checks.append(_check("alerts", bool(settings.OPS_ALERT_WEBHOOK_URL.strip()), "Alert webhook configured",
                         "OPS_ALERT_WEBHOOK_URL not set: alerts are only logged"))

    has_fail = any(check["status"] == "fail" for check in checks)
    has_warn = any(check["status"] == "warn" for check in checks)
    return {
        "status": "unhealthy" if has_fail else ("degraded" if has_warn else "healthy"),
        "service": "margins-ai",
        "environment": settings.ENVIRONMENT,
        "checks": checks,
    }


@router.get("/")
async def root():
    return {"status": "ok"}

"""Health check endpoints."""
from fastapi import APIRouter

from app.config import settings
from app.db.connection import get_db_pool

router = APIRouter()


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "margins-ai",
        "environment": settings.ENVIRONMENT,
        "llm_provider": settings.LLM_PROVIDER,
        "voice_enabled": settings.voice_enabled,
    }


@router.get("/health/dependencies")
async def dependency_health_check():
    """Dependency-oriented health checks for deployment validation."""
    checks = []

    # Database reachability
    try:
        pool = await get_db_pool()
        await pool.fetchval("SELECT 1")
        checks.append({"name": "database", "status": "pass", "message": "Database reachable"})
    except Exception as exc:  # pragma: no cover - surfaced in runtime
        checks.append({
            "name": "database",
            "status": "fail",
            "message": f"Database connection failed: {exc}",
        })

    # Claude key: needed for validation, topics, generation and grading
    if settings.llm_configured:
        checks.append({
            "name": "llm_key",
            "status": "pass",
            "message": f"LLM provider {settings.LLM_PROVIDER} configured",
        })
    else:
        checks.append({"name": "llm_key", "status": "fail", "message": "ANTHROPIC_API_KEY missing"})

    # The voice coach is a Claude conversation: it is on whenever the LLM is configured
    if settings.voice_enabled:
        checks.append({"name": "voice", "status": "pass", "message": "Voice coach available (LLM configured)"})
    else:
        checks.append({
            "name": "voice",
            "status": "warn",
            "message": "LLM not configured: the voice coach is turned off",
        })

    # Internal auth token for frontend -> AI bridge
    if settings.AI_INTERNAL_TOKEN:
        checks.append({
            "name": "internal_token",
            "status": "pass",
            "message": "AI_INTERNAL_TOKEN configured",
        })
    else:
        checks.append({
            "name": "internal_token",
            "status": "warn",
            "message": "AI_INTERNAL_TOKEN not set (allowed in local/dev, not recommended in production)",
        })

    # Storage mode sanity
    if settings.S3_ACCESS_KEY_ID and settings.S3_SECRET_ACCESS_KEY:
        checks.append({
            "name": "s3_config",
            "status": "pass",
            "message": "S3 credentials configured",
        })
    else:
        checks.append({
            "name": "s3_config",
            "status": "warn",
            "message": "No S3 credentials (local file mode expected if frontend uses local storage)",
        })

    has_fail = any(check["status"] == "fail" for check in checks)
    has_warn = any(check["status"] == "warn" for check in checks)
    status = "unhealthy" if has_fail else ("degraded" if has_warn else "healthy")

    return {
        "status": status,
        "service": "margins-ai",
        "environment": settings.ENVIRONMENT,
        "checks": checks,
    }


@router.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "StudyBuddy AI Service",
        "version": "0.1.0",
        "status": "running",
    }

"""Main FastAPI application for StudyBuddy AI service."""
import asyncio
from contextlib import asynccontextmanager
import logging

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.internal_auth import require_internal_token
from app.api.routes import health
from app.config import settings
from app.logging_utils import configure_sensitive_data_redaction
from app.services.job_runner import retry_after
from app.services.llm.base import LLMError

configure_sensitive_data_redaction()
logger = logging.getLogger(__name__)

async def _run_startup_checks() -> None:
    """Initialize services on startup."""
    logger.info("StudyBuddy AI Service starting in %s mode", settings.ENVIRONMENT)
    logger.info("LLM Provider: %s", settings.LLM_PROVIDER)
    if not settings.llm_configured:
        logger.warning("ANTHROPIC_API_KEY is not set: generation, grading and validation calls will fail")
    db_info = settings.DATABASE_URL.split('@')[1] if '@' in settings.DATABASE_URL else 'configured'
    logger.info("Database: %s", db_info)

    # Validate database connection (non-blocking for Cloud Run health checks)
    # Log warnings but don't crash if DB is temporarily unavailable
    try:
        from app.db.connection import get_db_pool

        pool = await get_db_pool()
        await pool.fetchval("SELECT 1")
        logger.info("Database connection validated")

        # Check if pgvector extension exists
        extension_exists = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector')"
        )
        if not extension_exists:
            logger.warning("pgvector extension not found. Vector searches will not work.")
        else:
            logger.info("pgvector extension confirmed")
    except Exception as e:
        # Log error but don't raise - allow service to start for health checks
        # Database connections can be retried on first request
        logger.warning("Database connection failed: %s", e)
        logger.warning(
            "Service will start, but database operations may fail until connection is established."
        )


async def _run_shutdown() -> None:
    """Cleanup on shutdown."""
    from app.db.connection import close_db_pool

    await close_db_pool()
    logger.info("StudyBuddy AI Service shutting down")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await _run_startup_checks()
    reaper = None
    if settings.JOB_REAPER_INTERVAL_SECONDS > 0:
        from app.services.job_reaper import reaper_loop

        reaper = asyncio.create_task(reaper_loop())
    try:
        yield
    finally:
        if reaper is not None:
            reaper.cancel()
        await _run_shutdown()


# Create FastAPI app
app = FastAPI(
    title="StudyBuddy AI Service",
    description="AI microservice for document processing, content generation, and exam grading",
    version="0.1.0",
    docs_url="/docs" if settings.is_development else None,
    redoc_url="/redoc" if settings.is_development else None,
    lifespan=lifespan,
)

# CORS middleware
# In production, allow requests from frontend URL
# In development, allow all origins for ease of testing
frontend_url = getattr(settings, "FRONTEND_URL", None)
if settings.is_development:
    dev_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
    if frontend_url:
        dev_origins.append(frontend_url)
    # Deduplicate while preserving order
    allowed_origins = list(dict.fromkeys(dev_origins))
else:
    allowed_origins = [frontend_url] if frontend_url else [settings.AI_SERVICE_URL]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(LLMError)
async def llm_error_handler(_: Request, exc: LLMError) -> JSONResponse:
    """Model failures outside job handlers (voice drills) get a typed error, not a bare 500."""
    logger.warning("LLM error: %s: %s", exc.code, exc)
    wait = retry_after(exc)
    return JSONResponse(
        status_code=503 if exc.retryable else 502,
        content={"detail": str(exc), "error_code": exc.code, "retryable": exc.retryable},
        headers={"Retry-After": str(wait)} if wait else None,
    )


# Include routers. Health checks are public; every other route needs the internal token.
internal_only = [Depends(require_internal_token)]
app.include_router(health.router, tags=["Health"])

# Import jobs router
from app.api.routes import jobs
app.include_router(jobs.router, tags=["Jobs"], dependencies=internal_only)

# Voice coach routes
from app.api.routes import voice
app.include_router(voice.router, tags=["Voice"], dependencies=internal_only)

# Quiz and voice-answer grading (called by the Next.js server, never the browser)
from app.api.routes import grading
app.include_router(grading.router, tags=["Grading"], dependencies=internal_only)

# "Ask your materials" chat answers (streamed to the Next.js server)
from app.api.routes import chat
app.include_router(chat.router, tags=["Chat"], dependencies=internal_only)

# Whether AI features can be used now, and a user's allowance (read by the Next.js server)
from app.api.routes import status
app.include_router(status.router, tags=["Status"], dependencies=internal_only)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.is_development,
    )

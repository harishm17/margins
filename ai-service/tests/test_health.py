"""/health says pass or fail and nothing else; it passes only once the database holds this code's migration (OPS-H3,
SEC-L4, OPS-L1). The detail is /health/dependencies, behind the internal token."""
from pathlib import Path

import httpx
import pytest

from app.config import settings
from app.db import schema_version
from app.db.schema_version import REQUIRED_MIGRATION
from app.main import app

MIGRATIONS = Path(__file__).resolve().parents[2] / "frontend" / "prisma" / "migrations"


async def get(path, headers=None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path, headers=headers or {})


@pytest.fixture(autouse=True)
def fresh_gate():
    schema_version.forget()
    yield
    schema_version.forget()


def test_the_required_migration_is_the_newest():
    newest = max(path.parent.name for path in MIGRATIONS.glob("*/migration.sql"))
    assert REQUIRED_MIGRATION == newest


@pytest.mark.asyncio
async def test_without_a_database_it_fails_and_says_nothing_else(monkeypatch):
    from app.db import connection

    await connection.close_db_pool()
    monkeypatch.setattr(settings, "DATABASE_URL", "postgresql://nobody@127.0.0.1:1/none")
    response = await get("/health")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    await connection.close_db_pool()


@pytest.mark.asyncio
async def test_with_the_migration_it_passes_and_says_nothing_else(db):
    response = await get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_it_fails_until_the_migration_is_applied(db):
    await db.execute("UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name >= $1", REQUIRED_MIGRATION)
    assert (await get("/health")).status_code == 503

    await db.execute("UPDATE _prisma_migrations SET finished_at = now(), rolled_back_at = now() "
                     "WHERE migration_name >= $1", REQUIRED_MIGRATION)
    assert (await get("/health")).status_code == 503, "a rolled-back migration does not count"

    await db.execute("UPDATE _prisma_migrations SET rolled_back_at = NULL WHERE migration_name >= $1",
                     REQUIRED_MIGRATION)
    assert (await get("/health")).status_code == 200


@pytest.mark.asyncio
async def test_a_later_migration_also_counts(db):
    await db.execute("UPDATE _prisma_migrations SET migration_name = '29991231000000_later' "
                     "WHERE migration_name = $1", REQUIRED_MIGRATION)
    try:
        assert (await get("/health")).status_code == 200
    finally:
        await db.execute("UPDATE _prisma_migrations SET migration_name = $1 "
                         "WHERE migration_name = '29991231000000_later'", REQUIRED_MIGRATION)


@pytest.mark.asyncio
async def test_the_detail_needs_the_token(db, monkeypatch):
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "detail-token")
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    assert (await get("/health/dependencies")).status_code == 401

    response = await get("/health/dependencies", {"x-ai-internal-token": "detail-token"})
    assert response.status_code == 200
    names = {check["name"]: check for check in response.json()["checks"]}
    assert names["migration"]["status"] == "pass"
    assert {"database", "llm_status", "alerts", "backup_last_success", "watchdog_last_run"} <= set(names)


@pytest.mark.asyncio
async def test_the_root_says_nothing_about_the_service():
    response = await get("/")
    assert response.json() == {"status": "ok"}

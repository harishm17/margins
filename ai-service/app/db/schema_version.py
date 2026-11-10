"""The database migration this code needs before it may serve (OPS-H3).

The web app owns the schema: its Prisma migrations run as its pre-deploy step. This service reads and writes those
tables with raw SQL, and the two deploy on their own, so a new AI service could start before the migration that adds
its columns. `/health` stays unhealthy until `_prisma_migrations` holds REQUIRED_MIGRATION (or a later one), and the
deploy waits for it (the healthcheck timeout in .railway/railway.ts is longer than the web build and migration).

REQUIRED_MIGRATION is always the newest migration in frontend/prisma/migrations: CI fails otherwise
(scripts/check_migrations.py), so a migration cannot be added without this service waiting for it.
"""
from app.db.connection import execute_one

REQUIRED_MIGRATION = "20261208000000_spend_key_and_drill_sets"

_seen = {"ok": False}


async def migration_applied() -> bool:
    """Whether the database has REQUIRED_MIGRATION or a later one, finished and not rolled back. Once true it stays
    true for this process (migrations only move forward), so a healthy service does not query on every check."""
    if _seen["ok"]:
        return True
    row = await execute_one(
        """
        SELECT 1 AS ok FROM _prisma_migrations
        WHERE migration_name >= $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        LIMIT 1
        """,
        REQUIRED_MIGRATION,
    )
    _seen["ok"] = row is not None
    return _seen["ok"]


def forget() -> None:
    """Check the database again next time (tests)."""
    _seen["ok"] = False

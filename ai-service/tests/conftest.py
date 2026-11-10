import asyncio
import os
import re
from pathlib import Path

import asyncpg
import pytest
from fastapi.testclient import TestClient


def _settings_names():
    """The environment variables app/config.py reads: its upper-case fields."""
    source = (Path(__file__).resolve().parents[1] / "app" / "config.py").read_text()
    return set(re.findall(r"^    ([A-Z][A-Z0-9_]*)\s*:", source, flags=re.MULTILINE))


def pytest_configure():
    # The suite owns its configuration. A shell that has the app's or the e2e stack's variables set (the
    # database, the internal token, the service URLs, the environment, the uploads folder) must not change
    # what the tests see: they would hit a live database and the stack's token instead of their own fakes.
    # Tests that need a value set it on `settings` themselves.
    for name in _settings_names():
        os.environ.pop(name, None)
    os.environ["DATABASE_URL"] = "postgresql://user:pass@localhost:5432/margins"
    # Always a fake key, even when ai-service/.env holds a real one: tests never call the API.
    os.environ["ANTHROPIC_API_KEY"] = "test-key"
    os.environ["LLM_PROVIDER"] = "anthropic"
    os.environ["OPENAI_API_KEY"] = ""


@pytest.fixture
def sample_pdf_content():
    """Sample PDF text for testing."""
    return """
    Chapter 1: Introduction to Machine Learning

    Machine learning is a subset of artificial intelligence that enables computers to learn
    from data without being explicitly programmed. It involves the development of algorithms
    that can identify patterns in data and make predictions or decisions based on those patterns.

    Key Concepts:
    1. Supervised Learning - Learning from labeled data
    2. Unsupervised Learning - Finding patterns in unlabeled data
    3. Reinforcement Learning - Learning through trial and error

    Chapter 2: Neural Networks

    Neural networks are computing systems inspired by biological neural networks. They consist
    of interconnected nodes (neurons) organized in layers. Each connection has a weight that
    adjusts as learning proceeds.

    Types of Neural Networks:
    - Feedforward Neural Networks
    - Convolutional Neural Networks (CNNs)
    - Recurrent Neural Networks (RNNs)
    """


@pytest.fixture
def sample_chunks():
    """Sample document chunks for testing."""
    return [
        {
            "id": "chunk_1",
            "content": "Machine learning is a subset of artificial intelligence that enables computers to learn from data without being explicitly programmed.",
            "metadata": {"page": 1, "section": "Introduction"},
            "embedding": [0.1] * 1536
        },
        {
            "id": "chunk_2",
            "content": "Supervised learning involves learning from labeled data where the algorithm is trained on input-output pairs.",
            "metadata": {"page": 1, "section": "Key Concepts"},
            "embedding": [0.2] * 1536
        },
        {
            "id": "chunk_3",
            "content": "Neural networks are computing systems inspired by biological neural networks consisting of interconnected nodes.",
            "metadata": {"page": 2, "section": "Neural Networks"},
            "embedding": [0.3] * 1536
        }
    ]


@pytest.fixture
def sample_topics():
    """Sample extracted topics for testing."""
    return [
        {
            "id": "topic_1",
            "title": "Introduction to Machine Learning",
            "description": "Basic concepts and definitions of machine learning",
            "subtopics": ["Supervised Learning", "Unsupervised Learning", "Reinforcement Learning"]
        },
        {
            "id": "topic_2",
            "title": "Neural Networks",
            "description": "Architecture and types of neural networks",
            "subtopics": ["Feedforward Networks", "CNNs", "RNNs"]
        }
    ]


@pytest.fixture
def test_client():
    """FastAPI test client."""
    from app.main import app
    return TestClient(app)


# ---- A real Postgres for the job tests ----------------------------------------------------
# The claim, lease and append logic is SQL, so those tests run against a throwaway database
# built from the Prisma migrations. Point TEST_DB_ADMIN_URL at a server with pgvector. The tests skip
# when none is reachable, unless TEST_DB_ADMIN_URL is set (CI sets it): then a missing database fails them.

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "frontend" / "prisma" / "migrations"
TEST_DB_ADMIN_URL = os.environ.get("TEST_DB_ADMIN_URL", "postgresql://postgres@127.0.0.1:5544/postgres")


async def record_migrations(conn, migrations_dir: Path) -> None:
    """`_prisma_migrations` as `prisma migrate deploy` leaves it, for migrations applied as plain SQL."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS _prisma_migrations (
            id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ,
            migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    for migration in sorted(migrations_dir.glob("*/migration.sql")):
        await conn.execute(
            "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) "
            "VALUES (gen_random_uuid()::text, md5($1), now(), $2, 1)",
            migration.read_text(),
            migration.parent.name,
        )


def _swap_database(url: str, name: str) -> str:
    return url.rsplit("/", 1)[0] + "/" + name


async def _build_test_database(name: str) -> None:
    admin = await asyncpg.connect(TEST_DB_ADMIN_URL, timeout=3)
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
        await admin.execute(f'CREATE DATABASE "{name}"')
    finally:
        await admin.close()
    conn = await asyncpg.connect(_swap_database(TEST_DB_ADMIN_URL, name))
    try:
        for migration in sorted(MIGRATIONS_DIR.glob("*/migration.sql")):
            await conn.execute(migration.read_text())
        await record_migrations(conn, MIGRATIONS_DIR)
    finally:
        await conn.close()


async def _drop_test_database(name: str) -> None:
    admin = await asyncpg.connect(TEST_DB_ADMIN_URL, timeout=3)
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        await admin.close()


@pytest.fixture(scope="session")
def test_database_url():
    name = f"sb_pytest_{os.getpid()}"
    try:
        asyncio.run(_build_test_database(name))
    except Exception as exc:  # no server, no pgvector, ...
        if "TEST_DB_ADMIN_URL" in os.environ:
            pytest.fail(f"TEST_DB_ADMIN_URL is set but the test database could not be built: {exc!r}")
        pytest.skip(f"No test Postgres available ({exc!r}); set TEST_DB_ADMIN_URL")
    yield _swap_database(TEST_DB_ADMIN_URL, name)
    asyncio.run(_drop_test_database(name))


@pytest.fixture
async def db(test_database_url, monkeypatch):
    """The service's connection pool, pointed at the test database and emptied afterwards."""
    from app.config import settings
    from app.db import connection

    monkeypatch.setattr(settings, "DATABASE_URL", test_database_url)
    await connection.close_db_pool()
    pool = await connection.get_db_pool()
    try:
        yield pool
    finally:
        # A test may have closed the pool it was given.
        pool = await connection.get_db_pool()
        await pool.execute("TRUNCATE users CASCADE")
        # The shared AI status is not tied to a user: a test that marked it down must not
        # refuse the next test's calls.
        await pool.execute("DELETE FROM ai_status")
        # Nor are the ops facts, failure counts and alert cooldowns.
        await pool.execute("DELETE FROM ops_events; DELETE FROM ops_state; DELETE FROM ops_alerts")
        from app.services import ai_status, ops

        ai_status.reset_local_state()
        ops.reset_local_state()
        await connection.close_db_pool()


@pytest.fixture
def passthrough_support(monkeypatch):
    """For test files that fake the provider with one canned reply for every call: the answer-key
    support check is one more call with its own reply type, so the generators get a pass-through.
    test_support_check.py runs the real check through the real generators."""

    async def keep_all(items, chunks):
        return items, 0

    for module in ("content_generator.quiz", "exam_generator", "content_generator.warmup", "content_generator.review_items"):
        monkeypatch.setattr(f"app.services.{module}.check_support", keep_all)

import asyncio
import os
from pathlib import Path

import asyncpg
import pytest
from fastapi.testclient import TestClient


def pytest_configure():
    os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/margins")
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
# built from the Prisma migrations. Point TEST_DB_ADMIN_URL at a server with pgvector; the
# tests skip when none is reachable.

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "frontend" / "prisma" / "migrations"
TEST_DB_ADMIN_URL = os.environ.get("TEST_DB_ADMIN_URL", "postgresql://postgres@127.0.0.1:5544/postgres")


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
        from app.services import ai_status

        ai_status.reset_local_state()
        await connection.close_db_pool()

"""Writing a concept graph also converts a brand-new topic (finding 94)."""
import pytest

from app.services.concepts import store
from app.services.concepts.validate import ValidatedGraph
from app.services.llm.schemas import ExtractedConcept
from tests.db_helpers import new_id, seed_project, seed_topic, seed_user


@pytest.fixture(autouse=True)
def embeddings(monkeypatch):
    async def fake(texts):
        return [[0.1] * 384 for _ in texts]

    monkeypatch.setattr(store, "generate_embeddings", fake)


def _graph():
    return ValidatedGraph(concepts=[ExtractedConcept(key="c1", name="Mean", summary="The average.", kind="concept", objective_indexes=[], difficulty=0.3)])


async def _topic(db):
    user = await seed_user(db)
    return await seed_topic(db, await seed_project(db, user)), user


async def test_a_topic_with_no_history_is_converted_by_its_first_concepts(db):
    topic_id, _ = await _topic(db)
    await store.store_graph(topic_id, _graph())
    assert (await db.fetchrow("SELECT evidence_backfilled_at FROM topics WHERE id = $1", topic_id))["evidence_backfilled_at"] is not None


async def test_a_topic_with_quiz_history_is_left_for_the_history_conversion(db):
    topic_id, user = await _topic(db)
    await db.execute(
        "INSERT INTO quiz_attempts (id, user_id, topic_id, answers, results, score) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 50)",
        new_id(), user, topic_id,
    )
    await store.store_graph(topic_id, _graph())
    assert (await db.fetchrow("SELECT evidence_backfilled_at FROM topics WHERE id = $1", topic_id))["evidence_backfilled_at"] is None

"""Which concepts of other topics a topic's quiz and exam prompts offer as distractor targets."""
import pytest

from app.services.content_generator.context import fetch_confusable_neighbours
from tests.db_helpers import new_id, seed_project, seed_topic, seed_user


async def _concept(db, project_id, topic_id, name, status="active"):
    return await db.fetchval(
        "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index, status) "
        "VALUES ($1, $2, $3, $4, 's', 'concept', 0, $5) RETURNING id",
        new_id(), project_id, topic_id, name, status,
    )


async def _confusable(db, project_id, a, b, *, status="confirmed", confidence=0.9, edge_type="confusable"):
    low, high = sorted((a, b))
    await db.execute(
        "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
        "VALUES ($1, $2, $3, $4, $5, 1, $6, 'llm', $7)",
        new_id(), project_id, low, high, edge_type, confidence, status,
    )


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    topic = await seed_topic(db, project_id, "Spread")
    other = await seed_topic(db, project_id, "Centre")
    mine = await _concept(db, project_id, topic, "Variance")
    return db, project_id, topic, other, mine


async def test_confirmed_and_confident_proposed_edges_to_other_topics_are_offered(world):
    db, project_id, topic, other, mine = world
    confirmed = await _concept(db, project_id, other, "Mean")
    proposed = await _concept(db, project_id, other, "Median")
    weak = await _concept(db, project_id, other, "Mode")
    rejected = await _concept(db, project_id, other, "Range")
    await _confusable(db, project_id, mine, confirmed, status="confirmed", confidence=0.4)
    await _confusable(db, project_id, proposed, mine, status="proposed", confidence=0.6)
    await _confusable(db, project_id, mine, weak, status="proposed", confidence=0.59)
    await _confusable(db, project_id, mine, rejected, status="rejected", confidence=0.95)

    found = await fetch_confusable_neighbours(topic)

    assert {row["name"] for row in found} == {"Mean", "Median"}
    assert {row["id"] for row in found} == {confirmed, proposed}


async def test_same_topic_twins_other_edge_types_and_retired_concepts_are_left_out(world):
    db, project_id, topic, other, mine = world
    sibling = await _concept(db, project_id, topic, "Standard deviation")
    prerequisite = await _concept(db, project_id, other, "Count")
    retired = await _concept(db, project_id, other, "Old", status="removed")
    await _confusable(db, project_id, mine, sibling)
    await _confusable(db, project_id, mine, prerequisite, edge_type="encompasses")
    await _confusable(db, project_id, mine, retired)

    assert await fetch_confusable_neighbours(topic) == []


async def test_a_topic_with_no_edges_has_no_neighbours(world):
    _, _, topic, _, _ = world
    assert await fetch_confusable_neighbours(topic) == []

"""Generation-time mapping: topics with no mappings, or older than the newest chunk."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services.content_generator.context import NoSourceMaterialError, fetch_topic_chunks
from app.services.content_generator.notes import NotesGenerator
from app.services.embeddings import search, topic_mapping
from app.services.llm.base import LLMResponse, LLMUsage
from tests.db_helpers import add_chunk, seed_job, seed_material, seed_project, seed_topic, seed_user, unit


@pytest.fixture(autouse=True)
def query_is_e0(monkeypatch):
    async def embed(text):
        return unit(1.0)

    monkeypatch.setattr(search, "generate_query_embedding", embed)


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    material_id = await seed_material(db, project_id, status="valid")
    return {"user_id": user_id, "project_id": project_id, "material_id": material_id}


async def mapped_ids(db, topic_id):
    rows = await db.fetch(
        "SELECT chunk_id FROM topic_chunk_mappings WHERE topic_id = $1 ORDER BY relevance_score DESC, chunk_id",
        topic_id,
    )
    return [r["chunk_id"] for r in rows]


class TestEnsureTopicMappings:
    async def test_topic_without_mappings_is_mapped_and_stored(self, db, world):
        near = await add_chunk(db, world["material_id"], 0, "krebs cycle steps", unit(1.0, 0.1))
        far = await add_chunk(db, world["material_id"], 1, "unrelated filler", unit(0.0, 1.0))
        topic_id = await seed_topic(db, world["project_id"], "Krebs cycle")  # a custom topic: no keywords

        await topic_mapping.ensure_topic_mappings(topic_id, 24)

        assert await mapped_ids(db, topic_id) == [near]  # far is under the similarity floor
        row = await db.fetchrow("SELECT relevance_score, relevance_source FROM topic_chunk_mappings")
        assert row["relevance_score"] > 0 and row["relevance_source"] in {"semantic_search", "keyword_and_semantic"}
        assert far not in await mapped_ids(db, topic_id)

    async def test_current_mappings_are_not_recomputed(self, db, world, monkeypatch):
        chunk = await add_chunk(db, world["material_id"], 0, "krebs cycle steps", unit(1.0))
        topic_id = await seed_topic(db, world["project_id"], "Krebs cycle")
        await topic_mapping.ensure_topic_mappings(topic_id, 24)
        monkeypatch.setattr(topic_mapping, "hybrid_search_chunks", AsyncMock(side_effect=AssertionError("searched")))

        await topic_mapping.ensure_topic_mappings(topic_id, 24)

        assert await mapped_ids(db, topic_id) == [chunk]

    async def test_mappings_older_than_the_newest_chunk_are_recomputed(self, db, world):
        first = await add_chunk(db, world["material_id"], 0, "krebs cycle steps", unit(1.0, 0.3))
        topic_id = await seed_topic(db, world["project_id"], "Krebs cycle")
        await topic_mapping.ensure_topic_mappings(topic_id, 24)
        assert await mapped_ids(db, topic_id) == [first]

        # A file uploaded later: its chunk is newer than the mappings.
        later = await seed_material(db, world["project_id"], status="valid", filename="later.pdf")
        newer = await add_chunk(db, later, 0, "the krebs cycle again, better", unit(1.0, 0.0))
        await db.execute("UPDATE material_chunks SET created_at = created_at + interval '1 minute' WHERE id = $1", newer)

        chunks = await fetch_topic_chunks(topic_id)

        assert {c["id"] for c in chunks} == {first, newer}

    async def test_failed_refresh_keeps_stale_mappings(self, db, world, monkeypatch):
        chunk = await add_chunk(db, world["material_id"], 0, "krebs cycle steps", unit(1.0))
        topic_id = await seed_topic(db, world["project_id"], "Krebs cycle")
        await topic_mapping.ensure_topic_mappings(topic_id, 24)
        newer = await add_chunk(db, world["material_id"], 1, "more krebs", unit(1.0))
        await db.execute("UPDATE material_chunks SET created_at = created_at + interval '1 minute' WHERE id = $1", newer)
        monkeypatch.setattr(topic_mapping, "hybrid_search_chunks", AsyncMock(side_effect=RuntimeError("embedder down")))

        await topic_mapping.ensure_topic_mappings(topic_id, 24)

        assert await mapped_ids(db, topic_id) == [chunk]

def llm_returning(text):
    llm = MagicMock()
    llm.generate_text = AsyncMock(
        return_value=LLMResponse(content=text, model="m", stop_reason="end_turn", usage=LLMUsage(model="m"))
    )
    return llm


class TestGenerationFromACustomTopic:
    async def test_a_topic_the_materials_do_not_cover_still_fails_without_source_material(self, db, world, monkeypatch):
        await add_chunk(db, world["material_id"], 0, "unrelated filler", unit(0.0, 1.0))
        topic_id = await seed_topic(db, world["project_id"], "Medieval cuisine")
        monkeypatch.setattr("app.services.llm.factory.LLMFactory.get_provider", lambda *a, **k: llm_returning("x"))

        with pytest.raises(NoSourceMaterialError):
            await NotesGenerator().generate_notes(topic_id, "Medieval cuisine", "", {})


class TestGenerateContentJob:
    async def test_job_for_a_custom_topic_remaps_and_completes(self, db, world, monkeypatch):
        await add_chunk(db, world["material_id"], 0, "The krebs cycle oxidises acetyl CoA.", unit(1.0, 0.2))
        topic_id = await seed_topic(db, world["project_id"], "Krebs cycle")
        notes = "# Krebs cycle\n\n" + "The cycle oxidises acetyl CoA in the matrix. " * 40
        monkeypatch.setattr("app.services.llm.factory.LLMFactory.get_provider", lambda *a, **k: llm_returning(notes))
        job_id = await seed_job(db, world["user_id"], project_id=world["project_id"])
        payload = JobPayload(
            jobId=job_id,
            jobType="generate_content",
            data={"topicId": topic_id, "contentType": "section_notes", "preferences": {}},
        )

        result = await jobs.generate_content_job(payload)

        assert result["status"] == "success"
        assert len(await mapped_ids(db, topic_id)) == 1
        assert await db.fetchval("SELECT count(*) FROM topic_content WHERE topic_id = $1", topic_id) == 1

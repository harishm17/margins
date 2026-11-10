"""What a topic is generated from: primary source spans, supporting chunks, the course map."""

import pytest

from app.config import settings
from app.services.content_generator.context import (
    fetch_topic_chunks,
    fetch_topic_context,
    resolve_sources,
)
from app.services.embeddings import search
from tests.db_helpers import add_chunk, new_id, seed_material, seed_project, seed_topic, seed_user, unit


@pytest.fixture(autouse=True)
def query_is_e0(monkeypatch):
    async def embed(text):
        return unit(1.0)

    monkeypatch.setattr(search, "generate_query_embedding", embed)


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    return {"user_id": user_id, "project_id": project_id}


async def add_source(db, topic_id, material_id, first, last, role="primary"):
    await db.execute(
        "INSERT INTO topic_sources (id, topic_id, material_id, chunk_index_start, chunk_index_end, role) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        new_id(), topic_id, material_id, first, last, role,
    )


async def lecture(db, project_id, filename, count, *, role="content", vector=None, uploaded=""):
    material = await seed_material(db, project_id, filename=filename, status="valid", role=role, uploaded_at=uploaded)
    ids = [
        await add_chunk(db, material, i, f"{filename} chunk {i}", vector, heading=f"{filename} > Part {i}", page=i + 1, tokens=300)
        for i in range(count)
    ]
    return material, ids


class TestPrimarySources:
    async def test_chunks_come_in_document_order_not_relevance_order(self, db, world):
        material, ids = await lecture(db, world["project_id"], "a.pdf", 6)
        topic = await seed_topic(db, world["project_id"], "T")
        # Sections named out of order, and the later one is far more "relevant" by any measure.
        await add_source(db, topic, material, 4, 5)
        await add_source(db, topic, material, 1, 2)

        context = await fetch_topic_context(topic)

        assert [c["id"] for c in context.chunks] == [ids[1], ids[2], ids[4], ids[5]]
        assert {c["source_kind"] for c in context.chunks} == {"primary"} and context.primary_count == 4

    async def test_whole_sections_are_kept_and_the_rest_dropped_from_the_end_and_logged(self, db, world, monkeypatch):
        monkeypatch.setattr(settings, "TOPIC_SOURCE_TOKEN_BUDGET", 1000)  # 300 tokens a chunk
        material, ids = await lecture(db, world["project_id"], "a.pdf", 10)
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, material, 0, 1)  # 600
        await add_source(db, topic, material, 2, 4)  # 900: does not fit after the first
        await add_source(db, topic, material, 5, 5)  # 300: would fit, but everything from the first miss on goes

        context = await fetch_topic_context(topic)

        # Whole sections, dropped from the end: the 900-token section does not fit, so it and the
        # small one after it are left out and the topic keeps one unbroken stretch from the start.
        assert [c["id"] for c in context.chunks] == [ids[0], ids[1]]
        assert context.dropped_sections == 2

    async def test_a_source_in_a_file_that_became_an_exam_is_ignored(self, db, world):
        material, _ = await lecture(db, world["project_id"], "a.pdf", 3)
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, material, 0, 2)
        await db.execute("UPDATE materials SET role = 'exam' WHERE id = $1", material)

        # Nothing left to teach from the sources, so it falls back to mappings (there are none).
        assert (await fetch_topic_context(topic)).chunks == []


class TestSupportingChunks:
    async def test_up_to_four_chunks_from_other_content_files_follow_the_primary_ones(self, db, world):
        main, main_ids = await lecture(db, world["project_id"], "main.pdf", 3, vector=unit(1.0, 0.2))
        other, other_ids = await lecture(db, world["project_id"], "other.pdf", 7, vector=unit(1.0, 0.1))
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")
        await add_source(db, topic, main, 0, 2)

        context = await fetch_topic_context(topic)

        primary = [c for c in context.chunks if c["source_kind"] == "primary"]
        supporting = [c for c in context.chunks if c["source_kind"] == "supporting"]
        assert [c["id"] for c in primary] == main_ids
        assert len(supporting) == 4 and {c["id"] for c in supporting} <= set(other_ids)
        assert context.chunks[: len(primary)] == primary  # supporting excerpts come last
        assert all(c["material_id"] == other for c in supporting)

    async def test_syllabus_exam_and_other_files_are_never_supporting(self, db, world):
        main, _ = await lecture(db, world["project_id"], "main.pdf", 2, vector=unit(1.0, 0.2))
        for role in ("syllabus", "exam", "other"):
            await lecture(db, world["project_id"], f"{role}.pdf", 2, role=role, vector=unit(1.0, 0.0))
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")
        await add_source(db, topic, main, 0, 1)

        context = await fetch_topic_context(topic)

        assert {c["filename"] for c in context.chunks} == {"main.pdf"}

class TestHandAddedTopics:
    async def test_a_topic_without_sources_uses_the_hybrid_mapping(self, db, world):
        material, ids = await lecture(db, world["project_id"], "a.pdf", 2, vector=unit(1.0))
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")

        chunks = await fetch_topic_chunks(topic)

        assert {c["id"] for c in chunks} == set(ids)
        assert {c["source_kind"] for c in chunks} == {"mapped"}

class TestSourceReferences:
    CHUNKS = [
        {"material_id": "m1", "filename": "a.pdf", "page_start": 3, "page_end": 3},
        {"material_id": "m1", "filename": "a.pdf", "page_start": 4, "page_end": 5},
        {"material_id": "m1", "filename": "a.pdf", "page_start": 9, "page_end": 9},
        {"material_id": "m2", "filename": "b.docx", "page_start": None, "page_end": None},
    ]

    def test_indexes_map_to_file_and_pages_and_touching_ranges_merge(self):
        assert resolve_sources([1, 2], self.CHUNKS) == [
            {"material_id": "m1", "filename": "a.pdf", "page_start": 3, "page_end": 5}
        ]
        assert resolve_sources([3, 1], self.CHUNKS) == [
            {"material_id": "m1", "filename": "a.pdf", "page_start": 3, "page_end": 3},
            {"material_id": "m1", "filename": "a.pdf", "page_start": 9, "page_end": 9},
        ]

"""What a topic is generated from: primary source spans, supporting chunks, the course map."""
import json
import logging

import pytest

from app.config import settings
from app.services.content_generator import context as ctx
from app.services.content_generator.context import (
    CONTENT_SYSTEM_PROMPT,
    attach_sources,
    content_messages,
    do_not_reuse_block,
    existing_content_digest,
    fetch_topic_chunks,
    fetch_topic_context,
    format_source_excerpts,
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

    async def test_files_are_read_in_upload_order(self, db, world):
        later, later_ids = await lecture(db, world["project_id"], "later.pdf", 2)
        earlier, earlier_ids = await lecture(
            db, world["project_id"], "earlier.pdf", 2, uploaded="SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 day'"
        )
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, later, 0, 1)
        await add_source(db, topic, earlier, 0, 1)

        context = await fetch_topic_context(topic)

        assert [c["filename"] for c in context.chunks] == ["earlier.pdf", "earlier.pdf", "later.pdf", "later.pdf"]

    async def test_whole_sections_are_kept_and_the_rest_dropped_from_the_end_and_logged(self, db, world, monkeypatch, caplog):
        monkeypatch.setattr(settings, "TOPIC_SOURCE_TOKEN_BUDGET", 1000)  # 300 tokens a chunk
        material, ids = await lecture(db, world["project_id"], "a.pdf", 10)
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, material, 0, 1)  # 600
        await add_source(db, topic, material, 2, 4)  # 900: does not fit after the first
        await add_source(db, topic, material, 5, 5)  # 300: would fit, but everything from the first miss on goes

        with caplog.at_level(logging.INFO, logger=ctx.logger.name):
            context = await fetch_topic_context(topic)

        # Whole sections, dropped from the end: the 900-token section does not fit, so it and the
        # small one after it are left out and the topic keeps one unbroken stretch from the start.
        assert [c["id"] for c in context.chunks] == [ids[0], ids[1]]
        assert context.dropped_sections == 2
        assert any("do not fit the 1000-token budget" in r.getMessage() for r in caplog.records)

    async def test_a_single_section_over_the_budget_keeps_its_start(self, db, world, monkeypatch):
        monkeypatch.setattr(settings, "TOPIC_SOURCE_TOKEN_BUDGET", 700)
        material, ids = await lecture(db, world["project_id"], "a.pdf", 6)
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, material, 0, 5)

        context = await fetch_topic_context(topic)

        assert [c["id"] for c in context.chunks] == ids[:2]

    async def test_the_default_budget_is_16000_tokens(self):
        from app.config import Settings

        assert Settings(DATABASE_URL="postgresql://x/y").TOPIC_SOURCE_TOKEN_BUDGET == 16000

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

    async def test_a_failed_supporting_search_does_not_fail_the_lesson(self, db, world, monkeypatch):
        main, main_ids = await lecture(db, world["project_id"], "main.pdf", 2, vector=unit(1.0))
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, main, 0, 1)

        async def broken(*args, **kwargs):
            raise RuntimeError("search down")

        monkeypatch.setattr(ctx, "hybrid_search_chunks", broken)

        assert [c["id"] for c in (await fetch_topic_context(topic)).chunks] == main_ids

    async def test_supporting_chunks_can_be_turned_off(self, db, world, monkeypatch):
        monkeypatch.setattr(settings, "TOPIC_SUPPORTING_CHUNKS", 0)
        main, _ = await lecture(db, world["project_id"], "main.pdf", 2, vector=unit(1.0))
        await lecture(db, world["project_id"], "other.pdf", 2, vector=unit(1.0))
        topic = await seed_topic(db, world["project_id"], "T")
        await add_source(db, topic, main, 0, 1)

        assert {c["source_kind"] for c in (await fetch_topic_context(topic)).chunks} == {"primary"}

    async def test_the_supporting_excerpts_are_labelled_in_the_prompt(self):
        chunks = [
            {"chunk_text": "primary text", "filename": "a.pdf", "category": "lecture_notes", "source_kind": "primary"},
            {"chunk_text": "supporting text", "filename": "b.pdf", "category": "lecture_notes", "source_kind": "supporting"},
        ]
        text = format_source_excerpts("T", "d", chunks)
        assert text.count("Supporting excerpts from other files") == 1
        assert '<excerpt index="2" source="b.pdf"' in text and 'use="supporting"' in text
        assert 'use="supporting"' not in text.split("supporting text")[0].split("primary text")[0]
        assert 'use=' not in text.split('index="2"')[0]


class TestHandAddedTopics:
    async def test_a_topic_without_sources_uses_the_hybrid_mapping(self, db, world):
        material, ids = await lecture(db, world["project_id"], "a.pdf", 2, vector=unit(1.0))
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")

        chunks = await fetch_topic_chunks(topic)

        assert {c["id"] for c in chunks} == set(ids)
        assert {c["source_kind"] for c in chunks} == {"mapped"}

    async def test_the_mapping_leaves_out_syllabus_and_exam_files(self, db, world):
        _, ids = await lecture(db, world["project_id"], "a.pdf", 2, vector=unit(1.0))
        await lecture(db, world["project_id"], "exam.pdf", 2, role="exam", vector=unit(1.0))
        await lecture(db, world["project_id"], "syllabus.pdf", 2, role="syllabus", vector=unit(1.0))
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")

        assert {c["filename"] for c in await fetch_topic_chunks(topic)} == {"a.pdf"}

    async def test_an_exam_file_uploaded_later_does_not_make_the_mappings_stale(self, db, world, monkeypatch):
        await lecture(db, world["project_id"], "a.pdf", 1, vector=unit(1.0))
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")
        await fetch_topic_chunks(topic)
        exam, _ = await lecture(db, world["project_id"], "exam.pdf", 1, role="exam", vector=unit(1.0))
        await db.execute("UPDATE material_chunks SET created_at = created_at + interval '1 minute' WHERE material_id = $1", exam)

        async def searched(*args, **kwargs):
            raise AssertionError("searched again")

        monkeypatch.setattr("app.services.embeddings.topic_mapping.hybrid_search_chunks", searched)
        assert await fetch_topic_chunks(topic)


    async def test_mapped_chunks_of_equal_relevance_come_in_course_order(self, db, world):
        later, (later_chunk,) = await lecture(db, world["project_id"], "later.pdf", 1, vector=unit(1.0))
        earlier, (earlier_chunk,) = await lecture(
            db, world["project_id"], "earlier.pdf", 1, vector=unit(1.0), uploaded="SQL:(NOW() AT TIME ZONE 'UTC') - interval '1 day'"
        )
        # Ids that sort against course order, so an order that ends on the random id shows.
        low, high = "00000000000040008000000000000001", "ffffffffffff4fffbfffffffffffffff"
        await db.execute("UPDATE material_chunks SET id = $1 WHERE id = $2", low, later_chunk)
        await db.execute("UPDATE material_chunks SET id = $1 WHERE id = $2", high, earlier_chunk)
        topic = await seed_topic(db, world["project_id"], "Krebs cycle")
        for chunk_id in (low, high):
            await db.execute(
                "INSERT INTO topic_chunk_mappings (id, topic_id, chunk_id, relevance_score, relevance_source, created_at) "
                "VALUES ($1, $2, $3, 0.02, 'both', (NOW() AT TIME ZONE 'UTC') + interval '1 minute')",
                new_id(), topic, chunk_id,
            )

        assert [c["filename"] for c in await fetch_topic_chunks(topic)] == ["earlier.pdf", "later.pdf"]

class TestCourseMap:
    async def test_units_topics_objectives_and_prerequisites_are_in_the_prompt(self, db, world):
        project = world["project_id"]
        material, _ = await lecture(db, project, "a.pdf", 2)
        u1, u2 = new_id(), new_id()
        await db.execute("INSERT INTO units (id, project_id, title, order_index, week_label) VALUES ($1, $2, 'Counting', 0, 'Week 1')", u1, project)
        await db.execute("INSERT INTO units (id, project_id, title, order_index) VALUES ($1, $2, 'Probability', 1)", u2, project)
        first = await seed_topic(db, project, "Permutations")
        second = await seed_topic(db, project, "Conditional probability")
        loose = await seed_topic(db, project, "Added by hand")
        await db.execute("UPDATE topics SET unit_id = $2, order_index = 0 WHERE id = $1", first, u1)
        await db.execute(
            "UPDATE topics SET unit_id = $2, order_index = 1, objectives = $3, prerequisite_ids = $4 WHERE id = $1",
            second, u2, ["compute P(A|B)", "use the multiplication rule"], [first],
        )
        await db.execute("UPDATE topics SET order_index = 2 WHERE id = $1", loose)
        await add_source(db, second, material, 0, 1)

        course_map = (await fetch_topic_context(second)).course_map

        assert "Unit: Counting (Week 1)" in course_map and "Unit: Probability" in course_map
        assert course_map.index("Permutations") < course_map.index("Conditional probability") < course_map.index("Added by hand")
        assert "- Conditional probability  <- THIS TOPIC" in course_map
        assert "- compute P(A|B)" in course_map and "- use the multiplication rule" in course_map
        assert "Prerequisites" in course_map and course_map.rstrip().endswith("Permutations")
        assert "Other topics" in course_map  # the topic with no unit

    async def test_a_flat_course_gets_a_plain_list(self, db, world):
        project = world["project_id"]
        material, _ = await lecture(db, project, "a.pdf", 2)
        a = await seed_topic(db, project, "First")
        b = await seed_topic(db, project, "Second")
        await db.execute("UPDATE topics SET order_index = 1 WHERE id = $1", b)
        await add_source(db, a, material, 0, 1)

        course_map = (await fetch_topic_context(a)).course_map

        assert "- First  <- THIS TOPIC" in course_map and "- Second" in course_map
        assert "Unit:" not in course_map and "objectives" not in course_map

    async def test_a_single_topic_with_nothing_to_say_has_no_map(self, db, world):
        material, _ = await lecture(db, world["project_id"], "a.pdf", 1)
        topic = await seed_topic(db, world["project_id"], "Alone")
        await add_source(db, topic, material, 0, 0)

        assert (await fetch_topic_context(topic)).course_map == ""

    async def test_the_map_sits_in_the_excerpt_block_so_a_regeneration_still_reads_the_cache(self):
        chunks = [{"chunk_text": "text", "filename": "a.pdf", "category": "x", "source_kind": "primary"}]
        first = content_messages("T", "d", chunks, "notes please", cache_excerpts=False, course_map="Course map: ...")
        regen = content_messages("T", "d", chunks, "more examples", cache_excerpts=True, course_map="Course map: ...")
        assert not any(m.cache for m in first)  # a first generation caches nothing
        assert regen[1].cache and "Course map: ..." in regen[1].content
        assert first[1].content == regen[1].content and first[0].content == regen[0].content == CONTENT_SYSTEM_PROMPT

    def test_the_system_prompt_carries_the_new_rules(self):
        assert "Teach only this topic's objectives" in CONTENT_SYSTEM_PROMPT
        assert "Assume the listed prerequisites are already known" in CONTENT_SYSTEM_PROMPT
        assert "never copy a worked example from them" in CONTENT_SYSTEM_PROMPT


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

    def test_a_file_without_pages_still_gets_a_source(self):
        assert resolve_sources([4], self.CHUNKS) == [
            {"material_id": "m2", "filename": "b.docx", "page_start": None, "page_end": None}
        ]

    def test_unknown_indexes_are_ignored(self):
        assert resolve_sources([0, 5, 99, -1], self.CHUNKS) == []

    def test_attach_sources_replaces_the_indexes(self):
        items = [{"title": "x", "source_excerpts": [1]}, {"title": "y"}]
        attach_sources(items, self.CHUNKS)
        assert items[0] == {"title": "x", "sources": [{"material_id": "m1", "filename": "a.pdf", "page_start": 3, "page_end": 3}]}
        assert items[1] == {"title": "y", "sources": []}


class TestAlreadySeenDigest:
    async def test_collects_the_notes_example_the_examples_and_earlier_quiz_stems(self, db, world):
        topic = await seed_topic(db, world["project_id"], "Bayes")
        notes = "# Bayes\n\n## The idea\nText.\n\n## Worked example\nA test is 99% accurate; 1 in 1000 have the disease.\n\n## Check yourself\n..."
        await db.execute("INSERT INTO topic_content (id, topic_id, content_type, content_data, updated_at) VALUES ($1, $2, 'section_notes', $3::jsonb, NOW())", new_id(), topic, json.dumps(notes))
        await db.execute(
            "INSERT INTO topic_content (id, topic_id, content_type, content_data, updated_at) VALUES ($1, $2, 'solved_examples', $3::jsonb, NOW())",
            new_id(), topic, json.dumps([{"title": "Coin", "problem_statement": "Two fair coins are tossed"}]),
        )
        await db.execute(
            "INSERT INTO topic_quizzes (id, topic_id, questions) VALUES ($1, $2, $3::jsonb)",
            new_id(), topic, json.dumps([{"question_text": "What is P(A and B) for independent events?"}]),
        )

        digest = await existing_content_digest(topic)

        assert "99% accurate" in digest and "Two fair coins" in digest and "independent events" in digest
        block = do_not_reuse_block(digest)
        assert "<already_seen>" in block and "Do not reuse" in block

    async def test_a_topic_with_nothing_yet_has_no_block(self, db, world):
        topic = await seed_topic(db, world["project_id"], "New")
        assert await existing_content_digest(topic) == ""
        assert do_not_reuse_block("") == ""

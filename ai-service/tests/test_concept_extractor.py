"""The extract_concepts job: prompt, validation, one-transaction write, reruns, legacy tagging."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services.concepts import store
from app.services.concepts.extractor import extract_concepts
from app.services.llm.base import LLMOutputError
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import ConceptExtraction
from tests.db_helpers import add_chunk, get_job, new_id, seed_job, seed_material, seed_project, seed_topic, seed_user, unit

CHUNK_TEXT = [
    "The sample mean is the sum of the values divided by how many there are. It is a measure of centre.",
    "Variance measures how far values spread from the mean. Take the average squared distance.",
]


async def fake_embed(texts):
    """Concept names 'Mock idea N' and the legacy strings below land on fixed axes."""
    vectors = []
    for text in texts:
        if "idea 1" in text or "first idea" in text:
            vectors.append(unit(1.0))
        elif "idea 2" in text or "second idea" in text:
            vectors.append(unit(0.0, 1.0))
        elif "idea 3" in text:
            vectors.append(unit(0.0, 0.0, 1.0))
        else:
            vectors.append(unit(0.0, 0.0, 0.0, 1.0))
    return vectors


@pytest.fixture(autouse=True)
def embedder(monkeypatch):
    monkeypatch.setattr(store, "generate_embeddings", fake_embed)


@pytest.fixture(autouse=True)
def mock_llm():
    with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
        yield


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    material = await seed_material(db, project_id, filename="stats.pdf", status="valid")
    chunk_ids = [
        await add_chunk(db, material, i, text, page=i + 1, tokens=40) for i, text in enumerate(CHUNK_TEXT)
    ]
    topic_id = await seed_topic(db, project_id, "Summary statistics")
    await db.execute(
        "UPDATE topics SET objectives = $2 WHERE id = $1", topic_id,
        ["Compute a mean", "Explain variance", "Compare spread measures"],
    )
    await db.execute(
        "INSERT INTO topic_sources (id, topic_id, material_id, chunk_index_start, chunk_index_end, role) "
        "VALUES ($1, $2, $3, 0, 1, 'primary')",
        new_id(), topic_id, material,
    )
    return SimpleNamespace(user_id=user_id, project_id=project_id, topic_id=topic_id, material=material, chunks=chunk_ids)


async def concept_rows(db, topic_id):
    return await db.fetch("SELECT * FROM concepts WHERE topic_id = $1 ORDER BY order_index", topic_id)


class TestExtractConcepts:
    async def test_extract_writes_concepts_claims_edges(self, db, world):
        summary = await extract_concepts(world.topic_id)

        concepts = await concept_rows(db, world.topic_id)
        assert [c["name"] for c in concepts] == ["Mock idea 1", "Mock idea 2", "Mock idea 3"]
        assert all(c["origin"] == "llm" and c["status"] == "active" for c in concepts)
        assert list(concepts[0]["objective_indexes"]) == [0] and list(concepts[1]["objective_indexes"]) == [1]
        embedded = await db.fetchval("SELECT count(*) FROM concepts WHERE topic_id = $1 AND embedding IS NOT NULL", world.topic_id)
        assert embedded == 3

        claims = await db.fetch(
            "SELECT cc.* FROM concept_claims cc JOIN concepts c ON c.id = cc.concept_id WHERE c.topic_id = $1 "
            "ORDER BY cc.concept_id, cc.order_index", world.topic_id,
        )
        assert len(claims) == 6
        assert {c["material_id"] for c in claims} == {world.material}
        assert {c["chunk_id"] for c in claims} == set(world.chunks)
        assert {c["page_start"] for c in claims} == {1, 2}
        assert all(len(c["quote"]) <= 300 for c in claims)

        edges = await db.fetch("SELECT * FROM concept_edges WHERE project_id = $1", world.project_id)
        by_id = {c["id"]: c["name"] for c in concepts}
        assert {(by_id[e["source_id"]], by_id[e["target_id"]], e["type"]) for e in edges} == {
            ("Mock idea 1", "Mock idea 2", "prerequisite"),
            ("Mock idea 2", "Mock idea 3", "prerequisite"),
        }
        assert all(e["origin"] == "llm" and e["status"] == "proposed" for e in edges)

        prompts = json.loads(await db.fetchval(
            "SELECT content_data FROM topic_content WHERE topic_id = $1 AND content_type = 'concept_prompts'", world.topic_id))
        assert [q["objective_index"] for q in prompts["focus_questions"]] == [0, 1, 2]
        assert len(prompts["recall_prompts"]) == 3

        assert (summary.concepts, summary.claims, summary.edges) == (3, 6, 2)
        assert summary.unmapped_objectives == [] and summary.kept_with_evidence == 0

    async def test_rerun_replaces_the_graph_and_keeps_concepts_with_evidence(self, db, world):
        await extract_concepts(world.topic_id)
        first = await concept_rows(db, world.topic_id)
        with_evidence = first[1]
        await db.execute(
            "INSERT INTO evidence_events (id, user_id, project_id, topic_id, concept_id, item_key, source, score, "
            "assistance, weight, role, graded_by, session_key) VALUES ($1, $2, $3, $4, $5, 'q1', 'quiz', 1, 0, 1, "
            "'primary', 'rule', 's1')",
            new_id(), world.user_id, world.project_id, world.topic_id, with_evidence["id"],
        )
        student_concept = await db.fetchval(
            "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index, origin) "
            "VALUES ($1, $2, $3, 'My own idea', 'Mine.', 'fact', 9, 'student') RETURNING id",
            new_id(), world.project_id, world.topic_id,
        )

        summary = await extract_concepts(world.topic_id)

        after = await concept_rows(db, world.topic_id)
        ids = {c["id"] for c in after}
        assert with_evidence["id"] in ids and student_concept in ids
        # Same names come back as the same concept, not as a duplicate.
        assert [c["name"] for c in after if c["origin"] == "llm"] == ["Mock idea 1", "Mock idea 2", "Mock idea 3"]
        assert first[0]["id"] not in ids and first[2]["id"] not in ids
        claims = await db.fetchval(
            "SELECT count(*) FROM concept_claims cc JOIN concepts c ON c.id = cc.concept_id WHERE c.topic_id = $1",
            world.topic_id,
        )
        assert claims == 6
        assert await db.fetchval("SELECT count(*) FROM concept_edges WHERE project_id = $1", world.project_id) == 2
        assert summary.kept_with_evidence == 1

    async def test_rerun_waits_for_an_answer_being_written_and_keeps_its_concept(self, db, world, monkeypatch):
        import asyncio

        await extract_concepts(world.topic_id)
        target = (await concept_rows(db, world.topic_id))[0]
        reached, gate = asyncio.Event(), asyncio.Event()

        async def gated_embed(texts):
            reached.set()
            await gate.wait()
            return await fake_embed(texts)

        async with db.acquire() as writer:
            tx = writer.transaction()
            await tx.start()
            # The evidence writer's insert, not yet committed: it holds a share lock on the concept's row.
            await writer.execute(
                "INSERT INTO evidence_events (id, user_id, project_id, topic_id, concept_id, item_key, source, score, "
                "assistance, weight, role, graded_by, session_key) VALUES ($1, $2, $3, $4, $5, 'q1', 'quiz', 1, 0, 1, "
                "'primary', 'rule', 's1')",
                new_id(), world.user_id, world.project_id, world.topic_id, target["id"],
            )
            monkeypatch.setattr(store, "generate_embeddings", gated_embed)
            rerun = asyncio.create_task(extract_concepts(world.topic_id))
            await asyncio.wait_for(reached.wait(), 10)
            gate.set()
            await asyncio.sleep(0.5)  # the rerun is now waiting on the row
            await tx.commit()
        summary = await rerun

        ids = {c["id"] for c in await concept_rows(db, world.topic_id)}
        assert target["id"] in ids
        assert await db.fetchval("SELECT count(*) FROM evidence_events WHERE concept_id = $1", target["id"]) == 1
        assert summary.kept_with_evidence == 1

    async def test_prompt_marks_excerpts_untrusted_and_lists_prior_concepts(self, db, world):
        earlier = await seed_topic(db, world.project_id, "Earlier")
        prior_id = await db.fetchval(
            "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
            "VALUES ($1, $2, $3, 'Count values', 'Counting how many values there are.', 'fact', 0) RETURNING id",
            new_id(), world.project_id, earlier,
        )
        await db.execute("UPDATE topics SET prerequisite_ids = $2, order_index = 1 WHERE id = $1", world.topic_id, [earlier])
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=ConceptExtraction.example_for(
            f'<excerpt chunk_id="{world.chunks[0]}" source="x">\n{CHUNK_TEXT[0]}\n</excerpt>'))

        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            await extract_concepts(world.topic_id)

        messages = llm.generate_structured.call_args.args[0]
        text = "\n".join(m.content for m in messages)
        assert "<source_excerpts>" in text and "</source_excerpts>" in text
        assert "untrusted data" in text
        assert f'<excerpt chunk_id="{world.chunks[0]}"' in text
        assert f'<concept id="{prior_id}">Count values' in text
        assert '<objective index="2">Compare spread measures</objective>' in text
        assert llm.generate_structured.call_args.kwargs["purpose"] == "extract_concepts"
        assert messages[0].role == "system" and "<source_excerpts>" not in messages[0].content


    async def test_fewer_than_three_concepts_is_a_retryable_output_error(self, db, world):
        raw = ConceptExtraction.example_for(f'<excerpt chunk_id="{world.chunks[0]}">\n{CHUNK_TEXT[0]}\n</excerpt>')
        raw = raw.model_copy(update={"concepts": raw.concepts[:2]})
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=raw)

        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            with pytest.raises(LLMOutputError):
                await extract_concepts(world.topic_id)

        assert await concept_rows(db, world.topic_id) == []


    async def test_confusable_edge_is_stored_smaller_id_first(self, db, world):
        base = ConceptExtraction.example_for(f'<excerpt chunk_id="{world.chunks[0]}">\n{CHUNK_TEXT[0]}\n</excerpt>')
        pairs = [("c1", "c2"), ("c1", "c3"), ("c2", "c3")]
        edges = [e.model_copy(update={"source": a, "target": b, "type": "confusable"}) for e, (a, b) in zip(base.edges * 2, pairs)]
        llm = MagicMock()
        llm.generate_structured = AsyncMock(return_value=base.model_copy(update={"edges": edges}))

        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            await extract_concepts(world.topic_id)

        stored = await db.fetch("SELECT source_id, target_id FROM concept_edges WHERE type = 'confusable'")
        assert len(stored) == 3 and all(row["source_id"] < row["target_id"] for row in stored)


class TestLegacyItems:
    async def test_legacy_items_get_concept_ids(self, db, world):
        quiz = [
            {"question_text": "q1", "concepts_tested": ["the first idea"]},
            {"question_text": "q2", "concepts_tested": ["the second idea", "the first idea"]},
            {"question_text": "q3", "concepts_tested": ["something unrelated"]},
            {"question_text": "q4", "concepts_tested": ["the first idea"], "concept_ids": ["gone"]},
        ]
        await db.execute(
            "INSERT INTO topic_quizzes (id, topic_id, questions, kind) VALUES ($1, $2, $3::jsonb, 'standard')",
            new_id(), world.topic_id, json.dumps(quiz),
        )
        for content_type, items in (
            ("solved_examples", [{"title": "e", "key_concepts": ["second idea"]}]),
            ("interactive_examples", [{"title": "p", "key_concepts": []}]),
        ):
            await db.execute(
                "INSERT INTO topic_content (id, topic_id, content_type, content_data, updated_at) "
                "VALUES ($1, $2, $3, $4::jsonb, NOW())",
                new_id(), world.topic_id, content_type, json.dumps(items),
            )

        summary = await extract_concepts(world.topic_id)

        concepts = {c["name"]: c["id"] for c in await concept_rows(db, world.topic_id)}
        stored = json.loads(await db.fetchval("SELECT questions FROM topic_quizzes WHERE topic_id = $1", world.topic_id))
        assert stored[0]["concept_ids"] == [concepts["Mock idea 1"]]
        assert sorted(stored[1]["concept_ids"]) == sorted([concepts["Mock idea 1"], concepts["Mock idea 2"]])
        assert "concept_ids" not in stored[2]
        assert stored[3]["concept_ids"] == [concepts["Mock idea 1"]]  # the id it had no longer exists
        examples = json.loads(await db.fetchval(
            "SELECT content_data FROM topic_content WHERE topic_id = $1 AND content_type = 'solved_examples'", world.topic_id))
        assert examples[0]["concept_ids"] == [concepts["Mock idea 2"]]
        practice = json.loads(await db.fetchval(
            "SELECT content_data FROM topic_content WHERE topic_id = $1 AND content_type = 'interactive_examples'", world.topic_id))
        assert "concept_ids" not in practice[0]
        assert summary.legacy_items_mapped == 4


class TestJob:
    async def test_no_source_material_is_not_retryable(self, db, world):
        empty = await seed_topic(db, world.project_id, "Empty")
        job_id = await seed_job(db, world.user_id, "extract_concepts", project_id=world.project_id)

        with pytest.raises(HTTPException) as raised:
            await jobs.extract_concepts_job(
                JobPayload(jobId=job_id, jobType="extract_concepts", data={"topicId": empty})
            )

        assert raised.value.status_code == 400
        job = await get_job(db, job_id)
        assert job["retryable"] is False and job["error_code"] == "NO_SOURCE_MATERIAL"


"""The link_concepts job: cross-topic candidates, validation, and what a rerun leaves alone."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services.concepts import linker
from app.services.concepts.linker import link_unit
from app.services.concepts.validate import validate_links
from app.services.concepts.vectors import vector_literal
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import ConceptLinks, ProposedLink
from tests.db_helpers import add_chunk, get_job, new_id, seed_job, seed_material, seed_project, seed_topic, seed_user, unit


class Scripted(MockProvider):
    """The mock provider, answering with the links a test sets and recording the prompt."""

    def __init__(self, edges=None):
        super().__init__()
        self.edges = edges
        self.prompt = ""
        self.calls = 0

    async def generate_structured(self, messages, schema, **kwargs):
        self.calls += 1
        self.prompt = "\n".join(m.content for m in messages)
        if self.edges is None:
            return await super().generate_structured(messages, schema, **kwargs)
        return ConceptLinks(edges=self.edges)


def use(provider):
    return patch("app.services.llm.factory.LLMFactory.get_provider", return_value=provider)


async def add_concept(db, project_id, topic_id, name, vector, index=0):
    return await db.fetchval(
        "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index, embedding) "
        "VALUES ($1, $2, $3, $4, $5, 'concept', $6, $7::vector) RETURNING id",
        new_id(), project_id, topic_id, name, f"{name} summary.", index, vector_literal(vector),
    )


def link(a, b, kind="confusable", confidence=0.8, weight=1.0, quote=None):
    return ProposedLink(source=a, target=b, type=kind, weight=weight, confidence=confidence, evidence_quote=quote)


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    unit_id = new_id()
    await db.execute("INSERT INTO units (id, project_id, title, order_index) VALUES ($1, $2, 'Unit 1', 0)", unit_id, project_id)
    topics = []
    for name in ("Probability", "Statistics"):
        topic_id = await seed_topic(db, project_id, name)
        await db.execute("UPDATE topics SET unit_id = $2 WHERE id = $1", topic_id, unit_id)
        topics.append(topic_id)
    return SimpleNamespace(user_id=user_id, project_id=project_id, unit_id=unit_id, a=topics[0], b=topics[1])


async def edges(db, project_id):
    return await db.fetch("SELECT * FROM concept_edges WHERE project_id = $1", project_id)


class TestCandidates:
    async def test_candidates_only_cross_topic_neighbours(self, db, world):
        # Two near-identical concepts in the same topic must not pair with each other.
        same_1 = await add_concept(db, world.project_id, world.a, "Mean", unit(1.0))
        same_2 = await add_concept(db, world.project_id, world.a, "Average", unit(1.0, 0.01), 1)
        other = await add_concept(db, world.project_id, world.b, "Median", unit(1.0, 0.5))
        outside_topic = await seed_topic(db, world.project_id, "Elsewhere")  # not in the unit
        await add_concept(db, world.project_id, outside_topic, "Mode", unit(1.0, 0.02))

        pairs = await linker._candidate_pairs([world.a, world.b])

        assert pairs == {tuple(sorted((same_1, other))), tuple(sorted((same_2, other)))}

    async def test_unit_without_two_topics_of_concepts_makes_no_call(self, db, world):
        await add_concept(db, world.project_id, world.a, "Mean", unit(1.0))
        provider = Scripted()
        with use(provider):
            assert await link_unit(world.unit_id) == 0
        assert provider.calls == 0

    async def test_unknown_unit(self, db, world):
        with pytest.raises(LookupError):
            await link_unit(new_id())


class TestLinkUnit:
    async def seed_two(self, db, world):
        first = await add_concept(db, world.project_id, world.a, "Sample mean", unit(1.0))
        second = await add_concept(db, world.project_id, world.b, "Population mean", unit(1.0, 0.2))
        return first, second

    async def test_mock_links_are_written_as_proposals(self, db, world):
        first, second = await self.seed_two(db, world)
        third = await add_concept(db, world.project_id, world.b, "Variance", unit(1.0, 0.6), 1)
        provider = Scripted()

        with use(provider):
            written = await link_unit(world.unit_id)

        rows = await edges(db, world.project_id)
        assert written == len(rows) == 2
        assert {r["type"] for r in rows} == {"confusable", "encompasses"}
        assert all(r["origin"] == "llm" and r["status"] == "proposed" for r in rows)
        confusable = next(r for r in rows if r["type"] == "confusable")
        assert confusable["source_id"] < confusable["target_id"]
        assert '<candidate_pairs>' in provider.prompt and first in provider.prompt and third in provider.prompt

    async def test_low_confidence_edges_dropped(self, db, world):
        first, second = await self.seed_two(db, world)
        with use(Scripted(edges=[link(first, second, confidence=0.59)])):
            assert await link_unit(world.unit_id) == 0
        assert await edges(db, world.project_id) == []

        with use(Scripted(edges=[link(first, second, confidence=0.6)])):
            assert await link_unit(world.unit_id) == 1

    async def test_unknown_ids_and_non_candidate_pairs_dropped(self, db, world):
        first, second = await self.seed_two(db, world)
        sibling = await add_concept(db, world.project_id, world.a, "Sibling", unit(0.0, 1.0), 1)
        proposed = [
            link(first, "not-a-concept"),
            link(first, sibling),  # same topic: not offered
            link(first, first),
            link(second, first, kind="encompasses", weight=0.5),
        ]
        with use(Scripted(edges=proposed)):
            assert await link_unit(world.unit_id) == 1
        rows = await edges(db, world.project_id)
        assert (rows[0]["source_id"], rows[0]["target_id"], rows[0]["type"]) == (second, first, "encompasses")

    async def test_prerequisite_edges_are_not_accepted(self, db, world):
        first, second = await self.seed_two(db, world)
        bad = ProposedLink.model_construct(
            source=first, target=second, type="prerequisite", weight=1.0, confidence=0.9, evidence_quote=None
        )
        with use(Scripted(edges=[bad])):
            assert await link_unit(world.unit_id) == 0

    async def test_existing_student_edges_untouched(self, db, world):
        first, second = await self.seed_two(db, world)
        low, high = sorted((first, second))
        await db.execute(
            "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
            "VALUES ($1, $2, $3, $4, 'confusable', 1, 1, 'student', 'confirmed')",
            new_id(), world.project_id, low, high,
        )
        await db.execute(
            "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
            "VALUES ($1, $2, $3, $4, 'encompasses', 1, 1, 'student', 'rejected')",
            new_id(), world.project_id, first, second,
        )
        with use(Scripted(edges=[link(first, second), link(first, second, kind="encompasses", weight=0.5)])):
            assert await link_unit(world.unit_id) == 0

        rows = await edges(db, world.project_id)
        assert len(rows) == 2 and all(r["origin"] == "student" for r in rows)
        assert {r["status"] for r in rows} == {"confirmed", "rejected"}

    async def test_rerun_is_idempotent(self, db, world):
        first, second = await self.seed_two(db, world)
        with use(Scripted(edges=[link(first, second)])):
            assert await link_unit(world.unit_id) == 1
            assert await link_unit(world.unit_id) == 1  # replaced, not added
        assert len(await edges(db, world.project_id)) == 1

    async def test_edge_that_would_close_an_encompasses_cycle_is_dropped(self, db, world):
        first, second = await self.seed_two(db, world)
        await db.execute(
            "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
            "VALUES ($1, $2, $3, $4, 'encompasses', 0.5, 1, 'student', 'confirmed')",
            new_id(), world.project_id, first, second,
        )
        with use(Scripted(edges=[link(second, first, kind="encompasses", weight=0.5, confidence=0.99)])):
            assert await link_unit(world.unit_id) == 0


class TestValidateLinks:
    def test_cycle_among_proposals_drops_the_weakest(self):
        pairs = {("a", "b"), ("b", "c"), ("a", "c")}
        proposed = [
            link("a", "b", "encompasses", 0.9, 0.5), link("b", "c", "encompasses", 0.8, 0.5),
            link("c", "a", "encompasses", 0.65, 0.5),
        ]
        kept, dropped = validate_links(proposed, pairs, [], {})
        assert {(e.source, e.target) for e in kept} == {("a", "b"), ("b", "c")}
        assert dropped["edges"] == 1

    def test_confusable_is_ordered_by_id_and_deduplicated(self):
        kept, dropped = validate_links([link("b", "a", confidence=0.7), link("a", "b", confidence=0.9)], {("a", "b")}, [], {})
        assert [(e.source, e.target, e.confidence) for e in kept] == [("a", "b", 0.9)]
        assert dropped["edges"] == 1

    def test_evidence_quote_is_normalised_and_checked_against_shown_quotes(self):
        shown = {"a": ["Both the \u201cmean\u201d  and the median"]}
        kept, _ = validate_links([link("a", "b", quote="  the \u201cmean\u201d and ")], {("a", "b")}, [], shown)
        assert kept[0].evidence_quote == 'the "mean" and'

    def test_invented_evidence_quote_drops_the_edge(self):
        shown = {"a": ["The mean is the average."], "b": ["The median is the middle value."]}
        kept, dropped = validate_links(
            [link("a", "b", quote="Mean and median are always equal."), link("a", "b", "encompasses", quote="the middle value"),
             link("a", "b", "encompasses", 0.9, 0.5)],
            {("a", "b")}, [], shown,
        )
        assert [(e.type, e.evidence_quote) for e in kept] == [("encompasses", None)]
        assert dropped["edges"] == 2


class TestJob:
    async def test_job_completes_with_the_count(self, db, world):
        first = await add_concept(db, world.project_id, world.a, "Sample mean", unit(1.0))
        second = await add_concept(db, world.project_id, world.b, "Population mean", unit(1.0, 0.2))
        job_id = await seed_job(db, world.user_id, "link_concepts", project_id=world.project_id)

        with use(Scripted(edges=[link(first, second)])):
            await jobs.link_concepts_job(
                JobPayload(jobId=job_id, jobType="link_concepts", data={"unitId": world.unit_id})
            )

        job = await get_job(db, job_id)
        assert job["status"] == "completed"
        assert json.loads(job["result_data"])["edges"] == 1

    async def test_unknown_unit_fails_the_job(self, db, world):
        job_id = await seed_job(db, world.user_id, "link_concepts", project_id=world.project_id)
        with pytest.raises(HTTPException) as raised:
            await jobs.link_concepts_job(
                JobPayload(jobId=job_id, jobType="link_concepts", data={"unitId": new_id()})
            )
        assert "Unit not found" in raised.value.detail
        assert (await get_job(db, job_id))["status"] == "failed"


class TestRerunAndOrientation:
    async def seed_two(self, db, world):
        first = await add_concept(db, world.project_id, world.a, "Sample mean", unit(1.0))
        second = await add_concept(db, world.project_id, world.b, "Population mean", unit(1.0, 0.2))
        return first, second

    async def test_rerun_replaces_stale_confusable_proposals_only(self, db, world):
        first, second = await self.seed_two(db, world)
        third = await add_concept(db, world.project_id, world.b, "Variance", unit(1.0, 0.6), 1)
        sibling = await add_concept(db, world.project_id, world.a, "Sibling", unit(1.0, 0.9), 1)
        insert = (
            "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
            "VALUES ($1, $2, $3, $4, $5, 1, 0.9, $6, $7)"
        )
        a, b = sorted((first, third))
        s, t = sorted((first, sibling))
        await db.execute(insert, new_id(), world.project_id, a, b, "confusable", "llm", "proposed")  # stale: goes
        await db.execute(insert, new_id(), world.project_id, s, t, "confusable", "llm", "proposed")  # same topic: stays
        await db.execute(insert, new_id(), world.project_id, first, third, "encompasses", "llm", "proposed")  # stays
        c, d = sorted((second, sibling))
        await db.execute(insert, new_id(), world.project_id, c, d, "confusable", "llm", "confirmed")  # decided: stays

        with use(Scripted(edges=[link(first, second)])):
            assert await link_unit(world.unit_id) == 1

        kept = {(r["source_id"], r["target_id"], r["type"], r["status"]) for r in await edges(db, world.project_id)}
        low, high = sorted((first, second))
        assert (a, b, "confusable", "proposed") not in kept
        assert kept == {
            (low, high, "confusable", "proposed"),
            (s, t, "confusable", "proposed"),
            (first, third, "encompasses", "proposed"),
            (c, d, "confusable", "confirmed"),
        }

    async def test_confusable_is_not_written_in_both_orientations(self, db, world):
        first, second = await self.seed_two(db, world)
        low, high = sorted((first, second))
        # A student edge stored the other way round.
        await db.execute(
            "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
            "VALUES ($1, $2, $3, $4, 'confusable', 1, 1, 'student', 'confirmed')",
            new_id(), world.project_id, high, low,
        )
        with use(Scripted(edges=[link(first, second)])):
            assert await link_unit(world.unit_id) == 0
        rows = await edges(db, world.project_id)
        assert [(r["source_id"], r["target_id"]) for r in rows] == [(high, low)]

    async def test_evidence_quote_must_come_from_the_shown_claims(self, db, world):
        first, second = await self.seed_two(db, world)
        material = await seed_material(db, world.project_id, status="valid")
        chunk = await add_chunk(db, material, 0, "The sample mean estimates the population mean.")
        await db.execute(
            "INSERT INTO concept_claims (id, concept_id, text, quote, material_id, chunk_id, order_index) "
            "VALUES ($1, $2, 'c', $3, $4, $5, 0)",
            new_id(), first, "The sample mean estimates the population mean.", material, chunk,
        )
        good = link(first, second, quote="sample mean estimates")
        invented = link(first, second, kind="encompasses", weight=0.5, quote="something the course never says")
        with use(Scripted(edges=[good, invented])):
            assert await link_unit(world.unit_id) == 1
        assert [r["type"] for r in await edges(db, world.project_id)] == ["confusable"]

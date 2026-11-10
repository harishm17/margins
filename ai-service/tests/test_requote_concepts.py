"""The requote_concepts job (F0): a concept that lost every claim gets new ones from the topic's remaining files, with its id."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.api.routes import jobs
from app.config import settings
from app.models.jobs import JobPayload
from app.services.concepts.requote import propose_quotes, requote_concepts
from app.services.llm.mock_provider import MockProvider
from tests.db_helpers import add_chunk, get_job, new_id, seed_job, seed_material, seed_project, seed_topic, seed_user

CHUNK_TEXT = [
    "The sample mean is the sum of the values divided by how many there are. It is a measure of centre.",
    "Variance measures how far values spread from the mean. Take the average squared distance.",
]


class Counting(MockProvider):
    def __init__(self):
        super().__init__()
        self.calls = 0

    async def generate_structured(self, messages, schema, **kwargs):
        self.calls += 1
        return await super().generate_structured(messages, schema, **kwargs)


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    gone = await seed_material(db, project_id, filename="deleted.pdf", status="valid")
    kept = await seed_material(db, project_id, filename="stats.pdf", status="valid")
    chunks = [await add_chunk(db, kept, i, text, page=i + 1, tokens=40) for i, text in enumerate(CHUNK_TEXT)]
    old_chunk = await add_chunk(db, gone, 0, "Some text of the file that was deleted.", page=1, tokens=10)
    topic_id = await seed_topic(db, project_id, "Summary statistics")
    await db.execute(
        "INSERT INTO topic_sources (id, topic_id, material_id, chunk_index_start, chunk_index_end, role) "
        "VALUES ($1, $2, $3, 0, 1, 'primary')",
        new_id(), topic_id, kept,
    )
    ids = {}
    for position, name in enumerate(["Mean", "Variance", "Kept concept"]):
        ids[name] = new_id()
        await db.execute(
            "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index, status, origin) "
            "VALUES ($1, $2, $3, $4, 'summary', 'concept', $5, 'active', 'llm')",
            ids[name], project_id, topic_id, name, position,
        )
    # "Kept concept" still has a claim; the other two lost theirs with the deleted file.
    await db.execute(
        "INSERT INTO concept_claims (id, concept_id, text, quote, material_id, chunk_id, order_index) "
        "VALUES ($1, $2, 'claim', 'quote', $3, $4, 0)",
        new_id(), ids["Kept concept"], kept, chunks[0],
    )
    return SimpleNamespace(user_id=user_id, project_id=project_id, topic_id=topic_id, ids=ids, chunks=chunks, old_chunk=old_chunk)


async def claims_of(db, concept_id):
    return await db.fetch("SELECT * FROM concept_claims WHERE concept_id = $1", concept_id)


async def test_flag_off_completes_without_a_model_call(db, world, monkeypatch):
    monkeypatch.setattr(settings, "CLAIM_REQUOTE", False)
    provider = Counting()
    with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=provider):
        summary = await requote_concepts(world.topic_id)
    assert provider.calls == 0 and summary.skipped
    assert await claims_of(db, world.ids["Mean"]) == []


async def test_claimless_concepts_get_claims_from_the_remaining_files_and_keep_their_ids(db, world, monkeypatch):
    monkeypatch.setattr(settings, "CLAIM_REQUOTE", True)
    provider = Counting()
    with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=provider):
        summary = await requote_concepts(world.topic_id)

    assert provider.calls == 1 and summary.concepts_requoted == 2
    for name in ("Mean", "Variance"):
        claims = await claims_of(db, world.ids[name])
        assert claims and all(c["chunk_id"] in world.chunks for c in claims)
        # The quote is real text of the chunk it names.
        text = CHUNK_TEXT[world.chunks.index(claims[0]["chunk_id"])]
        assert claims[0]["quote"] in text
    ids = {row["id"] for row in await db.fetch("SELECT id FROM concepts WHERE topic_id = $1", world.topic_id)}
    assert ids == set(world.ids.values())  # no concept was re-created
    assert len(await claims_of(db, world.ids["Kept concept"])) == 1  # a concept with claims is left alone

    # Run again: nothing lacks claims, so there is no second model call.
    with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=provider):
        again = await requote_concepts(world.topic_id)
    assert provider.calls == 1 and again.concepts_requoted == 0


async def test_a_quote_that_is_not_in_the_excerpt_is_dropped(db, world, monkeypatch):
    monkeypatch.setattr(settings, "CLAIM_REQUOTE", True)

    class Invents(MockProvider):
        async def generate_structured(self, messages, schema, **kwargs):
            real = await super().generate_structured(messages, schema, **kwargs)
            return real.model_copy(update={"claims": [c.model_copy(update={"quote": "words nobody wrote"}) for c in real.claims]})

    with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=Invents()):
        plan = await propose_quotes(world.topic_id)
    assert plan.claims == [] and plan.dropped_claims == 2


async def test_the_job_checks_the_topic_belongs_to_the_course_and_runs_off_by_default(db, world):
    job_id = await seed_job(db, world.user_id, "requote_concepts", project_id=world.project_id)
    data = {"topicId": world.topic_id, "projectId": world.project_id}
    # Off, the job makes no model call, so an AI outage or a used-up allowance must not fail it (review of PR 1.6).
    refuse = patch("app.services.job_runner._enforce_ai_ready", side_effect=RuntimeError("AI is down"))
    with refuse, patch.object(jobs, "topic_lock", side_effect=AssertionError("no lock when off")):
        await jobs.requote_concepts_job(JobPayload(jobId=job_id, jobType="requote_concepts", data=data))
    job = await get_job(db, job_id)
    assert job["status"] == "completed" and "CLAIM_REQUOTE is off" in job["result_data"]

    other = await seed_project(db, world.user_id)
    wrong = await seed_job(db, world.user_id, "requote_concepts", project_id=other)
    with pytest.raises(Exception):
        await jobs.requote_concepts_job(
            JobPayload(jobId=wrong, jobType="requote_concepts", data={"topicId": world.topic_id, "projectId": other})
        )
    assert (await get_job(db, wrong))["error_code"] == "NOT_FOUND"


async def test_a_concept_orphaned_while_the_job_runs_gets_a_new_job_and_an_unquotable_one_does_not_loop(db, world, monkeypatch):
    """Review of PR 1.6: a second file delete during the job found the job active and started none, so the concepts it
    orphaned were never re-quoted."""
    monkeypatch.setattr(settings, "CLAIM_REQUOTE", True)
    data = {"topicId": world.topic_id, "projectId": world.project_id}
    real = jobs.requote_concepts
    sent = []

    async def and_another_file_goes(topic_id):
        summary = await real(topic_id)
        await db.execute("DELETE FROM concept_claims WHERE concept_id = $1", world.ids["Kept concept"])
        return summary

    async def record(planned):
        sent.append(planned)
        return planned.job_id

    first = await seed_job(db, world.user_id, "requote_concepts", project_id=world.project_id)
    with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()), \
            patch.object(jobs, "requote_concepts", and_another_file_goes), patch.object(jobs, "dispatch_job", record):
        await jobs.requote_concepts_job(JobPayload(jobId=first, jobType="requote_concepts", data=data))
    assert (await get_job(db, first))["status"] == "completed"
    assert [p.data for p in sent] == [data]
    follow_up = await get_job(db, sent[0].job_id)
    assert follow_up["job_type"] == "requote_concepts" and follow_up["status"] == "pending"

    # The follow-up cannot quote it either (nothing found): the concept was claimless when it started, so no third job.
    await db.execute("UPDATE processing_jobs SET status = 'completed' WHERE id = $1", sent[0].job_id)
    second = await seed_job(db, world.user_id, "requote_concepts", project_id=world.project_id)
    sent.clear()

    async def finds_nothing(topic_id):
        return jobs.RequoteSummary(topic_id=topic_id)

    with patch.object(jobs, "requote_concepts", finds_nothing), patch.object(jobs, "dispatch_job", record):
        await jobs.requote_concepts_job(JobPayload(jobId=second, jobType="requote_concepts", data=data))
    assert sent == []

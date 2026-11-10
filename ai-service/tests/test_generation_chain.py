"""The generation chain with concepts and the warm-up in front, and the link job after a unit."""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services import generation_chain
from app.services.content_generator.context import NoSourceMaterialError
from app.services.job_runner import PermanentJobError
from app.services.llm.base import LLMRefusalError
from tests.db_helpers import new_id, seed_topic

# The fakes and the three-topic course are shared with the stage 1A chain tests.
from tests.test_cost_reliability import (  # noqa: F401
    FakeGenerators,
    course,
    dispatched,
    finish_chain,
    generators,
    run_job,
)

ORDER = ["concepts", "warmup", "section_notes", "solved_examples", "interactive_examples", "topic_quiz"]


async def put_in_unit(db, course, topic_ids):
    unit_id = new_id()
    await db.execute(
        "INSERT INTO units (id, project_id, title, order_index) VALUES ($1, $2, 'Unit 1', 0)",
        unit_id, course.project_id,
    )
    for topic_id in topic_ids:
        await db.execute("UPDATE topics SET unit_id = $2 WHERE id = $1", topic_id, unit_id)
    return unit_id


def link_jobs(dispatched):
    return [job for job in dispatched if job["job_type"] == "link_concepts"]


async def test_a_topic_with_a_concept_or_a_warmup_bank_is_not_missing_them(db, course):
    topic = course.topics[0]
    await db.execute(
        "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
        "VALUES ($1, $2, $3, 'Mean', 'The average.', 'concept', 0)", new_id(), course.project_id, topic)
    await db.execute(
        "INSERT INTO topic_quizzes (id, topic_id, questions, kind, created_at) "
        "VALUES ($1, $2, '[]'::jsonb, 'warmup', NOW())", new_id(), topic)
    assert await generation_chain.missing_content_types(topic) == ORDER[2:]
    # A merged or removed concept does not count.
    await db.execute("UPDATE concepts SET status = 'removed' WHERE topic_id = $1", topic)
    assert (await generation_chain.missing_content_types(topic))[0] == "concepts"


async def test_unit_complete_queues_link_concepts(db, course, generators, dispatched):
    unit_id = await put_in_unit(db, course, course.topics[:2])
    first, second, outside = course.topics

    await run_job(db, course, first, "concepts")
    assert link_jobs(dispatched) == []  # the second topic of the unit has not been reached

    await run_job(db, course, outside, "concepts")
    assert link_jobs(dispatched) == []  # not in the unit

    await run_job(db, course, second, "concepts")
    assert [job["data"] for job in link_jobs(dispatched)] == [{"unitId": unit_id}]
    row = await db.fetchrow("SELECT status, project_id, target_key FROM processing_jobs WHERE id = $1",
                            link_jobs(dispatched)[0]["job_id"])
    assert (row["status"], row["project_id"], row["target_key"]) == ("pending", course.project_id, f"link:{unit_id}")

    # Extracting a topic of the linked unit again links it again, once the first link has finished.
    await db.execute("UPDATE processing_jobs SET status = 'completed' WHERE target_key = $1", f"link:{unit_id}")
    dispatched.clear()
    await run_job(db, course, first, "concepts")
    assert len(link_jobs(dispatched)) == 1


async def test_a_failed_topic_does_not_hold_the_unit_back(db, course, generators, dispatched):
    unit_id = await put_in_unit(db, course, course.topics[:2])
    first, second, _ = course.topics
    generators.fail_with = PermanentJobError("no", "NOPE")  # a failure that is not retried
    with pytest.raises(HTTPException):
        await run_job(db, course, first, "concepts")
    generators.fail_with = None
    assert link_jobs(dispatched) == []  # the other topic has not been reached
    await run_job(db, course, second, "concepts")
    assert [job["data"] for job in link_jobs(dispatched)] == [{"unitId": unit_id}]


async def test_a_topic_failing_last_links_the_unit(db, course, generators, dispatched):
    unit_id = await put_in_unit(db, course, course.topics[:2])
    first, second, _ = course.topics
    await run_job(db, course, first, "concepts")
    generators.fail_with = PermanentJobError("no", "NOPE")
    with pytest.raises(HTTPException):
        await run_job(db, course, second, "concepts")
    assert [job["data"] for job in link_jobs(dispatched)] == [{"unitId": unit_id}]


async def test_overlapping_extractions_queue_one_link(db, course, generators, dispatched):
    unit_id = await put_in_unit(db, course, course.topics[:2])
    generators.delay = 0.05  # both extractions are running when either one finishes
    await asyncio.gather(
        run_job(db, course, course.topics[0], "concepts"),
        run_job(db, course, course.topics[1], "concepts"),
    )
    assert [job["data"] for job in link_jobs(dispatched)] == [{"unitId": unit_id}]


async def test_an_extraction_during_a_link_queues_the_link_again(db, course, generators, dispatched, monkeypatch):
    unit_id = await put_in_unit(db, course, course.topics[:2])
    first, second, _ = course.topics
    await run_job(db, course, first, "concepts")
    await run_job(db, course, second, "concepts")
    link = link_jobs(dispatched)[0]
    dispatched.clear()

    async def link_unit(_unit_id):
        # While the link runs, the first topic is extracted again; its own link is a duplicate.
        await run_job(db, course, first, "concepts")
        assert link_jobs(dispatched) == []
        return 0

    monkeypatch.setattr(jobs, "link_unit", link_unit)
    await jobs.link_concepts_job(JobPayload(jobId=link["job_id"], jobType="link_concepts", data=link["data"]))

    again = link_jobs(dispatched)
    assert [job["data"] for job in again] == [{"unitId": unit_id}] and again[0]["job_id"] != link["job_id"]

    # Nothing came in during the second link: it does not queue a third.
    dispatched.clear()

    async def quiet_link(_unit_id):
        return 0

    monkeypatch.setattr(jobs, "link_unit", quiet_link)
    await jobs.link_concepts_job(JobPayload(jobId=again[0]["job_id"], jobType="link_concepts", data=again[0]["data"]))
    assert dispatched == []


async def test_a_unit_of_one_topic_is_not_linked(db, course, generators, dispatched):
    await put_in_unit(db, course, course.topics[:1])
    await run_job(db, course, course.topics[0], "concepts")
    assert link_jobs(dispatched) == []


async def test_a_failed_warmup_does_not_block_the_notes(db, course, generators, dispatched):
    topic = course.topics[0]
    generators.fail_with = RuntimeError("model down")
    with pytest.raises(HTTPException):
        await run_job(db, course, topic, "warmup", prepare_rest=True)
    assert [job["data"]["contentType"] for job in dispatched] == ["concepts"]


async def test_prepare_all_extracts_concepts_in_course_order(db, course, generators, dispatched):
    ran = await finish_chain(db, course, dispatched, course.topics[0], "concepts", prepare_all=True)
    concepts_order = [course.topics.index(topic) for topic, content_type in ran if content_type == "concepts"]
    assert concepts_order == [0, 1, 2]
    # One topic at a time: a topic is finished before the next one starts.
    assert [course.topics.index(topic) for topic, _ in ran] == sorted(course.topics.index(t) for t, _ in ran)


async def test_prepare_concepts_walks_the_course_for_concepts_only(db, course, generators, dispatched):
    ran = await finish_chain(db, course, dispatched, course.topics[0], "concepts", prepare_concepts=True)
    assert ran == [(topic, "concepts") for topic in course.topics]
    assert generators.max_active == 1
    # The flag is inherited by every job of the run.
    row = await db.fetchrow(
        "SELECT input_data FROM processing_jobs WHERE input_data->>'topicId' = $1 "
        "AND input_data->>'contentType' = 'concepts' ORDER BY created_at DESC LIMIT 1", course.topics[2])
    assert "prepare_concepts" in row["input_data"]


async def test_prepare_concepts_starts_for_course_without_concepts(db, course, generators, dispatched):
    """Topics that already have concepts (or an extraction in flight) are passed over."""
    await db.execute(
        "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
        "VALUES ($1, $2, $3, 'Mean', 'The average.', 'concept', 0)", new_id(), course.project_id, course.topics[1])
    ran = await finish_chain(db, course, dispatched, course.topics[0], "concepts", prepare_concepts=True)
    assert ran == [(course.topics[0], "concepts"), (course.topics[2], "concepts")]


async def test_a_topic_added_by_hand_is_not_a_unit_member(db, course):
    topic = await seed_topic(db, course.project_id, "Loose")
    planned = await generation_chain.plan_link_job(
        user_id=course.user_id, project_id=course.project_id, topic_id=topic)
    assert planned is None


@pytest.mark.parametrize(
    "error", [RuntimeError("model down"), LLMRefusalError("declined"), NoSourceMaterialError("No source material")]
)
async def test_a_refused_or_sourceless_extraction_does_not_block_the_topic(db, course, generators, dispatched, error):
    topic = course.topics[0]
    generators.fail_with = error
    with pytest.raises(HTTPException):
        await run_job(db, course, topic, "concepts", prepare_rest=True)
    generators.fail_with = None
    # The chain goes on within the topic, without asking for concepts again.
    assert [job["data"]["contentType"] for job in dispatched] == ["warmup"]
    assert dispatched[0]["data"]["preferences"]["chain_skip"] == [f"{topic}:concepts"]
    ran = []
    while dispatched:
        job = dispatched.pop(0)
        ran.append(job["data"]["contentType"])
        await jobs.generate_content_job(JobPayload(jobId=job["job_id"], jobType=job["job_type"], data=job["data"]))
    assert ran == ORDER[1:]


async def test_a_sourceless_extraction_still_links_the_unit(db, course, generators, dispatched):
    unit_id = await put_in_unit(db, course, course.topics[:2])
    await run_job(db, course, course.topics[0], "concepts")
    generators.fail_with = NoSourceMaterialError("No source material")
    with pytest.raises(HTTPException):
        await run_job(db, course, course.topics[1], "concepts")
    assert [job["data"] for job in link_jobs(dispatched)] == [{"unitId": unit_id}]

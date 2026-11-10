"""Stage 1A: prompt caching, rate limits, concurrency limits and the generation chain."""
import asyncio
import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.config import settings
from app.models.jobs import JobPayload
from app.services import generation_chain
from app.services.dispatch import retry_delay_seconds
from app.services.content_generator.context import NoSourceMaterialError, content_messages
from app.services.llm.anthropic_provider import AnthropicProvider, _translate_api_error
from app.services.llm.base import LLMMessage, LLMRateLimitError
from app.services.llm.factory import LLMFactory
from app.services.llm.limiter import llm_slot
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import SolvedExampleSet
from tests.db_helpers import get_job, new_id, seed_job, seed_project, seed_topic, seed_usage, seed_user

CHUNKS = [
    {"chunk_text": "Bayes' rule updates a prior.", "section_hierarchy": "Ch 1", "page_start": 1,
     "page_end": 1, "filename": "notes.pdf", "category": "lecture_notes"},
]


# ---- prompt caching ---------------------------------------------------------------------------


def _request_for(messages):
    """The request the Anthropic provider would send for these messages."""
    provider = AnthropicProvider(api_key="test-key")
    sent = {}

    async def create(**params):
        sent.update(params)
        return SimpleNamespace(
            model="claude-opus-5-5", stop_reason="end_turn", stop_details=None,
            content=[SimpleNamespace(type="text", text='{"examples": []}')],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1, cache_read_input_tokens=0,
                                  cache_creation_input_tokens=0),
        )

    provider.client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    asyncio.run(provider.generate_text(messages, purpose="section_notes"))
    return sent


class TestPromptCaching:

    def test_a_regeneration_caches_the_excerpt_block_only(self):
        params = _request_for(content_messages("Bayes", "desc", CHUNKS, "more", cache_excerpts=True))
        marked = [
            block for message in params["messages"] for block in message["content"]
            if "cache_control" in block
        ]
        assert len(marked) == 1 and marked[0]["text"].startswith("Topic: Bayes")
        assert "cache_control" not in json.dumps(params["system"])
        # The task instructions come after the breakpoint, so they can change between calls.
        last = params["messages"][-1]["content"][-1]
        assert last["text"] == "more" and "cache_control" not in last


class FakeGenerators:
    """Stand in for the model-backed generators and record how they were called."""

    calls: list = []
    delay = 0.0
    active = 0
    max_active = 0
    fail_with = None

    @classmethod
    def reset(cls):
        cls.calls, cls.delay, cls.active, cls.max_active, cls.fail_with = [], 0.0, 0, 0, None

    async def _run(self, label, kwargs):
        cls = FakeGenerators
        cls.calls.append((label, kwargs["topic_id"], kwargs.get("cache_excerpts")))
        cls.active += 1
        cls.max_active = max(cls.max_active, cls.active)
        try:
            await asyncio.sleep(cls.delay)
            if cls.fail_with is not None:
                raise cls.fail_with
        finally:
            cls.active -= 1

    async def generate_notes(self, **kwargs):
        await self._run("section_notes", kwargs)
        return {"content": "# Notes\n" + "word " * 100, "citations": [], "chunk_count": 1}

    async def generate_examples(self, **kwargs):
        await self._run(kwargs["example_type"].value, kwargs)
        return {"examples": [{"title": "E"}], "example_type": kwargs["example_type"].value,
                "difficulty_level": "medium"}

    async def generate_quiz(self, **kwargs):
        await self._run("topic_quiz", kwargs)
        return {"questions": [{"question_text": "Q"}], "total_questions": 1,
                "difficulty_level": "medium", "question_types": ["multiple_choice"]}


@pytest.fixture
def generators(monkeypatch, db):
    FakeGenerators.reset()
    for name in ("NotesGenerator", "ExamplesGenerator", "QuizGenerator"):
        monkeypatch.setattr(jobs, name, FakeGenerators)

    async def extract_concepts(topic_id):
        await FakeGenerators()._run("concepts", {"topic_id": topic_id})
        return SimpleNamespace(as_result=lambda: {"topic_id": topic_id, "concepts": 0})

    async def generate_warmup(topic_id):
        await FakeGenerators()._run("warmup", {"topic_id": topic_id})
        warmup_id = new_id()
        await db.execute(
            "INSERT INTO topic_quizzes (id, topic_id, questions, kind, created_at) "
            "VALUES ($1, $2, '[]'::jsonb, 'warmup', NOW())", warmup_id, topic_id)
        return {"warmup_id": warmup_id, "total_questions": 0, "dropped_unsupported": 0}

    monkeypatch.setattr(jobs, "extract_concepts", extract_concepts)
    monkeypatch.setattr(jobs, "generate_warmup", generate_warmup)
    return FakeGenerators


@pytest.fixture
def dispatched(monkeypatch):
    """Jobs the chain dispatches, instead of posting them to the service."""
    sent = []

    async def enqueue_job(job_id, job_type, data):
        sent.append({"job_id": job_id, "job_type": job_type, "data": data})
        return f"task-{job_id}"

    monkeypatch.setattr(generation_chain, "enqueue_job", enqueue_job)
    return sent


@pytest.fixture
async def course(db):
    """A user with a project and three confirmed topics, in course order."""
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    topic_ids = []
    for index in range(3):
        topic_id = await seed_topic(db, project_id, f"Topic {index}")
        await db.execute("UPDATE topics SET order_index = $2, user_confirmed = TRUE WHERE id = $1", topic_id, index)
        topic_ids.append(topic_id)
    return SimpleNamespace(user_id=user_id, project_id=project_id, topics=topic_ids)


async def run_job(db, course, topic_id, content_type, **preferences):
    data = {"topicId": topic_id, "contentType": content_type, "preferences": preferences}
    job_id = await seed_job(db, course.user_id, project_id=course.project_id, input_data=data)
    payload = JobPayload(jobId=job_id, jobType="generate_content", data=data)
    return job_id, await jobs.generate_content_job(payload)


class TestRegenerationCaching:
    async def test_the_first_generation_of_a_type_does_not_cache_and_a_regeneration_does(
        self, db, course, generators
    ):
        topic = course.topics[0]
        await run_job(db, course, topic, "solved_examples")
        await run_job(db, course, topic, "solved_examples", append=True)
        await run_job(db, course, topic, "interactive_examples")
        assert generators.calls == [
            ("solved", topic, False),
            ("solved", topic, True),
            ("interactive", topic, False),  # a different type has nothing to read yet
        ]


# ---- rate limits ------------------------------------------------------------------------------


def _error(cls, status, **headers):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("error", response=httpx2.Response(status, request=request, headers=headers), body=None)


class TestRetryAfter:
    def test_a_rate_limit_carries_the_retry_after_seconds(self):
        error = _translate_api_error(_error(anthropic.RateLimitError, 429, **{"retry-after": "7"}))
        assert isinstance(error, LLMRateLimitError) and error.retryable
        assert error.retry_after == 7


    def test_the_dispatcher_waits_for_retry_after_when_it_is_longer_than_its_backoff(self):
        assert retry_delay_seconds(1, None) == 0.5
        assert retry_delay_seconds(2, None) == 1.0
        assert retry_delay_seconds(1, "20") == 20.0
        assert retry_delay_seconds(3, "0.1") == 2.0
        assert retry_delay_seconds(1, "junk") == 0.5
        assert retry_delay_seconds(1, "9999") == 120.0


class RateLimitedMock(MockProvider):
    """The mock provider, rate limited for the first `failures` calls."""

    def __init__(self, failures, retry_after=None):
        self.failures, self.retry_after = failures, retry_after

    async def _simulate_call(self):
        if self.failures > 0:
            self.failures -= 1
            error = LLMRateLimitError("Anthropic rate limit: 429")
            error.retry_after = self.retry_after
            raise error


class TestRateLimitedJobs:
    @pytest.fixture
    def llm(self, monkeypatch):
        provider = RateLimitedMock(failures=1, retry_after=7)
        monkeypatch.setattr(LLMFactory, "_instance", provider)

        class Generator:
            async def generate_examples(self, **kwargs):
                result = await provider.generate_structured(
                    [LLMMessage(role="user", content="x")], SolvedExampleSet, purpose="solved_examples"
                )
                return {"examples": [e.model_dump() for e in result.examples], "example_type": "solved",
                        "difficulty_level": "medium"}

        monkeypatch.setattr(jobs, "ExamplesGenerator", Generator)
        return provider

    @pytest.mark.parametrize("retry_after", [7, None], ids=["with_retry_after", "without_retry_after"])
    async def test_a_rate_limit_answers_503_with_retry_after_and_the_job_waits_for_its_retry(self, db, course, llm, retry_after):
        llm.retry_after = retry_after
        job_id = await seed_job(db, course.user_id, project_id=course.project_id)
        payload = JobPayload(jobId=job_id, jobType="generate_content",
                             data={"topicId": course.topics[0], "contentType": "solved_examples", "preferences": {}})

        with pytest.raises(HTTPException) as raised:
            await jobs.generate_content_job(payload)

        assert raised.value.status_code == 503  # 5xx: the dispatcher retries
        if retry_after:
            assert raised.value.headers == {"Retry-After": "7"}
        else:  # the dispatcher is still asked to wait
            assert int(raised.value.headers["Retry-After"]) >= 1
        job = await get_job(db, job_id)
        # Back in pending with attempts left, so it still counts as the target's active job.
        assert (job["status"], job["error_code"], job["retryable"]) == ("pending", "LLM_RATE_LIMITED", True)
        assert job["attempt_count"] == 1 and job["max_attempts"] == 3

        # The retry the dispatcher makes goes through once the limit has passed.
        result = await jobs.generate_content_job(payload)
        assert result["status"] == "success"
        job = await get_job(db, job_id)
        assert (job["status"], job["attempt_count"]) == ("completed", 2)


# ---- concurrency ------------------------------------------------------------------------------


class WatchedMock(MockProvider):
    """Counts how many model calls are in flight."""

    def __init__(self):
        self.active = self.peak = 0

    async def _simulate_call(self):
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(0.02)
        finally:
            self.active -= 1


class TestConcurrencyLimit:
    @pytest.mark.parametrize("limit", [1, 3, 4])
    async def test_at_most_llm_max_concurrency_calls_run_at_once(self, monkeypatch, limit):
        monkeypatch.setattr(settings, "LLM_MAX_CONCURRENCY", limit)
        provider = WatchedMock()
        message = [LLMMessage(role="user", content="x")]
        await asyncio.gather(*[
            provider.generate_structured(message, SolvedExampleSet, purpose="solved_examples")
            for _ in range(12)
        ])
        assert provider.peak == limit


    async def test_a_slot_is_released_when_the_call_fails(self, monkeypatch):
        monkeypatch.setattr(settings, "LLM_MAX_CONCURRENCY", 1)
        with pytest.raises(RuntimeError):
            async with llm_slot():
                raise RuntimeError("boom")
        async with asyncio.timeout(1):
            async with llm_slot():
                pass


class TestTopicSerialisation:
    async def test_two_jobs_for_the_same_topic_do_not_overlap(self, db, course, generators):
        generators.delay = 0.05
        topic = course.topics[0]
        await asyncio.gather(
            run_job(db, course, topic, "solved_examples"),
            run_job(db, course, topic, "interactive_examples"),
            run_job(db, course, topic, "topic_quiz"),
        )
        assert len(generators.calls) == 3
        assert generators.max_active == 1


    async def test_a_failed_job_releases_the_topic(self, db, course, generators):
        topic = course.topics[0]
        generators.fail_with = RuntimeError("boom")
        with pytest.raises(HTTPException):
            await run_job(db, course, topic, "solved_examples")
        generators.fail_with = None
        await run_job(db, course, topic, "topic_quiz")
        assert generators.max_active == 1


# ---- the generation chain ---------------------------------------------------------------------


async def stored_types(db, topic_id):
    rows = await db.fetch("SELECT content_type FROM topic_content WHERE topic_id = $1", topic_id)
    return {row["content_type"] for row in rows}


async def finish_chain(db, course, dispatched, topic_id, content_type, **preferences):
    """Run one job, then run each job the chain dispatches in turn. The order jobs ran in."""
    ran = [(topic_id, content_type)]
    await run_job(db, course, topic_id, content_type, **preferences)
    while dispatched:
        job = dispatched.pop(0)
        data = job["data"]
        ran.append((data["topicId"], data["contentType"]))
        # The dispatched job row already exists: run it as the service would.
        await jobs.generate_content_job(
            JobPayload(jobId=job["job_id"], jobType=job["job_type"], data=data)
        )
    return ran


class TestGenerationChain:

    async def test_the_whole_chain_runs_in_order_and_stops(self, db, course, generators, dispatched):
        topic = course.topics[0]
        ran = await finish_chain(db, course, dispatched, topic, "concepts", prepare_rest=True)

        assert [content_type for _, content_type in ran] == [
            "concepts", "warmup", "section_notes", "solved_examples", "interactive_examples", "topic_quiz",
        ]
        assert {t for t, _ in ran} == {topic}  # prepare_rest stays on this topic
        assert await stored_types(db, topic) == {
            "section_notes", "solved_examples", "interactive_examples", "topic_quiz",
        }
        assert generators.max_active == 1


    async def test_types_with_a_job_in_flight_are_not_queued_twice(self, db, course, generators, dispatched):
        topic = course.topics[0]
        await seed_job(db, course.user_id, project_id=course.project_id, status="processing",
                       input_data={"topicId": topic, "contentType": "warmup"},
                       target_key=f"content:{topic}:warmup")
        await run_job(db, course, topic, "concepts", prepare_rest=True)
        assert [job["data"]["contentType"] for job in dispatched] == ["section_notes"]


    async def test_the_chain_stops_when_the_daily_allowance_is_used_up(
        self, db, course, generators, dispatched, monkeypatch
    ):
        monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.0)
        topic = course.topics[0]
        queue = dict(user_id=course.user_id, project_id=course.project_id, topic_id=topic,
                     preferences={"prepare_rest": True})
        assert await generation_chain.continue_chain(**queue) is not None  # under budget: queued
        assert len(dispatched) == 1
        await seed_usage(db, course.user_id, 2.0)
        dispatched.clear()
        assert await generation_chain.continue_chain(**queue) is None
        assert dispatched == []

    async def test_prepare_all_goes_through_the_course_one_topic_at_a_time(
        self, db, course, generators, dispatched
    ):
        first = course.topics[0]
        ran = await finish_chain(db, course, dispatched, first, "concepts", prepare_all=True)

        order = [(course.topics.index(t), c) for t, c in ran]
        expected = [(i, c) for i in range(3) for c in
                    ("concepts", "warmup", "section_notes", "solved_examples", "interactive_examples", "topic_quiz")]
        assert order == expected
        assert generators.max_active == 1  # one topic in flight, one job at a time


    async def test_prepare_all_skips_a_topic_that_cannot_be_generated(self, db, course, generators, dispatched):
        generators.fail_with = NoSourceMaterialError("No source material")
        with pytest.raises(HTTPException) as raised:
            await run_job(db, course, course.topics[0], "section_notes", prepare_all=True)
        assert raised.value.status_code == 400
        # The run moves on to the second topic, starting with its concepts.
        assert [(job["data"]["topicId"], job["data"]["contentType"]) for job in dispatched] == [
            (course.topics[1], "concepts")
        ]

    async def test_a_failed_dispatch_marks_the_new_job_undelivered(self, db, course, generators, monkeypatch):
        async def broken(job_id, job_type, data):
            raise RuntimeError("queue down")

        monkeypatch.setattr(generation_chain, "enqueue_job", broken)
        await run_job(db, course, course.topics[0], "concepts", prepare_rest=True)
        row = await db.fetchrow("SELECT status, error_code, retryable FROM processing_jobs WHERE target_key = $1",
                                f"content:{course.topics[0]}:warmup")
        assert (row["status"], row["error_code"], row["retryable"]) == ("failed", "ENQUEUE_FAILED", True)



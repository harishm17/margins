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
from app.services.llm import limiter
from app.services.llm.anthropic_provider import AnthropicProvider, _translate_api_error
from app.services.llm.base import LLMMessage, LLMRateLimitError, LLMUnavailableError
from app.services.llm.factory import LLMFactory
from app.services.llm.limiter import KeyedLocks, llm_slot
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
    def test_a_first_generation_sends_no_cache_control(self):
        params = _request_for(content_messages("Bayes", "desc", CHUNKS, "write notes"))
        assert "cache_control" not in json.dumps(params)

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
def generators(monkeypatch):
    FakeGenerators.reset()
    for name in ("NotesGenerator", "ExamplesGenerator", "QuizGenerator"):
        monkeypatch.setattr(jobs, name, FakeGenerators)
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
    job_id = await seed_job(db, course.user_id, project_id=course.project_id)
    payload = JobPayload(
        jobId=job_id, jobType="generate_content",
        data={"topicId": topic_id, "contentType": content_type, "preferences": preferences},
    )
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

    async def test_another_quiz_set_caches(self, db, course, generators):
        topic = course.topics[0]
        await run_job(db, course, topic, "topic_quiz")
        await run_job(db, course, topic, "topic_quiz")
        assert [call[2] for call in generators.calls] == [False, True]


# ---- rate limits ------------------------------------------------------------------------------


def _error(cls, status, **headers):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("error", response=httpx2.Response(status, request=request, headers=headers), body=None)


class TestRetryAfter:
    def test_a_rate_limit_carries_the_retry_after_seconds(self):
        error = _translate_api_error(_error(anthropic.RateLimitError, 429, **{"retry-after": "7"}))
        assert isinstance(error, LLMRateLimitError) and error.retryable
        assert error.retry_after == 7

    def test_overload_carries_retry_after_ms(self):
        error = _translate_api_error(_error(anthropic.OverloadedError, 529, **{"retry-after-ms": "2500"}))
        assert isinstance(error, LLMUnavailableError) and error.retry_after == 2.5

    def test_a_server_error_is_transient_too(self):
        error = _translate_api_error(_error(anthropic.InternalServerError, 502))
        assert isinstance(error, LLMUnavailableError) and error.retryable and error.retry_after is None

    def test_the_wait_is_capped_and_junk_is_ignored(self):
        assert _translate_api_error(_error(anthropic.RateLimitError, 429, **{"retry-after": "9999"})).retry_after == 120
        assert _translate_api_error(_error(anthropic.RateLimitError, 429, **{"retry-after": "soon"})).retry_after is None

    def test_the_sdk_retries_four_times_by_default(self, monkeypatch):
        assert settings.LLM_MAX_RETRIES == 4
        monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
        LLMFactory.reset()
        try:
            assert LLMFactory.get_provider().client.max_retries == 4
        finally:
            LLMFactory.reset()

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

    async def test_a_rate_limit_answers_503_with_retry_after_and_the_job_waits_for_its_retry(self, db, course, llm):
        job_id = await seed_job(db, course.user_id, project_id=course.project_id)
        payload = JobPayload(jobId=job_id, jobType="generate_content",
                             data={"topicId": course.topics[0], "contentType": "solved_examples", "preferences": {}})

        with pytest.raises(HTTPException) as raised:
            await jobs.generate_content_job(payload)

        assert raised.value.status_code == 503  # 5xx: the dispatcher retries
        assert raised.value.headers == {"Retry-After": "7"}
        job = await get_job(db, job_id)
        # Back in pending with attempts left, so it still counts as the target's active job.
        assert (job["status"], job["error_code"], job["retryable"]) == ("pending", "LLM_RATE_LIMITED", True)
        assert job["attempt_count"] == 1 and job["max_attempts"] == 3

        # The retry the dispatcher makes goes through once the limit has passed.
        result = await jobs.generate_content_job(payload)
        assert result["status"] == "success"
        job = await get_job(db, job_id)
        assert (job["status"], job["attempt_count"]) == ("completed", 2)

    async def test_without_a_retry_after_the_dispatcher_is_still_asked_to_wait(self, db, course, llm):
        llm.retry_after = None
        job_id = await seed_job(db, course.user_id, project_id=course.project_id)
        payload = JobPayload(jobId=job_id, jobType="generate_content",
                             data={"topicId": course.topics[0], "contentType": "solved_examples", "preferences": {}})
        with pytest.raises(HTTPException) as raised:
            await jobs.generate_content_job(payload)
        assert raised.value.status_code == 503 and int(raised.value.headers["Retry-After"]) >= 1


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

    async def test_text_calls_and_streams_share_the_same_limit(self, monkeypatch):
        monkeypatch.setattr(settings, "LLM_MAX_CONCURRENCY", 2)
        provider = WatchedMock()
        message = [LLMMessage(role="user", content="x")]

        async def stream():
            async for _ in provider.stream_turn(system="s", messages=[{"role": "user", "content": "hi"}],
                                                tools=[], purpose="voice"):
                pass

        await asyncio.gather(
            *[provider.generate_text(message, purpose="section_notes") for _ in range(5)],
            *[stream() for _ in range(5)],
        )
        assert provider.peak == 2

    async def test_the_default_is_four(self):
        assert type(settings).model_fields["LLM_MAX_CONCURRENCY"].default == 4

    async def test_a_slot_is_released_when_the_call_fails(self, monkeypatch):
        monkeypatch.setattr(settings, "LLM_MAX_CONCURRENCY", 1)
        with pytest.raises(RuntimeError):
            async with llm_slot():
                raise RuntimeError("boom")
        async with asyncio.timeout(1):
            async with llm_slot():
                pass

    async def test_one_jobs_waiting_calls_do_not_exceed_the_limit_across_jobs(self, db, course, monkeypatch):
        """Calls from different jobs (different topics) draw on the same pool of slots."""
        monkeypatch.setattr(settings, "LLM_MAX_CONCURRENCY", 2)
        provider = WatchedMock()
        monkeypatch.setattr(LLMFactory, "_instance", provider)

        class Generator:
            async def generate_examples(self, **kwargs):
                result = await provider.generate_structured(
                    [LLMMessage(role="user", content="x")], SolvedExampleSet, purpose="solved_examples"
                )
                return {"examples": [e.model_dump() for e in result.examples], "example_type": "solved",
                        "difficulty_level": "medium"}

        monkeypatch.setattr(jobs, "ExamplesGenerator", Generator)
        await asyncio.gather(*[
            run_job(db, course, topic_id, "solved_examples") for topic_id in course.topics * 2
        ])
        assert provider.peak == 2


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

    async def test_jobs_for_different_topics_run_side_by_side(self, db, course, generators):
        generators.delay = 0.05
        await asyncio.gather(*[run_job(db, course, topic, "solved_examples") for topic in course.topics])
        assert generators.max_active == 3

    async def test_the_second_job_starts_after_the_first_has_stored_its_content(self, db, course, generators):
        """Same type twice: the second one sees the first's content, so it is a regeneration."""
        generators.delay = 0.05
        topic = course.topics[0]
        await asyncio.gather(
            run_job(db, course, topic, "solved_examples"),
            run_job(db, course, topic, "solved_examples"),
        )
        assert sorted(call[2] for call in generators.calls) == [False, True]

    async def test_a_waiting_job_keeps_its_claim(self, db, course, generators):
        generators.delay = 0.1
        topic = course.topics[0]
        first = asyncio.create_task(run_job(db, course, topic, "solved_examples"))
        await asyncio.sleep(0.02)
        second = asyncio.create_task(run_job(db, course, topic, "topic_quiz"))
        await asyncio.sleep(0.02)
        rows = await db.fetch("SELECT status FROM processing_jobs ORDER BY created_at")
        assert [row["status"] for row in rows] == ["processing", "processing"]
        await asyncio.gather(first, second)

    async def test_a_failed_job_releases_the_topic(self, db, course, generators):
        topic = course.topics[0]
        generators.fail_with = RuntimeError("boom")
        with pytest.raises(HTTPException):
            await run_job(db, course, topic, "solved_examples")
        generators.fail_with = None
        await run_job(db, course, topic, "topic_quiz")
        assert generators.max_active == 1

    async def test_locks_are_dropped_when_idle(self):
        locks = KeyedLocks()
        async with locks.hold("a"):
            async with locks.hold("b"):
                assert len(locks) == 2
        assert len(locks) == 0

    async def test_keyed_locks_queue_in_order(self):
        locks = KeyedLocks()
        order = []

        async def work(name, delay):
            async with locks.hold("t"):
                order.append(f"{name}-in")
                await asyncio.sleep(delay)
                order.append(f"{name}-out")

        await asyncio.gather(work("a", 0.03), work("b", 0), work("c", 0))
        assert order == ["a-in", "a-out", "b-in", "b-out", "c-in", "c-out"]


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
    async def test_notes_then_the_other_missing_types_one_at_a_time(self, db, course, generators, dispatched):
        topic = course.topics[0]
        await run_job(db, course, topic, "section_notes", prepare_rest=True)

        # Only the next type is queued, not all three: examples after notes ...
        assert [(job["data"]["contentType"], job["data"]["preferences"]) for job in dispatched] == [
            ("solved_examples", {"prepare_rest": True})
        ]
        job = await get_job(db, dispatched[0]["job_id"])
        assert job["status"] == "pending" and job["target_key"] == f"content:{topic}:solved_examples"
        assert job["user_id"] == course.user_id and job["project_id"] == course.project_id

    async def test_the_whole_chain_runs_in_order_and_stops(self, db, course, generators, dispatched):
        topic = course.topics[0]
        ran = await finish_chain(db, course, dispatched, topic, "section_notes", prepare_rest=True)

        assert [content_type for _, content_type in ran] == [
            "section_notes", "solved_examples", "interactive_examples", "topic_quiz",
        ]
        assert {t for t, _ in ran} == {topic}  # prepare_rest stays on this topic
        assert await stored_types(db, topic) == {
            "section_notes", "solved_examples", "interactive_examples", "topic_quiz",
        }
        assert generators.max_active == 1

    async def test_types_the_topic_already_has_are_skipped(self, db, course, generators, dispatched):
        topic = course.topics[0]
        await run_job(db, course, topic, "interactive_examples")
        ran = await finish_chain(db, course, dispatched, topic, "section_notes", prepare_rest=True)
        assert [c for _, c in ran] == ["section_notes", "solved_examples", "topic_quiz"]

    async def test_types_with_a_job_in_flight_are_not_queued_twice(self, db, course, generators, dispatched):
        topic = course.topics[0]
        await seed_job(db, course.user_id, project_id=course.project_id, status="processing",
                       input_data={"topicId": topic, "contentType": "solved_examples"},
                       target_key=f"content:{topic}:solved_examples")
        await run_job(db, course, topic, "section_notes", prepare_rest=True)
        assert [job["data"]["contentType"] for job in dispatched] == ["interactive_examples"]

    async def test_a_plain_job_queues_nothing(self, db, course, generators, dispatched):
        await run_job(db, course, course.topics[0], "section_notes")
        await run_job(db, course, course.topics[0], "solved_examples", append=True)
        assert dispatched == []

    async def test_a_failed_job_ends_the_chain(self, db, course, generators, dispatched):
        generators.fail_with = RuntimeError("boom")
        with pytest.raises(HTTPException):
            await run_job(db, course, course.topics[0], "section_notes", prepare_rest=True)
        assert dispatched == []

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
        ran = await finish_chain(db, course, dispatched, first, "section_notes", prepare_all=True)

        order = [(course.topics.index(t), c) for t, c in ran]
        expected = [(i, c) for i in range(3) for c in
                    ("section_notes", "solved_examples", "interactive_examples", "topic_quiz")]
        assert order == expected
        assert generators.max_active == 1  # one topic in flight, one job at a time

    async def test_prepare_all_skips_topics_that_are_complete_or_unconfirmed(
        self, db, course, generators, dispatched
    ):
        middle = course.topics[1]
        for content_type in generation_chain.CONTENT_ORDER:
            await run_job(db, course, middle, content_type)
        await db.execute("UPDATE topics SET user_confirmed = FALSE WHERE id = $1", course.topics[2])
        ran = await finish_chain(db, course, dispatched, course.topics[0], "section_notes", prepare_all=True)
        assert {t for t, _ in ran} == {course.topics[0]}

    async def test_prepare_all_skips_a_topic_that_cannot_be_generated(self, db, course, generators, dispatched):
        generators.fail_with = NoSourceMaterialError("No source material")
        with pytest.raises(HTTPException) as raised:
            await run_job(db, course, course.topics[0], "section_notes", prepare_all=True)
        assert raised.value.status_code == 400
        # The run moves on to the second topic, starting with its notes.
        assert [(job["data"]["topicId"], job["data"]["contentType"]) for job in dispatched] == [
            (course.topics[1], "section_notes")
        ]

    async def test_a_failed_dispatch_marks_the_new_job_undelivered(self, db, course, generators, monkeypatch):
        async def broken(job_id, job_type, data):
            raise RuntimeError("queue down")

        monkeypatch.setattr(generation_chain, "enqueue_job", broken)
        await run_job(db, course, course.topics[0], "section_notes", prepare_rest=True)
        row = await db.fetchrow("SELECT status, error_code, retryable FROM processing_jobs WHERE target_key = $1",
                                f"content:{course.topics[0]}:solved_examples")
        assert (row["status"], row["error_code"], row["retryable"]) == ("failed", "ENQUEUE_FAILED", True)

    async def test_missing_content_types(self, db, course):
        topic = course.topics[0]
        assert await generation_chain.missing_content_types(topic) == list(generation_chain.CONTENT_ORDER)
        await db.execute(
            "INSERT INTO topic_content (id, topic_id, content_type, content_data, updated_at) "
            "VALUES ($1, $2, 'solved_examples', '[]'::jsonb, NOW())", new_id(), topic)
        assert "solved_examples" not in await generation_chain.missing_content_types(topic)

    async def test_the_next_job_has_a_row_before_it_is_dispatched(self, db, course, dispatched):
        """The page that sees a job finish must be able to find the next job at once."""
        planned = await generation_chain.plan_next_job(
            user_id=course.user_id, project_id=course.project_id, topic_id=course.topics[0],
            preferences={"prepare_rest": True},
        )
        row = await get_job(db, planned.job_id)
        assert row["status"] == "pending" and dispatched == []
        assert await generation_chain.dispatch(planned) == planned.job_id
        assert [job["job_id"] for job in dispatched] == [planned.job_id]


class TestHandlerHeaders:
    async def test_the_non_job_error_handler_also_asks_for_a_wait(self):
        import json

        from app.main import llm_error_handler

        error = LLMRateLimitError("slow down")
        error.retry_after = 12.2
        response = await llm_error_handler(None, error)
        assert response.status_code == 503 and response.headers["retry-after"] == "13"
        assert json.loads(response.body)["error_code"] == "LLM_RATE_LIMITED"

        other = await llm_error_handler(None, LLMUnavailableError("down"))
        assert other.status_code == 503 and other.headers["retry-after"] == "10"

"""Which topics the past exams test: one model call per project that maps each question to topics,
the stored question maps, no stored exam text, and the triggers."""
import json
from types import SimpleNamespace
from typing import List
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.config import settings
from app.models.jobs import JobPayload
from app.services import exam_relevance
from app.services.exam_relevance import (
    build_maps,
    classify_questions,
    mark_exam_relevant_topics,
)
from app.services.llm.base import LLMUnavailableError
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import ExamQuestionTopics, ExamTopicMap
from tests.db_helpers import add_chunk, get_job, new_id, seed_job, seed_material, seed_project, seed_usage, seed_user

EXAM = [
    "# Exam 1\nNo books or calculators. You may use one sheet of notes.",
    "**Problem 1.** (10 pts) Two dice are rolled. Compute the probability that the total is seven.\n\n"
    "**Problem 2.** (15 pts) A screening test detects a disease. Given a positive result, what is the chance the person is ill?",
    "<br>0.0668 <br>-1.45 <br>0.0735 <br>-1.40 <br>0.0808 <br>-1.35 <br>0.0885 <br>-1.30",
    "**Problem 3.** (10 pts) Find the variance of the number of heads in ten fair coin flips.",
]


def q(label, summary, *keys, exam=1) -> ExamQuestionTopics:
    return ExamQuestionTopics(exam=exam, label=label, summary=summary, topic_keys=list(keys))


class Scripted:
    """A provider that answers each call with the next item and keeps the prompts it saw."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts: List[str] = []

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        assert schema is ExamTopicMap and purpose == "exam_style"
        self.prompts.append(messages[-1].content)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def scripted(*answers):
    provider = Scripted(*answers)
    return provider, patch("app.services.exam_relevance.LLMFactory.get_provider", return_value=provider)


@pytest.fixture
async def course(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    return SimpleNamespace(db=db, user_id=user_id, project_id=project_id)


async def add_topic(course, name, objectives=("explain it", "use it"), index=0):
    topic_id = new_id()
    await course.db.execute(
        "INSERT INTO topics (id, project_id, name, description, objectives, order_index) VALUES ($1, $2, $3, $4, $5, $6)",
        topic_id, course.project_id, name, f"About {name.lower()}.", list(objectives), index,
    )
    return topic_id


async def add_file(course, role="exam", chunks=EXAM, filename=None, status="valid"):
    material = await seed_material(course.db, course.project_id, filename=filename or f"{role}-{new_id()[:6]}.pdf", status=status, role=role)
    for index, text in enumerate(chunks):
        await add_chunk(course.db, material, index, text)
    return material


async def flags(course):
    rows = await course.db.fetch("SELECT name, exam_relevant FROM topics WHERE project_id = $1 ORDER BY order_index", course.project_id)
    return {row["name"]: row["exam_relevant"] for row in rows}


async def map_of(course, material):
    value = await course.db.fetchval("SELECT exam_topic_map FROM materials WHERE id = $1", material)
    return json.loads(value) if isinstance(value, str) else value


@pytest.fixture
async def three_topics(course):
    ids = SimpleNamespace(
        counting=await add_topic(course, "Counting", index=0),
        bayes=await add_topic(course, "Bayes' theorem", index=1),
        graphs=await add_topic(course, "Graph traversal", index=2),
    )
    return course, ids


# ---------------------------------------------------------------- the input


class TestBuildMaps:
    FILES = [{"id": "m1"}, {"id": "m2"}]
    TOPICS = [{"key": "T1", "id": "id1"}, {"key": "T2", "id": "id2"}, {"key": "T3", "id": "id3"}, {"key": "T4", "id": "id4"}]

    def test_keys_become_ids_and_junk_is_dropped(self):
        result = ExamTopicMap(questions=[
            q("Problem 1", "x", "T1", "t2", "T1", "T9", "T3", "T4"),
            q("Problem 2", "y", exam=2),
            q("Problem 3", "z", "T1", exam=3),  # no third exam
            q("Problem 4", "w", "T2", exam=0),
        ])
        maps = build_maps(result, self.TOPICS, self.FILES)
        assert maps["m1"] == [{"label": "Problem 1", "summary": "x", "topic_ids": ["id1", "id2", "id3"]}]
        assert maps["m2"] == [{"label": "Problem 2", "summary": "y", "topic_ids": []}]


# ---------------------------------------------------------------- the model call


FILES = [{"id": "m1", "filename": "e.pdf", "body": "b", "text": "Compute the probability that both of the marbles drawn are red, as a fraction."}]
TOPICS = [{"key": "T1", "id": "id1", "name": "Probability", "objectives": []}]
COPY = "Compute the probability that both of the marbles drawn are red"


class TestClassify:

    async def test_a_copied_summary_triggers_one_retry_that_names_the_question(self):
        provider, patched = scripted(
            ExamTopicMap(questions=[q("Problem 1", COPY, "T1")]),
            ExamTopicMap(questions=[q("Problem 1", "Chance of two same-coloured draws", "T1")]),
        )
        with patched:
            maps = await classify_questions(TOPICS, FILES)
        assert len(provider.prompts) == 2 and "Problem 1" in provider.prompts[1] and "new words" in provider.prompts[1]
        assert maps["m1"][0]["summary"] == "Chance of two same-coloured draws"

    async def test_a_summary_that_still_copies_is_blanked_but_keeps_its_topics(self):
        provider, patched = scripted(ExamTopicMap(questions=[q("Problem 1", COPY, "T1")]), ExamTopicMap(questions=[q("Problem 1", COPY, "T1")]))
        with patched:
            maps = await classify_questions(TOPICS, FILES)
        assert len(provider.prompts) == 2
        assert maps["m1"] == [{"label": "Problem 1", "summary": "", "topic_ids": ["id1"]}]


# ---------------------------------------------------------------- the project run


class TestMark:
    async def test_a_topic_no_question_tests_stays_false(self, three_topics):
        course, ids = three_topics
        material = await add_file(course)
        provider, patched = scripted(ExamTopicMap(questions=[
            q("Problem 1", "Chance of a total with two dice", "T1"),
            q("Problem 2", "Probability of illness after a positive test", "T2", "T1"),
            q("Problem 3", "Spread of a coin-flip count"),
        ]))

        with patched:
            result = await mark_exam_relevant_topics(course.project_id)

        assert await flags(course) == {"Counting": True, "Bayes' theorem": True, "Graph traversal": False}
        assert result == {"topics": 3, "relevant": 2, "changed": 2, "questions": 3, "model_calls": 1}
        stored = await map_of(course, material)
        assert stored["version"] == 1 and stored["input_hash"]
        assert stored["questions"][1] == {"label": "Problem 2", "summary": "Probability of illness after a positive test",
                                           "topic_ids": [ids.bayes, ids.counting]}
        assert stored["questions"][2]["topic_ids"] == []


    async def test_a_second_run_with_nothing_changed_makes_no_model_call(self, three_topics):
        course, ids = three_topics
        await add_file(course)
        provider, patched = scripted(ExamTopicMap(questions=[q("Problem 1", "Dice totals", "T1")]))
        with patched:
            await mark_exam_relevant_topics(course.project_id)
            await course.db.execute("UPDATE topics SET exam_relevant = FALSE WHERE project_id = $1", course.project_id)
            again = await mark_exam_relevant_topics(course.project_id)
        assert len(provider.prompts) == 1
        assert again["model_calls"] == 0 and again["changed"] == 1
        assert await flags(course) == {"Counting": True, "Bayes' theorem": False, "Graph traversal": False}


    async def test_without_a_past_exam_every_flag_is_cleared_with_no_model_call(self, three_topics):
        course, ids = three_topics
        await course.db.execute("UPDATE topics SET exam_relevant = TRUE WHERE project_id = $1", course.project_id)
        called = []

        async def guard():
            called.append(1)

        result = await mark_exam_relevant_topics(course.project_id, before_model=guard)

        assert called == [] and result["model_calls"] == 0 and result["changed"] == 3
        assert not any((await flags(course)).values())

    async def test_flags_and_maps_follow_the_exam_files(self, three_topics):
        course, ids = three_topics
        first = await add_file(course)
        provider, patched = scripted(
            ExamTopicMap(questions=[q("Problem 1", "Dice totals", "T1")]),
            ExamTopicMap(questions=[q("Problem 1", "Dice totals", "T1"), q("Problem 1", "Searching a network", "T3", exam=2)]),
        )
        with patched:
            await mark_exam_relevant_topics(course.project_id)
            second = await add_file(course)
            await mark_exam_relevant_topics(course.project_id)
            assert (await flags(course))["Graph traversal"] is True
            assert (await map_of(course, second))["questions"][0]["topic_ids"] == [ids.graphs]
            # The first stops being an exam: its map goes, and so does what only it covered.
            provider.answers.append(ExamTopicMap(questions=[q("Problem 1", "Searching a network", "T3")]))
            await course.db.execute("UPDATE materials SET role = 'content' WHERE id = $1", first)
            await mark_exam_relevant_topics(course.project_id)
        assert await map_of(course, first) is None
        assert await flags(course) == {"Counting": False, "Bayes' theorem": False, "Graph traversal": True}
        # The last exam is deleted: nothing is left to test any topic.
        await course.db.execute("DELETE FROM materials WHERE id = $1", second)
        await mark_exam_relevant_topics(course.project_id)
        assert not any((await flags(course)).values())


    async def test_other_projects_are_untouched(self, three_topics):
        course, ids = three_topics
        other = await seed_project(course.db, course.user_id)
        await course.db.execute(
            "INSERT INTO topics (id, project_id, name, order_index, exam_relevant) VALUES ($1, $2, 'Elsewhere', 0, TRUE)", new_id(), other
        )
        await add_file(course)
        provider, patched = scripted(ExamTopicMap(questions=[q("Problem 1", "Dice totals", "T1")]))
        with patched:
            await mark_exam_relevant_topics(course.project_id)
        assert await course.db.fetchval("SELECT exam_relevant FROM topics WHERE project_id = $1", other) is True

    async def test_a_model_failure_changes_nothing(self, three_topics):
        course, ids = three_topics
        await add_file(course)
        await course.db.execute("UPDATE topics SET exam_relevant = TRUE WHERE id = $1", ids.graphs)
        provider, patched = scripted(LLMUnavailableError("busy"))
        with patched, pytest.raises(LLMUnavailableError):
            await mark_exam_relevant_topics(course.project_id)
        assert (await flags(course))["Graph traversal"] is True


# ---------------------------------------------------------------- with the mock provider, and the jobs


@pytest.fixture
def mock_llm(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    LLMFactory.reset()
    yield
    LLMFactory.reset()


async def run_job(course):
    job_id = await seed_job(course.db, course.user_id, "exam_relevance", project_id=course.project_id,
                            input_data={"projectId": course.project_id})
    payload = JobPayload(jobId=job_id, jobType="exam_relevance", data={"projectId": course.project_id})
    return job_id, payload


async def test_over_budget_the_model_is_not_called_but_clearing_still_works(three_topics, mock_llm, monkeypatch):
    course, _ = three_topics

    monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.0)
    await seed_usage(course.db, course.user_id, 1.25)
    await add_file(course)
    job_id, payload = await run_job(course)
    with pytest.raises(HTTPException) as raised:
        await jobs.exam_relevance_job(payload)
    assert raised.value.status_code == 400
    row = await get_job(course.db, job_id)
    assert row["error_code"] == "LLM_DAILY_BUDGET" and row["retryable"] is False

    await course.db.execute("DELETE FROM materials WHERE project_id = $1", course.project_id)
    await course.db.execute("UPDATE topics SET exam_relevant = TRUE WHERE project_id = $1", course.project_id)
    _, payload = await run_job(course)
    assert (await jobs.exam_relevance_job(payload))["status"] == "success"
    assert not any((await flags(course)).values())


# ---- after planning


async def plan(c):
    from tests.test_course_planner import run_extract

    return await run_extract(SimpleNamespace(db=c.db, user_id=c.user_id, project_id=c.project_id))


async def lecture_file(c):
    material = await seed_material(c.db, c.project_id, filename="notes.pdf", status="valid", role="content")
    for index in range(3):
        await c.db.execute(
            "INSERT INTO material_chunks (id, material_id, chunk_text, section_hierarchy, page_start, page_end, chunk_index, token_count) "
            "VALUES ($1, $2, $3, $4, $5, $5, $6, 300)",
            new_id(), material, f"Hashing part {index} explains a definition.", f"Hashing > Part {index}", index + 1, index,
        )


async def test_planning_marks_the_topics_the_exams_test(course, mock_llm):
    await lecture_file(course)
    exam = await add_file(course)

    await plan(course)

    marked = await flags(course)
    assert marked and any(marked.values())
    stored = await map_of(course, exam)
    assert stored["questions"] and all(item["topic_ids"] for item in stored["questions"])


async def test_a_relevance_failure_does_not_fail_planning(course, mock_llm, monkeypatch):
    async def broken(project_id, **kwargs):
        raise RuntimeError("model down")

    monkeypatch.setattr(exam_relevance, "mark_exam_relevant_topics", broken)
    await lecture_file(course)
    await add_file(course)

    assert (await plan(course))["status"] == "success"

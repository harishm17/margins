"""Fresh-review quizzes: a quiz set may take 1-2 questions from a prerequisite topic."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services.content_generator.context import existing_content_digest
from app.services.content_generator.quiz import (
    PREREQUISITE_MAX_CHUNKS,
    PREREQUISITE_TOKEN_BUDGET,
    QuizGenerator,
)
from app.services.llm.schemas import ChoiceOption, GeneratedQuestion, QuestionSet
from tests.context_stub import stub_topic_context, topic_context
from tests.db_helpers import new_id, seed_job, seed_project, seed_topic, seed_user


pytestmark = pytest.mark.usefixtures("passthrough_support")


def chunk(n, kind="primary", tokens=100, material="m-own"):
    return {
        "id": f"{material}-{n}", "chunk_text": f"text {material} {n}", "section_hierarchy": "S",
        "page_start": n, "page_end": n, "filename": f"{material}.pdf", "category": "lecture_notes",
        "material_id": material, "token_count": tokens, "source_kind": kind,
    }


OWN = [chunk(1), chunk(2), chunk(3, "supporting")]
PREREQ = [chunk(n, material="m-pre") for n in range(1, 9)]
PREREQ_CONTEXT = topic_context(PREREQ, name="Limits")


def mcq(text, excerpts):
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=text,
        options=[ChoiceOption(id=x, text=f"Option {x}", misconception="wrong idea") for x in "ABCD"],
        correct_answer="B", explanation="Because.", source_excerpts=excerpts,
    )


async def run(questions, *, prerequisite="pre", contexts=None, question_count=6, **kwargs):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=QuestionSet(questions=questions))
    contexts = {"pre": PREREQ_CONTEXT} if contexts is None else contexts
    with stub_topic_context(OWN, contexts=contexts), \
         patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        result = await QuizGenerator().generate_quiz(
            "t1", "Derivatives", "desc", question_count=question_count,
            prerequisite_topic_id=prerequisite, **kwargs,
        )
    messages = llm.generate_structured.call_args.args[0]
    return result, messages[1].content, messages[2].content


QUESTIONS = [mcq(f"Q{n}", [1]) for n in range(5)] + [mcq("Review", [4])]


class TestPrerequisiteExcerpts:
    @pytest.mark.asyncio
    async def test_appended_after_the_topics_own_chunks_with_the_header(self):
        _, excerpts, _ = await run(QUESTIONS)

        header = "Excerpts from the prerequisite topic 'Limits' (only the review questions about that topic use these; the other questions never do):"
        assert excerpts.count(header) == 1
        assert excerpts.index('<excerpt index="3"') < excerpts.index(header) < excerpts.index('<excerpt index="4"')
        assert excerpts.count('use="prerequisite"') == PREREQUISITE_MAX_CHUNKS
        assert 'index="4" source="m-pre.pdf"' in excerpts and 'index="10"' not in excerpts

    @pytest.mark.asyncio
    async def test_not_present_without_a_prerequisite(self):
        _, excerpts, instructions = await run(QUESTIONS, prerequisite=None)

        assert "prerequisite" not in excerpts and "Review questions" not in instructions
        assert excerpts.count("<excerpt ") == 3

    @pytest.mark.asyncio
    async def test_only_the_primary_chunks_are_used(self):
        mixed = topic_context([chunk(1, material="m-pre"), chunk(2, "supporting", material="m-pre"),
                               chunk(3, material="m-pre")], name="Limits")
        _, excerpts, _ = await run(QUESTIONS, contexts={"pre": mixed})

        assert excerpts.count('use="prerequisite"') == 2

    @pytest.mark.asyncio
    async def test_all_chunks_are_used_when_none_is_primary(self):
        mapped = topic_context([chunk(n, "mapped", material="m-pre") for n in range(1, 4)], name="Limits")
        _, excerpts, _ = await run(QUESTIONS, contexts={"pre": mapped})

        assert excerpts.count('use="prerequisite"') == 3

    @pytest.mark.asyncio
    async def test_token_cap(self):
        big = topic_context([chunk(n, tokens=1000, material="m-pre") for n in range(1, 7)], name="Limits")
        _, excerpts, _ = await run(QUESTIONS, contexts={"pre": big})

        assert excerpts.count('use="prerequisite"') == PREREQUISITE_TOKEN_BUDGET // 1000

class TestPrerequisiteQuestions:
    @pytest.mark.asyncio
    async def test_only_prerequisite_sourced_questions_are_tagged(self):
        mixed = mcq("Mixed", [1, 5])
        none = mcq("None", [])
        result, _, _ = await run([mcq("Own", [1]), mcq("Review", [4, 5]), mixed, none, mcq("A", [2]),
                                  mcq("B", [2])])

        tags = {q["question_text"]: q.get("prerequisite_topic") for q in result["questions"]}
        assert tags == {"Own": None, "Review": "Limits", "Mixed": None, "None": None, "A": None, "B": None}
        assert all("source_excerpts" not in q for q in result["questions"])
        review = next(q for q in result["questions"] if q["question_text"] == "Review")
        assert [s["filename"] for s in review["sources"]] == ["m-pre.pdf"]

    @pytest.mark.parametrize("count, requested, expected", [(3, 2, 1), (5, 2, 1), (6, 2, 2), (10, 1, 1), (10, 2, 2), (12, 9, 2)])
    @pytest.mark.asyncio
    async def test_instruction_block_count(self, count, requested, expected):
        _, _, instructions = await run(QUESTIONS * 3, question_count=count, prerequisite_questions=requested)

        assert f"exactly {expected} of the {count + 2} questions must test the prerequisite topic \"Limits\"" in instructions
        assert f"The other {count + 2 - expected} questions" in instructions

    @pytest.mark.asyncio
    async def test_too_short_a_quiz_has_no_review(self):
        result, excerpts, instructions = await run([mcq("A", [1]), mcq("B", [2])], question_count=2)

        assert "prerequisite" not in excerpts and "Review questions" not in instructions
        assert result["total_questions"] == 2


class TestPrerequisiteIgnored:
    @pytest.mark.asyncio
    async def test_the_topic_itself(self):
        _, excerpts, instructions = await run(QUESTIONS, prerequisite="t1")

        assert "prerequisite" not in excerpts and "Review questions" not in instructions

    @pytest.mark.asyncio
    async def test_no_excerpts(self):
        result, excerpts, instructions = await run(QUESTIONS, contexts={"pre": topic_context([])})

        assert "prerequisite" not in excerpts and "Review questions" not in instructions
        assert result["total_questions"] == 6
        assert all("prerequisite_topic" not in q for q in result["questions"])

class FakeQuiz:
    kwargs = None

    async def generate_quiz(self, **kwargs):
        FakeQuiz.kwargs = kwargs
        return {"questions": [{"question_text": "Q"}], "total_questions": 1,
                "difficulty_level": "medium", "question_types": ["multiple_choice"]}


@pytest.fixture
async def world(db, monkeypatch):
    monkeypatch.setattr(jobs, "QuizGenerator", FakeQuiz)
    FakeQuiz.kwargs = None
    user = await seed_user(db)
    project = await seed_project(db, user)
    return SimpleNamespace(
        user=user, project=project, topic=await seed_topic(db, project, "Derivatives"),
        prerequisite=await seed_topic(db, project, "Limits"),
        other=await seed_topic(db, await seed_project(db, user), "Elsewhere"),
    )


async def run_job(db, world, **preferences):
    job_id = await seed_job(db, world.user, project_id=world.project)
    payload = JobPayload(jobId=job_id, jobType="generate_content", data={
        "topicId": world.topic, "contentType": "topic_quiz", "preferences": preferences})
    assert (await jobs.generate_content_job(payload))["status"] == "success"
    return FakeQuiz.kwargs


class TestJobWiring:
    async def test_preferences_are_passed_through(self, db, world):
        kwargs = await run_job(db, world, prerequisite_topic_id=world.prerequisite, prerequisite_questions=1)

        assert kwargs["prerequisite_topic_id"] == world.prerequisite
        assert kwargs["prerequisite_questions"] == 1

    async def test_question_count_defaults_to_two_and_is_clamped(self, db, world):
        assert (await run_job(db, world, prerequisite_topic_id=world.prerequisite))["prerequisite_questions"] == 2
        assert (await run_job(db, world, prerequisite_topic_id=world.prerequisite, prerequisite_questions=7))["prerequisite_questions"] == 2
        assert (await run_job(db, world, prerequisite_topic_id=world.prerequisite, prerequisite_questions=0))["prerequisite_questions"] == 1
        assert (await run_job(db, world, prerequisite_topic_id=world.prerequisite, prerequisite_questions="x"))["prerequisite_questions"] == 2

    async def test_ignored_ids(self, db, world):
        for value in (None, "", 5, world.topic, world.other, new_id()):
            kwargs = await run_job(db, world, prerequisite_topic_id=value)
            assert kwargs["prerequisite_topic_id"] is None, value

class TestDigestIgnoresRetrySets:
    async def test_retry_sets_are_left_out(self, db):
        user = await seed_user(db)
        topic = await seed_topic(db, await seed_project(db, user))
        for kind, stem in (("standard", "A standard question"), ("retry", "A retry question")):
            await db.execute(
                "INSERT INTO topic_quizzes (id, topic_id, questions, kind) VALUES ($1, $2, $3::jsonb, $4)",
                new_id(), topic, json.dumps([{"question_text": stem}]), kind,
            )

        digest = await existing_content_digest(topic)

        assert "A standard question" in digest and "retry" not in digest

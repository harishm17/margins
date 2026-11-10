"""Past-exam style profiles: the copy check, extraction, merging, the prompt block, storage, the jobs
that build them, and mock exam generation that uses them."""
import json
from types import SimpleNamespace
from typing import List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api.routes import jobs
from app.config import settings
from app.models.jobs import JobPayload
from app.services import exam_style
from app.services.exam_generator import ExamGenerator
from app.services.exam_style import (
    clear_style_profile,
    copying_stems,
    extract_style_profile,
    merge_profiles,
    profile_exam_material,
    project_style_profile,
    style_guidance,
)
from app.services.llm.base import LLMUnavailableError
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import (
    ChoiceOption,
    ExamPointsBand,
    ExamStyleProfile,
    ExamTypeShare,
    GeneratedQuestion,
    QuestionSet,
)
from tests.context_stub import stub_topic_context
from tests.db_helpers import add_chunk, get_job, seed_job, seed_material, seed_project, seed_user



EXAM_TEXT = """Problem 1. A bag holds three red marbles and two blue marbles. You draw two marbles without
replacement. Compute the probability that both marbles are red. (10 points)

Problem 2. Explain why the sample mean of independent identically distributed observations is an unbiased
estimator of the population mean. (10 points)
"""


def profile(**overrides) -> ExamStyleProfile:
    data = ExamStyleProfile.example().model_dump()
    data.update(overrides)
    return ExamStyleProfile(**data)


# ---------------------------------------------------------------- the copy check


class TestCopyingStems:
    def test_a_run_of_eight_words_is_a_copy(self):
        stem = "Suppose a bag holds three red marbles and two blue marbles, what then?"
        assert copying_stems([stem], EXAM_TEXT) == [stem]

    def test_seven_shared_words_are_not(self):
        stem = "A bag holds three red marbles and then something else entirely"
        assert copying_stems([stem], EXAM_TEXT) == []

    def test_case_punctuation_and_line_breaks_do_not_hide_a_copy(self):
        stem = "YOU DRAW two marbles, without; replacement. Compute the probability..."
        assert copying_stems([stem], EXAM_TEXT) == [stem]

    def test_a_short_stem_copied_whole_is_a_copy(self):
        text = "Question 3. State the central limit theorem. (5 points)"
        assert copying_stems(["State the central limit theorem."], text) == ["State the central limit theorem."]

    def test_a_paraphrase_is_kept(self):
        stem = "A jar contains four green beads and one yellow bead; two are removed. Find the chance both are green."
        assert copying_stems([stem], EXAM_TEXT) == []

    def test_only_the_offending_stems_are_returned(self):
        good = "Find the chance that two beads drawn from a jar are both green."
        bad = "Explain why the sample mean of independent identically distributed observations is fine."
        assert copying_stems([good, bad], EXAM_TEXT) == [bad]


# ---------------------------------------------------------------- extraction


class Scripted:
    """A provider that answers each call with the next item (an exception is raised)."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts: List[str] = []

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        assert schema is ExamStyleProfile and purpose == "exam_style"
        self.prompts.append(messages[-1].content)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


async def extract_with(provider, text=EXAM_TEXT):
    with patch("app.services.exam_style.LLMFactory.get_provider", return_value=provider):
        return await extract_style_profile(text, "midterm.pdf")


COPIED = "Explain why the sample mean of independent identically distributed observations is unbiased."
FRESH = ["A jar holds four green beads and one yellow bead; two are removed. Find P(both green).",
         "Show that doubling the sample leaves a sample average unbiased.",
         "Give two sentences on why a wider interval is less informative."]


class TestExtraction:
    async def test_clean_stems_take_one_call(self):
        provider = Scripted(profile(example_stems=FRESH))
        result = await extract_with(provider)
        assert len(provider.prompts) == 1
        assert result["example_stems"] == FRESH
        assert result["version"] == 1
        assert "<exam>" in provider.prompts[0] and "Problem 1." in provider.prompts[0]

    async def test_a_copied_stem_triggers_one_retry_that_names_it(self):
        provider = Scripted(profile(example_stems=[COPIED, *FRESH[:2]]), profile(example_stems=FRESH))
        result = await extract_with(provider)
        assert len(provider.prompts) == 2
        assert COPIED in provider.prompts[1] and "completely new words" in provider.prompts[1]
        assert result["example_stems"] == FRESH

    async def test_stems_that_still_copy_after_the_retry_are_dropped(self):
        provider = Scripted(
            profile(example_stems=[COPIED, *FRESH[:2]]), profile(example_stems=[COPIED, FRESH[0], FRESH[1]])
        )
        result = await extract_with(provider)
        assert len(provider.prompts) == 2  # never a third call
        assert result["example_stems"] == FRESH[:2]
        assert not copying_stems(result["example_stems"], EXAM_TEXT)

    async def test_a_failed_retry_keeps_the_first_answer_without_its_copies(self):
        provider = Scripted(profile(example_stems=[COPIED, *FRESH[:2]]), LLMUnavailableError("busy"))
        result = await extract_with(provider)
        assert result["example_stems"] == FRESH[:2]

    async def test_a_failed_first_call_is_raised_for_the_job_to_retry(self):
        with pytest.raises(LLMUnavailableError):
            await extract_with(Scripted(LLMUnavailableError("busy")))

    async def test_the_stored_profile_is_clean(self):
        messy = profile(
            type_mix=[ExamTypeShare(kind="short_answer", share=3), ExamTypeShare(kind="short_answer", share=1),
                      ExamTypeShare(kind="numerical", share=4)],
            points_distribution=[ExamPointsBand(points=10, questions=2), ExamPointsBand(points=10, questions=1),
                                 ExamPointsBand(points=0, questions=4)],
            task_verbs=["Compute", "compute", "Show"],
            phrasing_conventions=["  Opens with data ", "opens with data", ""],
            typical_answer_length="  ",
        )
        result = await extract_with(Scripted(messy))
        assert result["type_mix"] == [{"kind": "short_answer", "share": 0.5}, {"kind": "numerical", "share": 0.5}]
        assert result["points_distribution"] == [{"points": 10.0, "questions": 3}]
        assert result["task_verbs"] == ["compute", "show"]
        assert result["phrasing_conventions"] == ["Opens with data"]
        assert result["typical_answer_length"] == "not stated"

    async def test_a_long_exam_is_cut_for_the_model_but_checked_whole(self, monkeypatch):
        monkeypatch.setattr(exam_style, "MAX_EXAM_CHARS", 200)
        tail_copy = "Final problem: derive the Poisson limit of the binomial distribution as the number of trials grows."
        provider = Scripted(profile(example_stems=[tail_copy, *FRESH[:2]]), profile(example_stems=FRESH))
        text = "x " * 300 + tail_copy
        result = await extract_with(provider, text)
        assert "left out" in provider.prompts[0]
        assert len(provider.prompts) == 2  # the copy in the cut-off part was still caught
        assert result["example_stems"] == FRESH


# ---------------------------------------------------------------- merging and the prompt


def stored(**overrides) -> dict:
    return {**profile().model_dump(), "version": 1, **overrides}


class TestMerge:
    def test_nothing_to_merge(self):
        assert merge_profiles([]) is None
        assert merge_profiles([None, "nope", 3]) is None

    def test_one_profile_is_returned_as_it_is(self):
        one = stored()
        assert merge_profiles([one]) == one

    def test_json_text_from_the_database_is_accepted(self):
        assert merge_profiles([json.dumps(stored())]) == stored()

    def test_counts_add_and_shares_are_weighted_by_question_count(self):
        a = stored(question_count=30, total_points=100, type_mix=[{"kind": "multiple_choice", "share": 1.0}],
                   points_distribution=[{"points": 3, "questions": 30}])
        b = stored(question_count=10, total_points=50, type_mix=[{"kind": "derivation", "share": 1.0}],
                   points_distribution=[{"points": 3, "questions": 4}, {"points": 10, "questions": 6}])
        merged = merge_profiles([a, b])
        assert merged["question_count"] == 40
        assert merged["total_points"] == 150
        assert merged["type_mix"] == [{"kind": "multiple_choice", "share": 0.75}, {"kind": "derivation", "share": 0.25}]
        assert merged["points_distribution"] == [{"points": 3.0, "questions": 34}, {"points": 10.0, "questions": 6}]
        assert merged["exams_merged"] == 2

    def test_lists_interleave_so_every_exam_is_represented(self):
        a = stored(example_stems=["a1", "a2", "a3"], phrasing_conventions=["pa"], task_verbs=["compute", "find"])
        b = stored(example_stems=["b1", "b2", "b3"], phrasing_conventions=["pb", "PA"], task_verbs=["show", "compute"])
        merged = merge_profiles([a, b])
        assert merged["example_stems"] == ["a1", "b1", "a2"]
        assert merged["phrasing_conventions"] == ["pa", "pb"]
        assert merged["task_verbs"][:2] == ["compute", "show"]  # the verb both use ranks first

    def test_multi_part_if_any_exam_has_it_and_notes_skip_not_stated(self):
        a = stored(multi_part=False, calculator_and_units="not stated")
        b = stored(multi_part=True, calculator_and_units="No calculators; units required")
        merged = merge_profiles([a, b])
        assert merged["multi_part"] is True
        assert merged["calculator_and_units"] == "No calculators; units required"
        assert merge_profiles([a, stored(calculator_and_units="not stated")])["calculator_and_units"] == "not stated"


class TestGuidance:
    def test_the_block_carries_every_part_of_the_profile(self):
        text = style_guidance(stored(total_points=100, task_verbs=["compute", "justify"]))
        for expected in ("5 questions, 100 points", "60% short answer", "40% multi-step", "5 worth 10", "compute, justify",
                         "labelled parts", "Examples of the voice", "A fair die is rolled twice", "Never copy a question"):
            assert expected in text

    def test_single_part_exams_say_so(self):
        assert "single-part" in style_guidance(stored(multi_part=False))

    def test_empty_parts_are_left_out(self):
        text = style_guidance(stored(question_count=0, points_distribution=[], example_stems=[], task_verbs=[],
                                     calculator_and_units="not stated", typical_answer_length="not stated"))
        assert "Points:" not in text and "Examples of the voice" not in text and "Calculators" not in text
        assert "A full answer" not in text


# ---------------------------------------------------------------- the database


@pytest.fixture
def mock_llm(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    LLMFactory.reset()
    yield
    LLMFactory.reset()


@pytest.fixture
async def course(db, mock_llm):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    return SimpleNamespace(db=db, user_id=user_id, project_id=project_id)


async def exam_file(course, filename="midterm.pdf", role="exam", text=EXAM_TEXT, status="valid") -> str:
    material = await seed_material(course.db, course.project_id, filename=filename, status=status, role=role)
    for index, part in enumerate(text.split("\n\n")):
        await add_chunk(course.db, material, index, part)
    return material


async def style_of(db, material_id):
    value = await db.fetchval("SELECT style_profile FROM materials WHERE id = $1", material_id)
    return json.loads(value) if isinstance(value, str) else value


class TestStorage:
    async def test_an_exam_gets_a_profile(self, course):
        material = await exam_file(course)
        result = await profile_exam_material(material)
        assert result["status"] == "profiled"
        stored_profile = await style_of(course.db, material)
        assert stored_profile["question_count"] == 2 and len(stored_profile["example_stems"]) == 3

    async def test_a_file_that_is_not_an_exam_gets_none_and_loses_an_old_one(self, course):
        material = await exam_file(course, role="content")
        await course.db.execute("UPDATE materials SET style_profile = $2::jsonb WHERE id = $1", material, json.dumps(stored()))
        result = await profile_exam_material(material)
        assert result == {"status": "skipped", "reason": "not a past exam"}
        assert await style_of(course.db, material) is None

    async def test_a_file_with_no_text_or_no_record_is_skipped(self, course):
        empty = await seed_material(course.db, course.project_id, status="valid", role="exam")
        assert (await profile_exam_material(empty))["status"] == "skipped"
        assert (await profile_exam_material("00000000-0000-0000-0000-000000000000"))["status"] == "skipped"

    async def test_the_role_changing_during_the_model_call_stores_nothing(self, course, monkeypatch):
        material = await exam_file(course)
        real = exam_style.extract_style_profile

        async def slow(text, filename):
            result = await real(text, filename)
            await course.db.execute("UPDATE materials SET role = 'content' WHERE id = $1", material)
            return result

        monkeypatch.setattr(exam_style, "extract_style_profile", slow)
        assert (await profile_exam_material(material)) == {"status": "skipped", "reason": "role changed"}
        assert await style_of(course.db, material) is None

    async def test_clear_removes_the_profile(self, course):
        material = await exam_file(course)
        await profile_exam_material(material)
        await clear_style_profile(material)
        assert await style_of(course.db, material) is None

    async def test_the_course_profile_merges_its_exams_and_ignores_other_files(self, course):
        a = await exam_file(course, "a.pdf")
        b = await exam_file(course, "b.pdf", text="Problem 1. First.\n\nProblem 2. Second.\n\nProblem 3. Third.")
        content = await exam_file(course, "c.pdf", role="content")
        gone = await exam_file(course, "d.pdf", status="invalid")
        for material in (a, b, content, gone):
            await course.db.execute(
                "UPDATE materials SET style_profile = $2::jsonb WHERE id = $1", material, json.dumps(stored(question_count=4))
            )
        merged = await project_style_profile(course.project_id)
        assert merged["exams_merged"] == 2 and merged["question_count"] == 8

    async def test_a_course_without_profiles_has_none(self, course):
        await exam_file(course)
        assert await project_style_profile(course.project_id) is None


class TestJobs:
    @pytest.fixture
    def dispatched(self, monkeypatch):
        sent = SimpleNamespace(profiles=[], relevance=[])
        monkeypatch.setattr(jobs, "enqueue_exam_profile_job", AsyncMock(side_effect=lambda j, m: sent.profiles.append((j, m))))
        monkeypatch.setattr(jobs, "enqueue_exam_relevance_job", AsyncMock(side_effect=lambda j, p: sent.relevance.append((j, p))))
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "key")
        return sent

    async def test_a_chunked_exam_starts_a_profile_and_a_relevance_job(self, course, dispatched):
        material = await exam_file(course)
        await jobs._start_exam_jobs(material, course.project_id, course.user_id)
        assert [m for _, m in dispatched.profiles] == [material]
        assert [p for _, p in dispatched.relevance] == [course.project_id]
        rows = await course.db.fetch("SELECT job_type, target_key FROM processing_jobs ORDER BY job_type")
        assert [(r["job_type"], r["target_key"]) for r in rows] == [
            ("exam_relevance", f"exam-relevance:{course.project_id}"),
            ("profile_exam", f"profile:{material}"),
        ]

    async def test_running_it_twice_does_not_double_the_jobs(self, course, dispatched):
        material = await exam_file(course)
        await jobs._start_exam_jobs(material, course.project_id, course.user_id)
        await jobs._start_exam_jobs(material, course.project_id, course.user_id)
        assert len(dispatched.profiles) == 1 and len(dispatched.relevance) == 1

    async def test_other_files_start_nothing(self, course, dispatched):
        for role in ("content", "syllabus", "other"):
            await jobs._start_exam_jobs(await exam_file(course, role=role), course.project_id, course.user_id)
        assert dispatched.profiles == [] and dispatched.relevance == []

    async def test_without_a_model_no_job_starts(self, course, dispatched, monkeypatch):
        monkeypatch.setattr(settings, "LLM_PROVIDER", "anthropic")
        monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
        material = await exam_file(course)
        await jobs._start_exam_jobs(material, course.project_id, course.user_id)
        assert dispatched.profiles == [] and dispatched.relevance == []

    async def test_the_profile_job_stores_the_profile_and_records_usage_rows(self, course):
        material = await exam_file(course)
        job_id = await seed_job(course.db, course.user_id, "profile_exam", project_id=course.project_id,
                                input_data={"materialId": material})
        response = await jobs.profile_exam_job(JobPayload(jobId=job_id, jobType="profile_exam", data={"materialId": material}))
        assert response["status"] == "success"
        assert (await style_of(course.db, material))["question_count"] == 2
        job = await get_job(course.db, job_id)
        assert job["status"] == "completed" and json.loads(job["result_data"])["status"] == "profiled"


# ---------------------------------------------------------------- exam generation


GENERATOR_TOPICS = [{"id": "t1", "name": "Topic 1", "description": "d1", "keywords": []}]
CHUNKS = [{"id": "c", "chunk_text": "text", "filename": "f.pdf", "category": "x", "page_start": 1, "page_end": 1}]


async def generate(config, merged):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=QuestionSet(questions=[
        GeneratedQuestion(question_type="multiple_choice", question_text=f"Q{i}",
                          options=[ChoiceOption(id=x, text=f"{i}{x}", misconception="wrong idea") for x in "ABCD"], correct_answer="A", explanation="E")
        for i in range(5)
    ]))
    lookup = AsyncMock(return_value=merged)
    with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=GENERATOR_TOPICS)), \
         patch("app.services.exam_generator.project_style_profile", lookup), \
         stub_topic_context(CHUNKS), \
         patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
        exam = await ExamGenerator().generate_exam(
            "p1", ["t1"], {"total_questions": 5, "question_type_distribution": {"multiple_choice": 100}, **config}
        )
    prompt = llm.generate_structured.call_args.args[0][-1].content
    return exam, prompt, lookup


@pytest.mark.usefixtures("passthrough_support")
class TestMatchPastExams:
    async def test_the_merged_profile_reaches_the_prompt(self):
        exam, prompt, lookup = await generate({"match_past_exams": True}, stored(task_verbs=["justify"]))
        lookup.assert_awaited_once_with("p1")
        assert "past exams for this course look like this" in prompt and "justify" in prompt
        assert "A fair die is rolled twice" in prompt
        assert exam["matched_past_exams"] is True

    async def test_without_the_option_the_profile_is_not_read(self):
        exam, prompt, lookup = await generate({}, stored())
        lookup.assert_not_awaited()
        assert "past exams" not in prompt and exam["matched_past_exams"] is False

    async def test_the_option_with_no_profile_changes_nothing(self):
        exam, prompt, _ = await generate({"match_past_exams": True}, None)
        assert "past exams" not in prompt and exam["matched_past_exams"] is False

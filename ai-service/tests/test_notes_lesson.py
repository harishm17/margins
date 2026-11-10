"""The lesson format of the notes, ```check blocks, and the quiz, exam and practice prompts."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.content_generator.examples import ExampleType, ExamplesGenerator
from app.services.content_generator.notes import NotesGenerator
from app.services.content_generator.quiz import APPLICATION_RULES, QuizGenerator
from app.services.exam_generator import ExamGenerator
from app.services.llm.base import LLMResponse, LLMUsage
from app.services.llm.schemas import (
    ChoiceOption,
    GeneratedQuestion,
    QuestionSet,
    SolutionStep,
    SolvedExample,
    SolvedExampleSet,
)
from tests.context_stub import stub_topic_context, topic_context



CHUNKS = [
    {"id": "c1", "chunk_text": "Bayes' rule updates a prior.", "section_hierarchy": "L1 > Bayes", "page_start": 3, "page_end": 3,
     "material_id": "m1", "filename": "bio.pdf", "category": "lecture_notes", "source_kind": "primary"},
    {"id": "c2", "chunk_text": "More on posteriors.", "section_hierarchy": "L1 > Bayes", "page_start": 4, "page_end": 5,
     "material_id": "m1", "filename": "bio.pdf", "category": "lecture_notes", "source_kind": "primary"},
    {"id": "c3", "chunk_text": "A different file.", "section_hierarchy": None, "page_start": 9, "page_end": 9,
     "material_id": "m2", "filename": "other.pdf", "category": "lecture_notes", "source_kind": "supporting"},
]

LESSON = """# Bayes' rule

## What you'll learn
- You can compute a posterior.

## The idea
Start from what you believed.
""" + ("More words about updating beliefs with evidence. " * 30) + """

## Key concepts
- Prior and posterior.

## Worked example
A test is 99% accurate.

## Check yourself
```check
Q: What is the prior?
A: What you believed before the data.
```

## Common pitfalls
- Confusing P(A|B) with P(B|A).

## Summary
- Posterior is proportional to prior times likelihood.
"""


def clean(raw: str) -> str:
    return NotesGenerator.__new__(NotesGenerator)._postprocess_notes_markdown(raw)


def _llm(text=None, structured=None):
    llm = MagicMock()
    llm.generate_text = AsyncMock(
        return_value=LLMResponse(content=text or "", model="m", stop_reason="end_turn", usage=LLMUsage(model="m"))
    )
    llm.generate_structured = AsyncMock(return_value=structured)
    return llm


def factory(llm):
    return patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm)


class TestLessonPrompt:
    async def test_the_instructions_ask_for_the_lesson_structure(self):
        llm = _llm(text=LESSON)
        with stub_topic_context(CHUNKS, course_map="Course map: A, B"), factory(llm):
            await NotesGenerator().generate_notes("t1", "Bayes' rule", "d")
        messages = llm.generate_text.call_args.args[0]
        instructions = messages[-1].content
        order = [instructions.index(h) for h in (
            "# Bayes' rule", "## What you'll learn", "## The idea", "## Key concepts", "## Worked example",
            "## Check yourself", "## Common pitfalls", "## Summary",
        )]
        assert order == sorted(order)
        assert "```check" in instructions and 'as "Q: ..."' in instructions and '"A: ..."' in instructions
        assert "5-8 recall bullets" in instructions
        assert "Course map: A, B" in messages[1].content  # in the excerpt block, not the instructions

    async def test_objectives_from_the_course_map_are_the_what_youll_learn_bullets(self):
        llm = _llm(text=LESSON)
        context = topic_context(CHUNKS, objectives=["compute a posterior"])
        with stub_topic_context(CHUNKS, context=context), factory(llm):
            await NotesGenerator().generate_notes("t1", "T", "d")
        assert "the topic's objectives from the course map" in llm.generate_text.call_args.args[0][-1].content

    async def test_without_objectives_the_model_writes_them(self):
        llm = _llm(text=LESSON)
        with stub_topic_context(CHUNKS), factory(llm):
            await NotesGenerator().generate_notes("t1", "T", "d")
        assert "3-5 bullets of what the student can do" in llm.generate_text.call_args.args[0][-1].content

    async def test_leaving_out_examples_leaves_out_the_worked_example_section(self):
        llm = _llm(text=LESSON)
        with stub_topic_context(CHUNKS), factory(llm):
            await NotesGenerator().generate_notes("t1", "T", "d", {"include_examples": False})
        assert "## Worked example" not in llm.generate_text.call_args.args[0][-1].content

    async def test_citations_come_from_the_primary_spans_and_skip_supporting_files(self):
        llm = _llm(text=LESSON)
        with stub_topic_context(CHUNKS), factory(llm):
            result = await NotesGenerator().generate_notes("t1", "T", "d")
        assert result["citations"] == [
            {"filename": "bio.pdf", "category": "lecture_notes", "pages": "3-5", "material_id": "m1", "page": 3}
        ]
        assert result["chunk_count"] == 3


class TestPostProcessing:
    def test_a_well_formed_lesson_is_unchanged(self):
        assert clean(LESSON) == LESSON.strip()

    @pytest.mark.parametrize(
        "bare, heading",
        [
            ("What you'll learn", "## What you'll learn"),
            ("What you\u2019ll learn", "## What you'll learn"),
            ("The idea", "## The idea"),
            ("KEY CONCEPTS:", "## Key concepts"),
            ("**Worked example**", "## Worked example"),
            ("check yourself", "## Check yourself"),
            ("Common Pitfalls", "## Common pitfalls"),
            ("Summary:", "## Summary"),
            ("Overview", "## Overview"),
            ("Exam-Ready Recap", "## Exam-ready recap"),
        ],
    )
    def test_bare_labels_become_headings(self, bare, heading):
        assert clean(f"Intro\n\n{bare}\nBody text").splitlines()[2] == heading

    def test_a_label_inside_a_sentence_or_a_heading_is_left_alone(self):
        text = "## Key Concepts\nThe summary of the idea is short.\nSummary statistics are useful."
        assert clean(text) == text

    def test_citation_tags_and_offers_of_help_are_still_removed(self):
        assert clean("Text [Citation: a.pdf p1] here.\nIf you want, I can write more.") == "Text here."

    def test_check_blocks_are_left_untouched(self):
        raw = "## Check yourself\n```check\nQ: Why?\n\n\nA: Because.\n```\n"
        assert clean(raw) == raw.strip()

    def test_the_fence_language_is_normalised(self):
        raw = "## Check yourself\n```Check\nQ: a\nA: b\n```\n\n```  check  \nQ: c\nA: d\n```"
        assert clean(raw).count("```check\n") == 2

    def test_loose_question_and_answer_lines_are_wrapped_in_check_blocks(self):
        raw = (
            "## Check yourself\nTry these.\n\n**Q1:** What is a prior?\n**A:** Belief before the data.\n\n"
            "Q2. What is $P(A|B)$?\nAnswer: The posterior.\nIt is read as A given B.\n\n## Summary\n- x"
        )
        out = clean(raw)
        assert out.count("```check") == 2
        assert "```check\nQ: What is a prior?\nA: Belief before the data.\n```" in out
        assert "Q: What is $P(A|B)$?\nA: The posterior. It is read as A given B.\n```" in out
        assert out.index("Try these.") < out.index("```check") and out.endswith("## Summary\n- x")

    def test_questions_without_answers_are_not_touched(self):
        raw = "## Check yourself\nQ: What is a prior?\nQ: What is a posterior?\n\n## Summary\n- x"
        assert "```check" not in clean(raw)

    def test_q_and_a_lines_in_other_sections_are_not_wrapped(self):
        raw = "## Worked example\nQ: How much?\nA: Ten.\n\n## Check yourself\n```check\nQ: a\nA: b\n```"
        assert clean(raw).count("```check") == 1

    def test_math_survives(self):
        raw = "## Check yourself\n```check\nQ: Compute $\\frac{1}{2} + \\frac{1}{3}$.\nA: $\\frac{5}{6}$\n```"
        assert clean(raw) == raw


@pytest.mark.usefixtures("passthrough_support")
class TestQuizAndExamPrompts:
    def _questions(self, n=4):
        return QuestionSet(questions=[
            GeneratedQuestion(question_type="true_false", question_text=f"S{i}", correct_answer=True, explanation="e")
            for i in range(n)
        ])

    async def test_the_quiz_prompt_asks_for_application_questions_with_new_numbers(self):
        llm = _llm(structured=self._questions())
        with stub_topic_context(CHUNKS), factory(llm):
            await QuizGenerator().generate_quiz("t1", "T", "d", question_count=4)
        instructions = llm.generate_structured.call_args.args[0][-1].content
        assert APPLICATION_RULES in instructions
        assert "At least half of the questions must apply a concept to a new situation" in instructions
        assert "differ from the worked examples in the excerpts and in the lesson" in instructions
        assert "List in source_excerpts" in instructions

    async def test_what_the_student_has_already_seen_is_passed_as_do_not_reuse_context(self):
        llm = _llm(structured=self._questions())
        digest = "Worked example in the notes:\nA test is 99% accurate; 1 in 1000 have the disease."
        with stub_topic_context(CHUNKS, digest=digest), factory(llm):
            await QuizGenerator().generate_quiz("t1", "T", "d", question_count=4)
        instructions = llm.generate_structured.call_args.args[0][-1].content
        assert "<already_seen>" in instructions and "99% accurate" in instructions
        assert "Do not reuse its numbers" in instructions

    async def test_no_context_block_when_the_student_has_seen_nothing(self):
        llm = _llm(structured=self._questions())
        with stub_topic_context(CHUNKS), factory(llm):
            await QuizGenerator().generate_quiz("t1", "T", "d", question_count=4)
        assert "<already_seen>" not in llm.generate_structured.call_args.args[0][-1].content

    async def test_the_quiz_prompt_still_caches_the_excerpts_only_for_regenerations(self):
        for regeneration in (False, True):
            llm = _llm(structured=self._questions())
            with stub_topic_context(CHUNKS, course_map="map"), factory(llm):
                await QuizGenerator().generate_quiz("t1", "T", "d", question_count=4, cache_excerpts=regeneration)
            messages = llm.generate_structured.call_args.args[0]
            assert [m.cache for m in messages] == [False, regeneration, False]
            assert "map" in messages[1].content

    async def test_questions_are_stored_with_file_and_page_references(self):
        questions = QuestionSet(questions=[
            GeneratedQuestion(question_type="true_false", question_text="A", correct_answer=True, explanation="e", source_excerpts=[1, 2]),
            GeneratedQuestion(question_type="true_false", question_text="B", correct_answer=False, explanation="e", source_excerpts=[3]),
            GeneratedQuestion(question_type="true_false", question_text="C", correct_answer=True, explanation="e"),
        ])
        llm = _llm(structured=questions)
        with stub_topic_context(CHUNKS), factory(llm):
            result = await QuizGenerator().generate_quiz("t1", "T", "d", question_count=3)
        a, b, c = result["questions"]
        assert a["sources"] == [{"material_id": "m1", "filename": "bio.pdf", "page_start": 3, "page_end": 5}]
        assert b["sources"] == [{"material_id": "m2", "filename": "other.pdf", "page_start": 9, "page_end": 9}]
        assert c["sources"] == [] and "source_excerpts" not in a

    async def test_exam_questions_get_the_same_rules_references_and_context(self):
        mcq = GeneratedQuestion(
            question_type="multiple_choice", question_text="Q", options=[ChoiceOption(id=x, text=f"o{x}", misconception="wrong idea") for x in "ABCD"],
            correct_answer="A", explanation="e", source_excerpts=[2],
        )
        llm = _llm(structured=QuestionSet(questions=[mcq]))
        topics = [{"id": "t1", "name": "Topic 1", "description": "d", "keywords": []}]
        with patch("app.services.exam_generator.execute_query", AsyncMock(return_value=topics)), \
             stub_topic_context(CHUNKS, digest="Solved examples:\n- Coin: Two fair coins"), factory(llm):
            exam = await ExamGenerator().generate_exam(
                "p1", ["t1"], {"total_questions": 1, "question_type_distribution": {"multiple_choice": 100}}
            )
        instructions = llm.generate_structured.call_args.args[0][-1].content
        assert APPLICATION_RULES in instructions and "Two fair coins" in instructions
        assert exam["questions"][0]["sources"] == [{"material_id": "m1", "filename": "bio.pdf", "page_start": 4, "page_end": 5}]


class TestExamplesAndPractice:
    async def test_solved_examples_are_stored_with_sources(self):
        example = SolvedExample(
            title="t", problem_statement="p", final_answer="a", source_excerpts=[1],
            solution_steps=[SolutionStep(step_number=1, description="d", work="w", explanation="e")],
        )
        llm = _llm(structured=SolvedExampleSet(examples=[example]))
        with stub_topic_context(CHUNKS, course_map="map"), factory(llm):
            result = await ExamplesGenerator().generate_examples("t1", "T", "d", ExampleType.SOLVED, count=1)
        assert result["examples"][0]["sources"] == [{"material_id": "m1", "filename": "bio.pdf", "page_start": 3, "page_end": 3}]
        messages = llm.generate_structured.call_args.args[0]
        assert "map" in messages[1].content and "source_excerpts" in messages[-1].content

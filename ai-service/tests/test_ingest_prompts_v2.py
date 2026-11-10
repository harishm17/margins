"""The audited (v2) prompts of the ingest area: upload check, course planner, concept extractor and
linker. With PROMPTS_V2 empty every request is the v1 text; with "ingest" it is the v2 text. No database."""
import contextlib
from typing import Dict, List, Optional

import pytest

from app.config import settings
from app.services import ai_status
from app.services import course_planner as planner
from app.services.concepts import extractor, linker
from app.services.content_generator import context as topic_context
from app.services.course_planner import Section
from app.services.document_processor import validator
from app.services.document_processor.extractors import ExtractedDocument, ExtractedPage
from app.services.llm.base import LLMMessage
from app.services.llm.schemas import (
    CoursePlan,
    CoursePlanV2,
    MaterialCheck,
    MaterialCheckV2,
)


@pytest.fixture
def v2(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "ingest")


@pytest.fixture
def v1(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "")


def section(n: int, filename: str = "notes.pdf", snippet: str = "snippet") -> Section:
    return Section(
        id=f"S{n}", material_id="m1", filename=filename, chunk_start=n, chunk_end=n + 1, page_start=n,
        page_end=n, tokens=2000, heading=f"Heading {n}", snippet=snippet, chunk_ids=[f"c{n}"], position=n,
    )


# ---------------------------------------------------------------- upload check (findings 1, 2)


class Capture:
    def __init__(self):
        self.messages: List[LLMMessage] = []
        self.schema = None
        self.kwargs: Dict = {}

    async def generate_structured(self, messages, schema, **kwargs):
        self.messages, self.schema, self.kwargs = messages, schema, kwargs
        return schema(is_valid=True, notes="ok", kind="content")


async def run_validator(monkeypatch, category="lecture_notes") -> Capture:
    provider = Capture()

    @contextlib.asynccontextmanager
    async def fake_copy(path):
        yield path

    async def available():
        return ai_status.AiStatus(True)

    text = "Plain readable sentence about the topic. " * 20
    document = ExtractedDocument(pages=[ExtractedPage(number=1, text=text)], extension=".pdf", page_count=1)
    monkeypatch.setattr(validator, "local_copy", fake_copy)
    async def parse_document(*args, **kwargs):
        return document

    monkeypatch.setattr(validator, "parse_document", parse_document)
    monkeypatch.setattr(ai_status, "get_status", available)
    monkeypatch.setattr(validator.LLMFactory, "get_provider", classmethod(lambda cls: provider))
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "ENABLE_PROCESSING", True)
    await validator.validate_material("m1", "local://x/ok.pdf", "ok.pdf", category)
    return provider


class TestValidator:
    async def test_v1_still_sends_the_category(self, v1, monkeypatch):
        provider = await run_validator(monkeypatch)
        assert "Category the student chose: lecture notes" in provider.messages[0].content
        assert provider.schema is MaterialCheck

    async def test_v2_does_not_send_the_category(self, v2, monkeypatch):
        provider = await run_validator(monkeypatch, category="book_chapters")
        prompt = provider.messages[0].content
        assert "Category" not in prompt and "the student chose" not in prompt
        assert provider.schema is MaterialCheckV2

    async def test_v2_tags_the_text_of_the_file(self, v2, monkeypatch):
        prompt = (await run_validator(monkeypatch)).messages[0].content
        assert prompt.index("<start_of_text>") < prompt.index("Plain readable sentence") < prompt.index("</start_of_text>")

# ---------------------------------------------------------------- planner (3, 4, 5, 6, 11, 12, 13)


def last_user(messages: List[LLMMessage]) -> str:
    return messages[-1].content


class TestPlannerPrompt:
    def test_v1_system_and_outline_are_untouched(self, v1):
        messages = planner.plan_messages("Stats", [section(1)], exam_names=["midterm.pdf"])
        assert messages[0].content == planner.PLANNER_SYSTEM
        assert "Past exam files (not sections): midterm.pdf" in last_user(messages)
        assert "<outline>" not in last_user(messages) and "part " not in last_user(messages)

    def test_v2_tags_the_outline_and_exam_names_and_keeps_one_line_per_section(self, v2):
        user = last_user(planner.plan_messages("Stats", [section(1), section(2)], exam_names=["midterm.pdf"]))
        assert "<outline>" in user and "</outline>" in user
        assert "<past_exam_files>midterm.pdf</past_exam_files>" in user
        lines = [l for l in user.splitlines() if l.startswith("S") and " | " in l]
        assert [l.split(" | ")[0] for l in lines] == ["S1", "S2"]
        assert user.index("S2 |") < user.index("</outline>")

    def test_v2_ends_with_the_request_after_the_outline(self, v2):
        user = last_user(planner.plan_messages("Stats", [section(1)]))
        assert user.rstrip().endswith("Plan every section above into units and topics now.")
        assert user.index("</outline>") < user.index("Plan every section above")

    def test_v2_group_calls_say_they_see_part_of_the_course(self, v2):
        grouped = last_user(planner.plan_messages("Stats", [section(1)], part=(2, 3)))
        assert "This is part 2 of 3 of the course's files." in grouped
        assert "part 2 of 3" not in last_user(planner.plan_messages("Stats", [section(1)]))

    def test_v2_addition_mode_puts_the_existing_plan_in_the_user_message(self, v2):
        messages = planner.plan_messages("Stats", [section(1)], existing_context="Existing units:\nU1 | Intro")
        assert "Existing units:" in last_user(messages) and "Existing units:" not in messages[0].content

    def test_v1_addition_mode_is_untouched(self, v1):
        messages = planner.plan_messages("Stats", [section(1)], existing_context="Existing units:\nU1 | Intro")
        assert messages[0].content == planner.PLANNER_SYSTEM + planner.PLANNER_ADDITION_SYSTEM

    async def test_max_tokens_and_schema_follow_the_flag(self, monkeypatch):
        provider = Capture()

        async def fake_plan(messages, schema, **kwargs):
            provider.schema, provider.kwargs = schema, kwargs
            return schema.example()

        provider.generate_structured = fake_plan
        monkeypatch.setattr(planner.LLMFactory, "get_provider", classmethod(lambda cls: provider))
        monkeypatch.setattr(settings, "PROMPTS_V2", "")
        await planner._plan_call([])
        assert (provider.schema, provider.kwargs["max_tokens"]) == (CoursePlan, 16000)
        monkeypatch.setattr(settings, "PROMPTS_V2", "ingest")
        await planner._plan_call([])
        assert (provider.schema, provider.kwargs["max_tokens"]) == (CoursePlanV2, 32000)

    def test_v2_does_not_ask_the_model_for_study_minutes(self):
        # R5: the app computes the minutes from the sections' tokens.
        def topic_props(model):
            defs = model.model_json_schema()["$defs"]
            return defs["PlannedTopicV2" if model is CoursePlanV2 else "PlannedTopic"]["properties"]

        assert "estimated_minutes" in topic_props(CoursePlan) and "estimated_minutes" not in topic_props(CoursePlanV2)

# ---------------------------------------------------------------- extractor (3, 7, 8, 9, 16)


TOPIC = {"id": "t2", "project_id": "p", "name": "Conditional probability", "description": "P(A|B)"}
CHUNKS = [{"id": "c1", "chunk_text": "The sum of the values divided by n.", "filename": "a.pdf", "page_start": 1,
           "page_end": 1, "section_hierarchy": "Means"}]


def extraction_text(prior=None) -> List[LLMMessage]:
    return extractor.extraction_messages(TOPIC, CHUNKS, "Course map (topics):\n- A  <- THIS TOPIC", ["compute a mean"], prior or {})


class TestExtractorPrompt:
    def test_v1_is_untouched(self, v1):
        messages = extraction_text()
        assert "<topic>" not in messages[1].content and "<course_map>" not in messages[1].content
        assert messages[2].content.endswith(extractor.EXTRACTION_INSTRUCTIONS)

    def test_v2_tags_topic_and_course_map_in_the_excerpt_message(self, v2):
        messages = extraction_text()
        body = messages[1].content
        assert "<topic>\nTopic: Conditional probability" in body and "</topic>" in body
        assert "<course_map>\nCourse map (topics):" in body and "</course_map>" in body
        assert '<source_excerpts>' in body and '<excerpt chunk_id="c1"' in body
        assert messages[0].role == "system" and "<source_excerpts>" not in messages[0].content
        assert '<objective index="0">compute a mean</objective>' in messages[2].content

class TestCourseMap:
    async def build(self, monkeypatch, **kwargs) -> str:
        topics = [{"id": "t1", "name": "Permutations", "unit_id": None}, {"id": "t2", "name": "Conditional", "unit_id": None}]

        async def fake_query(sql, *args):
            return topics if "FROM topics" in sql else []

        monkeypatch.setattr(topic_context, "execute_query", fake_query)
        topic = {"id": "t2", "project_id": "p", "objectives": ["compute P(A|B)"], "prerequisite_ids": ["t1"]}
        return await topic_context.build_course_map(topic, **kwargs)

    async def test_generators_still_get_objectives_and_prerequisites(self, monkeypatch):
        course_map = await self.build(monkeypatch)
        assert "- compute P(A|B)" in course_map and course_map.rstrip().endswith("Permutations")

    async def test_order_only_keeps_the_course_order_and_marker(self, monkeypatch):
        course_map = await self.build(monkeypatch, order_only=True)
        assert "- Conditional  <- THIS TOPIC" in course_map and "- Permutations" in course_map
        assert "compute P(A|B)" not in course_map and "Prerequisites" not in course_map


# ---------------------------------------------------------------- linker (9, 10)


class TestLinkerPrompt:
    def pairs(self) -> List[LLMMessage]:
        concepts = {"a": {"topic_id": "t1", "name": "Mean", "summary": "s"}, "b": {"topic_id": "t2", "name": "Median", "summary": "s"}}
        return linker.link_messages(concepts, {"t1": "One", "t2": "Two"}, {}, [("a", "b")])

    def test_v1_is_untouched(self, v1):
        assert self.pairs()[2].content.endswith(linker.LINK_INSTRUCTIONS)

    def test_v2_tags_the_candidate_pairs(self, v2):
        message = self.pairs()[2].content
        assert "<candidate_pairs>" in message and '<pair a="a" b="b"/>' in message

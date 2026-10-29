"""The course planner: outline, plan validation, the large-outline path, and a run against the
database with the mock provider."""
import json
from types import SimpleNamespace
from typing import Dict, List, Optional

import pytest
from fastapi import HTTPException

from app.api.routes import jobs
from app.config import settings
from app.models.jobs import JobPayload
from app.services import course_planner as planner
from app.services.course_planner import Section, build_outline, validate_plan
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import CoursePlan, PlannedTopic, PlannedUnit, SectionAddition
from tests.db_helpers import new_id, seed_job, seed_material, seed_project, seed_topic, seed_user


# ---------------------------------------------------------------- synthetic outlines


def chunk(material: str, index: int, heading: Optional[str], tokens: int = 400, page: Optional[int] = None,
          text: Optional[str] = None, filename: Optional[str] = None) -> Dict:
    return {
        "id": f"{material}-c{index}",
        "material_id": material,
        "filename": filename or f"{material}.pdf",
        "chunk_index": index,
        "section_hierarchy": heading,
        "page_start": page if page is not None else index + 1,
        "page_end": page if page is not None else index + 1,
        "token_count": tokens,
        "chunk_text": text or f"Body text of chunk {index} in {material}. It explains an idea.",
    }


def section(sid: str, material: str, position: int, chunk_start: int, tokens: int = 2000, heading: str = "H") -> Section:
    return Section(
        id=sid, material_id=material, filename=f"{material}.pdf", chunk_start=chunk_start,
        chunk_end=chunk_start + 2, page_start=chunk_start + 1, page_end=chunk_start + 3, tokens=tokens,
        heading=heading, snippet="snippet", chunk_ids=[f"{material}-c{chunk_start + i}" for i in range(3)],
        position=position,
    )


def outline(spec: Dict[str, int]) -> List[Section]:
    """`{file: sections}` as sections S1..Sn, three chunks each, in file order."""
    sections: List[Section] = []
    for material, count in spec.items():
        for n in range(count):
            sections.append(section(f"S{len(sections) + 1}", material, len(sections), n * 3))
    return sections


def topic(key: str, ids: List[str], name: Optional[str] = None, prerequisites: Optional[List[str]] = None, **kw) -> PlannedTopic:
    return PlannedTopic(
        key=key, name=name or f"Topic {key}", description=f"About {key}.",
        objectives=kw.get("objectives", ["do one thing", "do another", "do a third"]),
        keywords=kw.get("keywords", ["k1", "k2", "k3"]), section_ids=ids,
        prerequisite_keys=prerequisites or [], estimated_minutes=kw.get("minutes", 30),
    )


def plan_of(*units: List[PlannedTopic], titles: Optional[List[str]] = None) -> CoursePlan:
    return CoursePlan(units=[
        PlannedUnit(title=(titles or [])[i] if titles and i < len(titles) else f"Unit {i + 1}", summary="s", topics=list(topics))
        for i, topics in enumerate(units)
    ])


def placed(valid) -> Dict[str, str]:
    return {sid: t.key for t in valid.topics() for sid in t.section_ids}


# ---------------------------------------------------------------- outline


class TestOutline:
    def test_chunks_with_the_same_top_two_levels_form_one_section(self):
        chunks = [
            chunk("m1", 0, "Lecture 1 > Probability > Axioms"),
            chunk("m1", 1, "Lecture 1 > Probability > Events"),
            chunk("m1", 2, "Lecture 1 > Counting"),
            chunk("m1", 3, "Lecture 1 > Counting > Permutations"),
            chunk("m1", 4, "Lecture 2"),
        ]
        sections = build_outline(chunks)
        assert [(s.id, s.heading, s.chunk_start, s.chunk_end) for s in sections] == [
            ("S1", "Lecture 1 > Probability", 0, 1),
            ("S2", "Lecture 1 > Counting", 2, 3),
            ("S3", "Lecture 2", 4, 4),
        ]
        assert sections[0].page_start == 1 and sections[0].page_end == 2
        assert sections[0].tokens == 800
        assert sections[0].chunk_ids == ["m1-c0", "m1-c1"]

    def test_a_file_without_headings_is_cut_every_1500_tokens_and_labelled_by_its_first_line(self):
        chunks = [chunk("m1", i, None, tokens=400, text=f"# Slide {i}\nBody {i}") for i in range(10)]
        sections = build_outline(chunks)
        assert [s.tokens for s in sections] == [1200, 1200, 1200, 400]  # 400 x3 fits, a 4th would pass 1500
        assert sections[0].heading == "Slide 0"
        assert sections[1].heading == "Slide 3"
        assert [s.chunk_start for s in sections] == [0, 3, 6, 9]

    def test_sections_are_numbered_across_files_in_upload_order_then_document_order(self):
        chunks = [chunk("a", 0, "A1"), chunk("a", 1, "A2"), chunk("b", 0, "B1"), chunk("b", 1, "B1"), chunk("b", 2, "B2")]
        assert [(s.id, s.material_id, s.heading, s.position) for s in build_outline(chunks)] == [
            ("S1", "a", "A1", 0), ("S2", "a", "A2", 1), ("S3", "b", "B1", 2), ("S4", "b", "B2", 3),
        ]

    def test_a_section_never_runs_across_two_files(self):
        sections = build_outline([chunk("a", 0, "Intro"), chunk("b", 0, "Intro")])
        assert [s.material_id for s in sections] == ["a", "b"]

    def test_a_huge_section_is_cut_into_parts(self):
        chunks = [chunk("m1", i, "Chapter 1 > Everything", tokens=1000) for i in range(30)]  # 30,000 tokens
        sections = build_outline(chunks)
        assert len(sections) > 3
        assert all(s.tokens <= 5000 for s in sections)
        assert sections[0].heading == "Chapter 1 > Everything (part 1)"
        assert sum(s.tokens for s in sections) == 30000

    def test_the_outline_lists_id_file_pages_tokens_heading_and_the_start_of_the_text(self):
        text = planner.format_outline(build_outline([
            chunk("m1", 0, "Intro", text="# Intro\n" + "word " * 200, page=4, filename="lecture.pdf"),
        ]))
        line, = text.splitlines()
        assert line.startswith('S1 | lecture.pdf | p. 4, 400 tokens | Intro | "word word')
        assert len(line.split('"')[1]) == planner.SNIPPET_CHARS - 1 or len(line.split('"')[1]) <= planner.SNIPPET_CHARS


# ---------------------------------------------------------------- validation


class TestValidation:
    def test_every_section_is_assigned_exactly_once(self):
        sections = outline({"a": 4, "b": 2})
        plan = plan_of(
            [topic("t1", ["S1", "S2"]), topic("t2", ["S3", "S4"])],
            [topic("t3", ["S5", "S6"])],
        )
        valid = validate_plan(plan, sections)
        assert placed(valid) == {"S1": "t1", "S2": "t1", "S3": "t2", "S4": "t2", "S5": "t3", "S6": "t3"}
        assert valid.stats["unassigned"] == 0 and valid.stats["unknown_ids"] == 0

    def test_unknown_section_ids_are_dropped(self):
        sections = outline({"a": 2})
        valid = validate_plan(plan_of([topic("t1", ["S1", "S99", "nope"]), topic("t2", ["S2"])]), sections)
        assert placed(valid) == {"S1": "t1", "S2": "t2"}
        assert valid.stats["unknown_ids"] == 2

    def test_a_section_named_twice_stays_with_the_first_topic(self):
        sections = outline({"a": 3})
        valid = validate_plan(plan_of([topic("t1", ["S1", "S2"]), topic("t2", ["S2", "S3"])]), sections)
        assert placed(valid) == {"S1": "t1", "S2": "t1", "S3": "t2"}
        assert valid.stats["duplicate_ids"] == 1

    def test_the_same_section_twice_in_one_topic_counts_once(self):
        valid = validate_plan(plan_of([topic("t1", ["S1", "S1", "S2"])]), outline({"a": 2}))
        assert valid.topics()[0].section_ids == ["S1", "S2"]

    def test_an_unassigned_section_goes_to_the_topic_of_the_previous_section(self):
        sections = outline({"a": 4})
        valid = validate_plan(plan_of([topic("t1", ["S1"]), topic("t2", ["S2", "S4"])]), sections)  # S3 missing
        assert placed(valid)["S3"] == "t2"  # S2 is previous
        assert valid.topics()[1].section_ids == ["S2", "S3", "S4"]
        assert valid.stats["adjacency"] == 1

    def test_an_unassigned_first_section_goes_to_the_next_ones_topic(self):
        sections = outline({"a": 3})
        valid = validate_plan(plan_of([topic("t1", ["S2", "S3"])], [topic("t2", ["S3"])]), sections)
        assert placed(valid)["S1"] == "t1"

    def test_adjacency_stays_inside_the_file(self):
        sections = outline({"a": 2, "b": 2})  # S1 S2 | S3 S4
        # S3 is missing: its previous section S2 is in another file, so the next one (S4) decides.
        valid = validate_plan(plan_of([topic("t1", ["S1", "S2"]), topic("t2", ["S4"])]), sections)
        assert placed(valid)["S3"] == "t2"

    def test_consecutive_unassigned_sections_cascade_to_the_same_owner(self):
        sections = outline({"a": 5})
        valid = validate_plan(plan_of([topic("t1", ["S1"]), topic("t2", ["S2"])]), sections)
        assert [t.section_ids for t in valid.topics()] == [["S1"], ["S2", "S3", "S4", "S5"]]

    def test_a_file_the_plan_forgot_becomes_a_topic_of_its_own_in_a_last_unit(self):
        sections = outline({"a": 2, "c": 2})  # nothing in file c is named
        sections[2].heading = "Lecture 9 > Graphs"
        valid = validate_plan(plan_of([topic("t1", ["S1", "S2"]), topic("t2", ["S1"])]), sections)
        last = valid.units[-1]
        assert last.title == "Other material"
        assert last.topics[0].fallback and last.topics[0].section_ids == ["S3", "S4"]
        assert last.topics[0].name == "Lecture 9 > Graphs"
        assert valid.stats["fallback_topics"] == 1
        assert set(placed(valid)) == {"S1", "S2", "S3", "S4"}

    def test_a_plan_with_one_topic_gives_it_every_section(self):
        valid = validate_plan(plan_of([topic("only", [])]), outline({"a": 3, "b": 2}))
        assert valid.topics()[0].section_ids == ["S1", "S2", "S3", "S4", "S5"]

    def test_topics_with_no_section_are_dropped_and_so_are_empty_units(self):
        sections = outline({"a": 2})
        valid = validate_plan(plan_of([topic("t1", ["S1", "S2"]), topic("empty", ["S77"])], [topic("ghost", [])]), sections)
        assert [t.key for t in valid.topics()] == ["t1"]
        assert len(valid.units) == 1
        assert valid.stats["dropped_topics"] == 2 and valid.stats["dropped_units"] == 1

    def test_sections_of_a_topic_are_in_document_order(self):
        valid = validate_plan(plan_of([topic("t1", ["S3", "S1", "S2"])]), outline({"a": 3}))
        assert valid.topics()[0].section_ids == ["S1", "S2", "S3"]

    def test_prerequisites_must_point_backwards_and_exist(self):
        sections = outline({"a": 4})
        plan = plan_of(
            [topic("t1", ["S1"], prerequisites=["t2", "t1", "zzz"]), topic("t2", ["S2"], prerequisites=["t1"])],
            [topic("t3", ["S3", "S4"], prerequisites=["t1", "t2", "t1"])],
        )
        valid = validate_plan(plan, sections)
        assert [t.prerequisite_keys for t in valid.topics()] == [[], ["t1"], ["t1", "t2"]]
        assert valid.stats["dropped_prerequisites"] >= 4

    def test_duplicate_or_missing_keys_are_made_unique_and_prerequisites_follow_the_first(self):
        sections = outline({"a": 3})
        plan = plan_of([topic("x", ["S1"]), topic("x", ["S2"], prerequisites=["x"]), topic("", ["S3"], prerequisites=["x"])])
        valid = validate_plan(plan, sections)
        keys = [t.key for t in valid.topics()]
        assert len(set(keys)) == 3 and all(keys)
        assert valid.topics()[1].prerequisite_keys == [keys[0]]
        assert valid.topics()[2].prerequisite_keys == [keys[0]]

    def test_text_fields_are_cleaned_and_filled_in(self):
        sections = outline({"a": 2})
        plan = plan_of([PlannedTopic(
            key="t1", name="  Bayes   rule \n", description="", section_ids=["S1", "S2"],
            objectives=["You can compute a posterior", "by the end you can name the terms", "  ", "compute a posterior"],
            keywords=["Bayes", "bayes", "", "posterior"], prerequisite_keys=[], estimated_minutes=0,
        )])
        t = validate_plan(plan, sections).topics()[0]
        assert t.name == "Bayes rule"
        assert t.description == "Core ideas of Bayes rule."
        assert t.objectives == ["compute a posterior", "name the terms"]
        assert t.keywords == ["Bayes", "posterior"]
        assert t.estimated_minutes == planner.default_minutes(4000) == 35

    def test_minutes_are_clamped(self):
        valid = validate_plan(plan_of([topic("a", ["S1"], minutes=1000), topic("b", ["S2"], minutes=2)]), outline({"a": 2}))
        assert [t.estimated_minutes for t in valid.topics()] == [120, 5]

    def test_a_topic_without_a_name_is_named_after_its_first_section(self):
        sections = [section("S1", "a", 0, 0, heading="Lecture 3 > Hashing")]
        nameless = topic("t1", ["S1"])
        nameless.name = ""
        t = validate_plan(plan_of([nameless]), sections).topics()[0]
        assert t.name == "Lecture 3 > Hashing"

    def test_an_empty_plan_still_places_every_section(self):
        valid = validate_plan(CoursePlan(units=[]), outline({"a": 2, "b": 1}))
        assert sorted(placed(valid)) == ["S1", "S2", "S3"]
        assert [t.section_ids for t in valid.topics()] == [["S1", "S2"], ["S3"]]  # one topic per file

    def test_existing_topics_can_take_new_sections_and_be_named_as_prerequisites(self):
        sections = outline({"new": 3})
        plan = CoursePlan(
            units=[PlannedUnit(title="More", summary="s", topics=[topic("n1", ["S2", "S3"], prerequisites=["E1", "E9"])])],
            additions=[SectionAddition(topic_key="E1", section_ids=["S1", "S2"]), SectionAddition(topic_key="E7", section_ids=["S3"])],
        )
        valid = validate_plan(plan, sections, existing_topic_keys=["E1", "E2"], existing_unit_keys=["U1"])
        assert valid.additions == {"E1": ["S1"]}  # S2 was already taken by the new topic, E7 is unknown
        assert valid.topics()[0].section_ids == ["S2", "S3"]
        assert valid.topics()[0].prerequisite_keys == ["E1"]

    def test_an_unassigned_new_section_follows_its_neighbour_into_an_existing_topic(self):
        sections = outline({"new": 3})
        plan = CoursePlan(units=[], additions=[SectionAddition(topic_key="E2", section_ids=["S1", "S3"])])
        valid = validate_plan(plan, sections, existing_topic_keys=["E1", "E2"])
        assert valid.additions == {"E2": ["S1", "S2", "S3"]}

    def test_a_unit_can_join_an_existing_one_only_when_that_key_exists(self):
        plan = CoursePlan(units=[
            PlannedUnit(title="a", summary="", existing_unit_key="U1", topics=[topic("t1", ["S1"])]),
            PlannedUnit(title="b", summary="", existing_unit_key="U9", topics=[topic("t2", ["S2"])]),
        ])
        valid = validate_plan(plan, outline({"a": 2}), existing_unit_keys=["U1"])
        assert [u.existing_unit_key for u in valid.units] == ["U1", None]


# ---------------------------------------------------------------- the large-outline path


class FakeModel:
    """Answers each plan call with topics of two sections, and records every call."""

    def __init__(self, order: Optional[List[int]] = None):
        self.plan_calls: List[List[str]] = []
        self.order_calls = 0
        self.order = order

    async def plan(self, messages):
        text = messages[-1].content
        ids = [line.split(" | ")[0] for line in text.splitlines() if line.startswith("S") and " | " in line]
        self.plan_calls.append(ids)
        # Every group reuses the keys t1, t2...: the planner has to keep them apart.
        topics = [topic(f"t{n + 1}", ids[i : i + 2], prerequisites=[f"t{n}"] if n else []) for n, i in enumerate(range(0, len(ids), 2))]
        return plan_of(topics, titles=[f"Unit of {ids[0]}"])


@pytest.fixture
def fake_model(monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(planner, "_plan_call", model.plan)

    async def reorder(units, syllabus):
        model.order_calls += 1
        return list(reversed(units)) if model.order == "reverse" else units

    monkeypatch.setattr(planner, "order_units", reorder)
    return model


class TestLargeOutline:
    async def test_a_small_outline_is_one_call(self, fake_model):
        sections = outline({"a": 6})
        valid = await planner.plan_sections("C", sections)
        assert len(fake_model.plan_calls) == 1 and fake_model.order_calls == 0
        assert set(placed(valid)) == {s.id for s in sections}

    async def test_an_outline_over_the_token_limit_is_planned_per_group_then_ordered(self, fake_model, monkeypatch):
        sections = outline({"a": 6, "b": 6, "c": 6})
        one_file = planner.outline_tokens(sections[:6])
        monkeypatch.setattr(settings, "PLANNER_MAX_OUTLINE_TOKENS", one_file + 20)  # about one file a call
        fake_model.order = "reverse"

        valid = await planner.plan_sections("C", sections)

        assert len(fake_model.plan_calls) == 3
        assert [calls[0] for calls in fake_model.plan_calls] == ["S1", "S7", "S13"]
        assert fake_model.order_calls == 1
        # Every section placed once, topic keys unique across groups, units reversed by the order pass.
        assert sorted(placed(valid), key=lambda s: int(s[1:])) == [s.id for s in sections]
        keys = [t.key for t in valid.topics()]
        assert len(keys) == len(set(keys)) == 9
        assert [u.title for u in valid.units] == ["Unit of S13", "Unit of S7", "Unit of S1"]

    async def test_after_the_cross_file_order_a_prerequisite_never_points_forward(self, fake_model, monkeypatch):
        sections = outline({"a": 4, "b": 4})
        monkeypatch.setattr(settings, "PLANNER_MAX_SECTIONS_PER_CALL", 4)
        fake_model.order = "reverse"
        valid = await planner.plan_sections("C", sections)
        position = {t.key: i for i, t in enumerate(valid.topics())}
        for t in valid.topics():
            assert all(position[key] < position[t.key] for key in t.prerequisite_keys)

    async def test_a_lot_of_source_text_also_triggers_grouping(self, fake_model, monkeypatch):
        monkeypatch.setattr(settings, "PLANNER_MAX_SOURCE_TOKENS_PER_CALL", 13000)  # sections are 2,000 tokens
        await planner.plan_sections("C", outline({"a": 6, "b": 6}))
        assert len(fake_model.plan_calls) == 2

    def test_groups_respect_the_source_limit(self):
        sections = outline({"a": 5, "b": 5})
        groups = planner.group_sections(sections, 10**9, 10**9, max_source_tokens=7000)
        assert all(sum(s.tokens for s in g) <= 7000 for g in groups) and len(groups) == 4

    async def test_too_many_sections_also_triggers_grouping(self, fake_model, monkeypatch):
        monkeypatch.setattr(settings, "PLANNER_MAX_SECTIONS_PER_CALL", 5)
        await planner.plan_sections("C", outline({"a": 4, "b": 4}))
        assert len(fake_model.plan_calls) == 2

    def test_a_file_bigger_than_a_group_is_cut_between_sections(self):
        sections = outline({"a": 12})
        groups = planner.group_sections(sections, max_tokens=10**9, max_sections=5)
        assert [len(g) for g in groups] == [5, 5, 2]
        assert [s.id for g in groups for s in g] == [s.id for s in sections]

    def test_whole_files_are_kept_together_when_they_fit(self):
        sections = outline({"a": 3, "b": 3, "c": 3})
        groups = planner.group_sections(sections, max_tokens=10**9, max_sections=6)
        assert [[s.material_id for s in g] for g in groups] == [["a"] * 3 + ["b"] * 3, ["c"] * 3]

    async def test_a_cut_off_answer_for_a_group_is_not_swallowed(self, monkeypatch):
        async def boom(messages):
            raise RuntimeError("model down")

        monkeypatch.setattr(planner, "_plan_call", boom)
        with pytest.raises(RuntimeError):
            await planner.plan_sections("C", outline({"a": 2}))


# ---------------------------------------------------------------- against the database, with the mock model


@pytest.fixture
def mock_llm(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    LLMFactory.reset()
    yield
    LLMFactory.reset()


async def add_file(db, project_id: str, filename: str, sections: List[tuple], role: str = "content",
                   status: str = "valid", uploaded: str = "") -> str:
    """A material with one chunk per (heading, text) pair; page = chunk number + 1."""
    material_id = await seed_material(db, project_id, filename=filename, status=status, role=role, uploaded_at=uploaded)
    for index, (heading, text) in enumerate(sections):
        await db.execute(
            "INSERT INTO material_chunks (id, material_id, chunk_text, section_hierarchy, page_start, page_end, "
            "chunk_index, token_count) VALUES ($1, $2, $3, $4, $5, $5, $6, 300)",
            new_id(), material_id, text, heading, index + 1, index,
        )
    return material_id


def lecture(topic_name: str, count: int = 3) -> List[tuple]:
    return [(f"{topic_name} > Part {n}", f"{topic_name} part {n} explains a definition and an example.") for n in range(count)]


@pytest.fixture
async def course(db, mock_llm):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    return SimpleNamespace(db=db, user_id=user_id, project_id=project_id)


async def run_extract(course) -> Dict:
    job_id = await seed_job(
        course.db, course.user_id, "extract_topics", project_id=course.project_id,
        input_data={"projectId": course.project_id},
    )
    return await jobs.extract_topics_job(
        JobPayload(jobId=job_id, jobType="extract_topics", data={"projectId": course.project_id})
    )


async def topics_of(db, project_id: str):
    return await db.fetch(
        "SELECT * FROM topics WHERE project_id = $1 ORDER BY order_index", project_id
    )


class TestPlanningRun:
    async def test_plans_units_topics_sources_and_mappings_in_one_go(self, course):
        db = course.db
        a = await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3) + lecture("Probability", 3))
        b = await add_file(db, course.project_id, "week2.pdf", lecture("Bayes", 3))

        result = await run_extract(course)

        topics = await topics_of(db, course.project_id)
        units = await db.fetch("SELECT * FROM units WHERE project_id = $1 ORDER BY order_index", course.project_id)
        assert result["topicsCount"] == len(topics) >= 3
        assert [u["order_index"] for u in units] == list(range(len(units)))
        assert len(units) == 2  # one unit per file with the mock model
        assert all(not t["user_confirmed"] and t["unit_id"] for t in topics)
        assert [t["order_index"] for t in topics] == list(range(len(topics)))
        assert all(len(t["objectives"]) == 3 and t["estimated_minutes"] for t in topics)
        assert await db.fetchval("SELECT status FROM projects WHERE id = $1", course.project_id) == "topics_pending"

        # Every chunk of both files is a source of exactly one topic.
        sources = await db.fetch("SELECT * FROM topic_sources ORDER BY chunk_index_start")
        covered = sorted((s["material_id"], i) for s in sources for i in range(s["chunk_index_start"], s["chunk_index_end"] + 1))
        assert covered == sorted([(a, i) for i in range(6)] + [(b, i) for i in range(3)])
        assert all(s["role"] == "primary" for s in sources)
        # The topic's file list and the mappings follow the sources; prerequisites are earlier topics.
        first = topics[0]
        assert first["source_material_ids"] == [a]
        assert await db.fetchval("SELECT count(*) FROM topic_chunk_mappings WHERE topic_id = $1", first["id"]) >= 1
        order = {t["id"]: t["order_index"] for t in topics}
        for t in topics:
            assert all(order[p] < t["order_index"] for p in t["prerequisite_ids"])
        assert any(t["prerequisite_ids"] for t in topics)
        job = await db.fetchrow("SELECT result_data FROM processing_jobs WHERE job_type = 'extract_topics'")
        assert json.loads(job["result_data"])["mode"] == "full"

    async def test_syllabus_and_exam_files_are_not_sources(self, course):
        db = course.db
        content = await add_file(db, course.project_id, "notes.pdf", lecture("Hashing", 3))
        syllabus = await add_file(db, course.project_id, "syllabus.pdf", [("Schedule", "Week 1 hashing. Week 2 trees.")], role="syllabus")
        exam = await add_file(db, course.project_id, "midterm.pdf", [("Q1", "Question one about hashing.")], role="exam")

        await run_extract(course)

        material_ids = {r["material_id"] for r in await db.fetch("SELECT material_id FROM topic_sources")}
        assert material_ids == {content}
        assert syllabus not in material_ids and exam not in material_ids

    async def test_the_syllabus_text_and_exam_names_reach_the_planner(self, course, monkeypatch):
        seen = []
        real = planner._plan_call

        async def spy(messages):
            seen.append(messages[-1].content)
            return await real(messages)

        monkeypatch.setattr(planner, "_plan_call", spy)
        db = course.db
        await add_file(db, course.project_id, "notes.pdf", lecture("Hashing", 2))
        await add_file(db, course.project_id, "syllabus.pdf", [("Schedule", "Class 11: Hash tables and open addressing.")], role="syllabus")
        await add_file(db, course.project_id, "midterm-2019.pdf", [("Q1", "Question one.")], role="exam")

        await run_extract(course)

        prompt, = seen
        assert "Class 11: Hash tables and open addressing." in prompt
        assert "midterm-2019.pdf" in prompt
        assert "S1 | notes.pdf" in prompt and "S1 | syllabus.pdf" not in prompt

    async def test_a_course_with_no_content_file_fails_permanently_with_a_clear_message(self, course):
        await add_file(course.db, course.project_id, "midterm.pdf", lecture("Q", 2), role="exam")

        with pytest.raises(HTTPException) as raised:
            await run_extract(course)
        assert raised.value.status_code == 400  # permanent: the dispatcher does not retry it
        row = await course.db.fetchrow("SELECT error_code, retryable, error_message FROM processing_jobs WHERE job_type = 'extract_topics'")
        assert row["error_code"] == "NO_CONTENT_MATERIALS" and row["retryable"] is False
        assert "course content" in row["error_message"]

    async def test_find_again_before_confirming_replaces_unconfirmed_topics_and_keeps_same_named_ones(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        before = {t["name"]: t["id"] for t in await topics_of(db, course.project_id)}
        stale = await seed_topic(db, course.project_id, "Left over from an old run")

        await run_extract(course)

        after = {t["name"]: t["id"] for t in await topics_of(db, course.project_id)}
        assert after == before  # same names keep their rows (and their content); the stale one went
        assert stale not in after.values()
        assert await db.fetchval("SELECT count(*) FROM units WHERE project_id = $1", course.project_id) == 1
        assert await db.fetchval("SELECT count(*) FROM topic_sources") == 3  # replaced, not doubled

    async def test_confirmed_topics_survive_find_again_untouched(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE project_id = $1", course.project_id)
        await db.execute("UPDATE topics SET name = 'My own name', description = 'mine' WHERE id = (SELECT id FROM topics LIMIT 1)")
        before = [dict(t) for t in await topics_of(db, course.project_id)]
        sources_before = await db.fetchval("SELECT count(*) FROM topic_sources")

        result = await run_extract(course)

        after = [dict(t) for t in await topics_of(db, course.project_id)]
        assert after == before  # nothing new to place: not renamed, not moved, not deleted
        assert await db.fetchval("SELECT count(*) FROM topic_sources") == sources_before
        assert result["topicsCount"] == len(before)

    async def test_new_material_after_confirmation_adds_topics_and_leaves_confirmed_ones_alone(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE project_id = $1", course.project_id)
        await db.execute("UPDATE projects SET status = 'active' WHERE id = $1", course.project_id)
        confirmed = [dict(t) for t in await topics_of(db, course.project_id)]
        unit_ids = {t["unit_id"] for t in confirmed}

        new_file = await add_file(db, course.project_id, "week2.pdf", lecture("Bayes", 3))
        await run_extract(course)

        topics = [dict(t) for t in await topics_of(db, course.project_id)]
        kept = [t for t in topics if t["id"] in {c["id"] for c in confirmed}]
        assert kept == confirmed  # same rows, same names, same order, same units
        new = [t for t in topics if t["id"] not in {c["id"] for c in confirmed}]
        assert new and all(not t["user_confirmed"] for t in new)
        assert min(t["order_index"] for t in new) > max(c["order_index"] for c in confirmed)
        assert {t["unit_id"] for t in new}.isdisjoint(unit_ids)  # new units after the existing ones
        new_sources = await db.fetch("SELECT DISTINCT material_id FROM topic_sources WHERE topic_id = ANY($1::text[])", [t["id"] for t in new])
        assert [r["material_id"] for r in new_sources] == [new_file]
        # The confirmed topics gained nothing, and the active course stays active (the new topics wait for review).
        assert await db.fetchval("SELECT count(*) FROM topic_sources WHERE topic_id = ANY($1::text[])", [c["id"] for c in confirmed]) == 3
        assert await db.fetchval("SELECT status FROM projects WHERE id = $1", course.project_id) == "active"
        job = await db.fetchrow("SELECT result_data FROM processing_jobs ORDER BY created_at DESC LIMIT 1")
        assert json.loads(job["result_data"])["mode"] == "incremental"

    async def test_a_course_planned_before_sources_existed_only_plans_files_uploaded_since(self, course):
        db = course.db
        await add_file(db, course.project_id, "old.pdf", lecture("Old", 3), uploaded="SQL:(NOW() AT TIME ZONE 'UTC') - interval '2 days'")
        legacy = await seed_topic(db, course.project_id, "Old topic")
        await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE id = $1", legacy)
        await add_file(db, course.project_id, "new.pdf", lecture("New", 3))

        await run_extract(course)

        topics = await topics_of(db, course.project_id)
        assert topics[0]["id"] == legacy and topics[0]["user_confirmed"]  # untouched, still first
        assert len(topics) >= 2
        files = {r["filename"] for r in await db.fetch(
            "SELECT m.filename FROM topic_sources ts JOIN materials m ON m.id = ts.material_id")}
        assert files == {"new.pdf"}  # the old file was not planned a second time

    async def test_a_hand_added_confirmed_topic_does_not_stop_the_first_plan(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        mine = await seed_topic(db, course.project_id, "Added by hand")
        await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE id = $1", mine)

        await run_extract(course)

        topics = await topics_of(db, course.project_id)
        assert mine in {t["id"] for t in topics}
        assert len(topics) >= 2  # the planned topics are back (the project has sources, so it is not legacy)
        assert await db.fetchval("SELECT count(*) FROM topic_sources WHERE topic_id = $1", mine) == 0

    async def test_deleting_a_file_removes_its_sources_and_a_unit_can_empty_out(self, course):
        db = course.db
        material = await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        assert await db.fetchval("SELECT count(*) FROM topic_sources") > 0

        await db.execute("DELETE FROM materials WHERE id = $1", material)

        assert await db.fetchval("SELECT count(*) FROM topic_sources") == 0
        assert await db.fetchval("SELECT count(*) FROM topics WHERE project_id = $1", course.project_id) > 0

    async def test_deleting_a_unit_keeps_its_topics_without_a_unit(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)

        await db.execute("DELETE FROM units WHERE project_id = $1", course.project_id)

        topics = await topics_of(db, course.project_id)
        assert topics and all(t["unit_id"] is None for t in topics)


class TestActiveCourse:
    """A course the student already confirmed stays active; the planner never drops studied topics."""

    @pytest.mark.parametrize("status", ["active", "completed"])
    async def test_find_again_keeps_the_status_of_a_confirmed_course(self, course, status):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE project_id = $1", course.project_id)
        await db.execute("UPDATE projects SET status = $2 WHERE id = $1", course.project_id, status)
        before = await db.fetchval("SELECT count(*) FROM topics WHERE project_id = $1", course.project_id)
        await add_file(db, course.project_id, "week2.pdf", lecture("Bayes", 3))

        await run_extract(course)

        assert await db.fetchval("SELECT status FROM projects WHERE id = $1", course.project_id) == status
        # New topics really were created (and wait for review), so the status check means something.
        assert await db.fetchval("SELECT count(*) FROM topics WHERE project_id = $1", course.project_id) > before
        assert await db.fetchval(
            "SELECT count(*) FROM topics WHERE project_id = $1 AND NOT user_confirmed", course.project_id) > 0

    async def test_a_full_replan_of_an_active_course_with_no_topics_left_keeps_the_status(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await db.execute("UPDATE projects SET status = 'active' WHERE id = $1", course.project_id)

        await run_extract(course)

        assert await db.fetchval("SELECT count(*) FROM topics WHERE project_id = $1", course.project_id) >= 1
        assert await db.fetchval("SELECT status FROM projects WHERE id = $1", course.project_id) == "active"

    async def test_a_setup_course_still_goes_to_review(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        assert await db.fetchval("SELECT status FROM projects WHERE id = $1", course.project_id) == "topics_pending"

    async def test_an_unconfirmed_topic_with_study_activity_is_not_deleted_by_find_again(self, course):
        db = course.db
        studied = await seed_topic(db, course.project_id, "Studied before it was confirmed")
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))  # uploaded after it: not covered
        await db.execute(
            "INSERT INTO topic_content (id, topic_id, content_type, content_data, updated_at) "
            "VALUES (gen_random_uuid()::text, $1, 'section_notes', '[]'::jsonb, NOW())", studied)
        loose = await seed_topic(db, course.project_id, "Never opened")

        await run_extract(course)

        ids = {t["id"] for t in await topics_of(db, course.project_id)}
        assert studied in ids  # kept with its content
        assert loose not in ids  # an unopened unconfirmed topic is still replaced
        assert await db.fetchval("SELECT count(*) FROM topic_content WHERE topic_id = $1", studied) == 1
        # Nothing was confirmed, so the kept topic is the only anchor: untouched, and the plan is incremental
        # (new topics come after it).
        kept = await db.fetchrow("SELECT name, user_confirmed, order_index FROM topics WHERE id = $1", studied)
        assert kept["name"] == "Studied before it was confirmed" and not kept["user_confirmed"]
        new = [t for t in await topics_of(db, course.project_id) if t["id"] != studied]
        assert new and all(t["order_index"] > kept["order_index"] for t in new)
        job = await db.fetchrow("SELECT result_data FROM processing_jobs ORDER BY created_at DESC LIMIT 1")
        assert json.loads(job["result_data"])["mode"] == "incremental"

    async def test_confirming_while_topics_are_being_found_does_not_duplicate_sections(self, course, monkeypatch):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        await run_extract(course)
        await add_file(db, course.project_id, "week2.pdf", lecture("Bayes", 3))

        real_plan = jobs.plan_course
        calls = {"n": 0}

        async def plan_then_confirm(project_id):
            plan = await real_plan(project_id)
            calls["n"] += 1
            if calls["n"] == 1:  # the student presses Confirm while the model is working
                await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE project_id = $1", project_id)
                await db.execute("UPDATE projects SET status = 'active' WHERE id = $1", project_id)
            return plan

        monkeypatch.setattr(jobs, "plan_course", plan_then_confirm)
        await run_extract(course)

        assert calls["n"] == 2  # planned again from the confirmed set
        topics = [dict(t) for t in await topics_of(db, course.project_id)]
        week1 = await db.fetchval("SELECT id FROM materials WHERE filename = 'week1.pdf'")
        covering = await db.fetch(
            "SELECT DISTINCT ts.topic_id FROM topic_sources ts WHERE ts.material_id = $1", week1)
        assert len(covering) == len([t for t in topics if t["user_confirmed"]])  # one topic set covers week1, no copies
        covered = [(s["chunk_index_start"], s["chunk_index_end"]) for s in await db.fetch(
            "SELECT chunk_index_start, chunk_index_end FROM topic_sources WHERE material_id = $1", week1)]
        assert len(covered) == len(set(covered))
        assert any(not t["user_confirmed"] for t in topics)  # week2's topics are new, waiting for review
        assert await db.fetchval("SELECT status FROM projects WHERE id = $1", course.project_id) == "active"

    async def test_write_plan_refuses_a_plan_made_before_the_confirmed_set_changed(self, course):
        db = course.db
        await add_file(db, course.project_id, "week1.pdf", lecture("Counting", 3))
        job = await planner.plan_course(course.project_id)
        mine = await seed_topic(db, course.project_id, "Confirmed meanwhile")
        await db.execute("UPDATE topics SET user_confirmed = TRUE WHERE id = $1", mine)

        with pytest.raises(planner.StalePlanError):
            await planner.write_plan(job)

        assert [t["id"] for t in await topics_of(db, course.project_id)] == [mine]

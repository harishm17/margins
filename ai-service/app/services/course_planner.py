"""The course planner: turns a project's files into units, topics and the sections each topic is
taught from.

1. Outline (no model). For every course-content file, consecutive chunks that share the first two
   levels of `section_hierarchy` form a section; a file with no headings is cut into sections of
   about SECTION_TOKENS tokens. Sections are numbered S1..Sn in upload order, then document order.
2. Plan (one model call, purpose `extract_topics`). The model sees the outline, the syllabus text
   and the names of past exams and returns units of topics, each topic naming the sections it is
   taught from. An outline too big for one call is planned per group of files, and a cheap
   second call orders the units.
3. Validate (`validate_plan`, pure). Unknown section ids are dropped, a section named twice stays
   with its first topic, a section nobody named goes to the topic of the neighbouring section in
   the same file, topics left with no section are dropped.
4. Write (`write_plan`), in one transaction: units, topics (objectives, prerequisites resolved to
   ids, minutes) and one `topic_sources` row per section.

New files after the topics were confirmed are planned the same way with the existing units and
topics as fixed context and only the new sections to place (`plan_course` picks the mode). A
confirmed topic is never renamed, merged or deleted; it may only gain sections.
"""
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.config import settings
from app.db.connection import UTC_NOW, execute_in_transaction, execute_query
from app.services.document_processor.chunker import count_tokens
from app.services.embeddings.search import NON_CONTENT_ROLES
from app.services.embeddings.topic_mapping import replace_topic_mappings
from app.services.llm import LLMFactory
from app.services.llm.base import LLMMessage
from app.services.llm.schemas import CoursePlan, UnitOrder

logger = logging.getLogger(__name__)

# A file with no headings is cut into sections of about this many tokens.
SECTION_TOKENS = 1500
# A section under one heading longer than this is cut into parts, so no section is a whole chapter.
MAX_SECTION_TOKENS = 9000
PART_TOKENS = 4500
SNIPPET_CHARS = 240
MAX_PREREQUISITES = 4
MAX_OBJECTIVES = 5
MAX_KEYWORDS = 8


class NoPlannableMaterialError(ValueError):
    """The project has no course-content file with text to plan from. Not retryable."""

    code = "NO_CONTENT_MATERIALS"


# ---------------------------------------------------------------------------------------
# Outline


@dataclass
class Section:
    """A run of consecutive chunks of one file, planned as a unit."""

    id: str
    material_id: str
    filename: str
    chunk_start: int  # chunk_index of the first chunk
    chunk_end: int  # chunk_index of the last chunk
    page_start: Optional[int]
    page_end: Optional[int]
    tokens: int
    heading: str
    snippet: str
    chunk_ids: List[str] = field(default_factory=list)
    position: int = 0  # place in the whole outline


def _heading_path(hierarchy: Optional[str]) -> Tuple[str, ...]:
    if not hierarchy:
        return ()
    return tuple(part.strip() for part in hierarchy.split(">") if part.strip())


def _snippet(text: str) -> str:
    """The start of a chunk's body text, without markdown heading lines."""
    body = " ".join(line.strip() for line in (text or "").splitlines() if line.strip() and not line.lstrip().startswith("#"))
    body = re.sub(r"\s+", " ", body or text or "").strip()
    return body[:SNIPPET_CHARS]


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        cleaned = line.strip().lstrip("#").strip()
        if cleaned:
            return cleaned[:80]
    return ""


def _pages(chunks: Sequence[Dict[str, Any]]) -> Tuple[Optional[int], Optional[int]]:
    starts = [c["page_start"] for c in chunks if c.get("page_start") is not None]
    ends = [c["page_end"] if c.get("page_end") is not None else c["page_start"] for c in chunks if c.get("page_start") is not None]
    return (min(starts), max(ends)) if starts else (None, None)


def _cut_by_tokens(chunks: List[Dict[str, Any]], target: int) -> List[List[Dict[str, Any]]]:
    """Consecutive pieces of about `target` tokens, cut between chunks."""
    pieces: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    size = 0
    for chunk in chunks:
        tokens = int(chunk.get("token_count") or 0)
        if current and size + tokens > target:
            pieces.append(current)
            current, size = [], 0
        current.append(chunk)
        size += tokens
    if current:
        pieces.append(current)
    return pieces


def build_outline(chunks: Sequence[Dict[str, Any]]) -> List[Section]:
    """Sections of the given chunks, numbered S1..Sn.

    `chunks` hold material_id, filename, chunk_index, section_hierarchy, page_start, page_end,
    token_count, chunk_text and id, ordered by file (upload order) and then chunk_index.
    """
    sections: List[Section] = []

    def add(material_chunks: List[Dict[str, Any]], heading: str) -> None:
        first = material_chunks[0]
        page_start, page_end = _pages(material_chunks)
        sections.append(
            Section(
                id=f"S{len(sections) + 1}",
                material_id=str(first["material_id"]),
                filename=first.get("filename") or "file",
                chunk_start=int(first["chunk_index"]),
                chunk_end=int(material_chunks[-1]["chunk_index"]),
                page_start=page_start,
                page_end=page_end,
                tokens=sum(int(c.get("token_count") or 0) for c in material_chunks),
                heading=heading,
                snippet=_snippet(first.get("chunk_text") or ""),
                chunk_ids=[str(c["id"]) for c in material_chunks if c.get("id") is not None],
                position=len(sections),
            )
        )

    # Runs of consecutive chunks with the same first two heading levels, per file.
    runs: List[Tuple[Optional[Tuple[str, ...]], List[Dict[str, Any]]]] = []
    for chunk in chunks:
        key = _heading_path(chunk.get("section_hierarchy"))[:2] or None
        if runs and runs[-1][0] == key and str(runs[-1][1][-1]["material_id"]) == str(chunk["material_id"]):
            runs[-1][1].append(chunk)
        else:
            runs.append((key, [chunk]))

    for key, run in runs:
        if key is None:
            # No headings: a section per ~SECTION_TOKENS, labelled by its first line.
            for piece in _cut_by_tokens(run, SECTION_TOKENS):
                add(piece, _first_line(piece[0].get("chunk_text") or "") or "Untitled section")
            continue
        heading = " > ".join(key)
        if sum(int(c.get("token_count") or 0) for c in run) > MAX_SECTION_TOKENS:
            for number, piece in enumerate(_cut_by_tokens(run, PART_TOKENS), start=1):
                add(piece, f"{heading} (part {number})")
        else:
            add(run, heading)
    return sections


def _page_label(section: Section) -> str:
    if section.page_start is None:
        return "no pages"
    if section.page_end in (None, section.page_start):
        return f"p. {section.page_start}"
    return f"pp. {section.page_start}-{section.page_end}"


def format_outline(sections: Sequence[Section]) -> str:
    """One line per section: `S3 | file | pages | tokens | heading | "snippet"`."""
    return "\n".join(
        f'{s.id} | {s.filename} | {_page_label(s)}, {s.tokens} tokens | {s.heading} | "{s.snippet}"'
        for s in sections
    )


def outline_tokens(sections: Sequence[Section]) -> int:
    return count_tokens(format_outline(sections))


# ---------------------------------------------------------------------------------------
# Validation


@dataclass
class ValidTopic:
    key: str
    name: str
    description: str
    objectives: List[str]
    keywords: List[str]
    section_ids: List[str]
    prerequisite_keys: List[str]
    estimated_minutes: int
    fallback: bool = False


@dataclass
class ValidUnit:
    title: str
    week_label: Optional[str]
    summary: str
    existing_unit_key: Optional[str]
    topics: List[ValidTopic]


@dataclass
class ValidPlan:
    units: List[ValidUnit]
    # section ids that join an existing topic, by the topic's key (E1, E2...)
    additions: Dict[str, List[str]] = field(default_factory=dict)
    stats: Dict[str, int] = field(default_factory=dict)

    def topics(self) -> List[ValidTopic]:
        return [topic for unit in self.units for topic in unit.topics]


def _clean_text(value: Optional[str], limit: int = 255) -> str:
    return re.sub(r"\s+", " ", value or "").strip()[:limit]


_YOU_CAN = re.compile(r"^(?:by the end,?\s*)?(?:you\s+(?:can|will be able to)|students\s+(?:can|will))\s+", re.IGNORECASE)


def clean_objectives(values: Sequence[str]) -> List[str]:
    """Verb phrases that finish "By the end you can ...", at most MAX_OBJECTIVES of them."""
    objectives: List[str] = []
    for value in values or []:
        text = _YOU_CAN.sub("", _clean_text(value, 300)).strip(" -*•.")
        if text and text.lower() not in {o.lower() for o in objectives}:
            objectives.append(text[0].lower() + text[1:] if text[1:2].islower() else text)
    return objectives[:MAX_OBJECTIVES]


def clean_keywords(values: Sequence[str], fallback: str) -> List[str]:
    keywords: List[str] = []
    for value in values or []:
        text = _clean_text(value, 80)
        if text and text.lower() not in {k.lower() for k in keywords}:
            keywords.append(text)
    return keywords[:MAX_KEYWORDS] or [fallback.lower()]


def default_minutes(tokens: int) -> int:
    """Study time from the size of the source: about 110 tokens a minute, 10 to 90."""
    return min(90, max(10, int(round(tokens / 110 / 5.0)) * 5))


def _clamp_minutes(value: Any, tokens: int) -> int:
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return default_minutes(tokens)
    return default_minutes(tokens) if minutes <= 0 else min(max(minutes, 5), 120)


def _file_stem(filename: str) -> str:
    return re.sub(r"[_-]+", " ", filename.rsplit(".", 1)[0]).strip() or filename


def validate_plan(
    plan: CoursePlan,
    sections: Sequence[Section],
    *,
    existing_topic_keys: Sequence[str] = (),
    existing_unit_keys: Sequence[str] = (),
) -> ValidPlan:
    """Make a model's plan safe to write. Pure.

    Rules: unknown section ids are dropped; a section named twice stays with its first topic; a
    section no topic named goes to the topic that owns the neighbouring section of the same file
    (the previous one, else the next); topics with no section are dropped and so are units with
    no topic. Prerequisites keep only topics that come earlier. Two additions to what the spec
    says: when a file has no owned section at all, its sections form a topic of their own (in a
    last unit), and a plan with a single topic gives it every section.
    """
    by_id = {section.id: section for section in sections}
    stats = {"unknown_ids": 0, "duplicate_ids": 0, "unassigned": 0, "adjacency": 0, "fallback_topics": 0,
             "dropped_topics": 0, "dropped_units": 0, "dropped_prerequisites": 0}

    # 1. Topics, with unique keys.
    used_keys: set = set(existing_topic_keys)
    key_map: Dict[str, str] = {}
    units: List[ValidUnit] = []
    for raw_unit in plan.units:
        unit_topics: List[ValidTopic] = []
        for raw in raw_unit.topics:
            key = _clean_text(raw.key, 40) or f"t{len(used_keys) + 1}"
            while key in used_keys:
                key = f"{key}_{len(used_keys) + 1}"
            used_keys.add(key)
            key_map.setdefault(_clean_text(raw.key, 40), key)
            name = _clean_text(raw.name)
            unit_topics.append(
                ValidTopic(
                    key=key,
                    name=name,
                    description=_clean_text(raw.description, 600),
                    objectives=clean_objectives(raw.objectives),
                    keywords=clean_keywords(raw.keywords, name or key),
                    section_ids=list(raw.section_ids),
                    prerequisite_keys=list(raw.prerequisite_keys),
                    estimated_minutes=raw.estimated_minutes,  # clamped once the sections are known
                )
            )
        unit_key = _clean_text(raw_unit.existing_unit_key, 40) or None
        units.append(
            ValidUnit(
                title=_clean_text(raw_unit.title) or "Untitled unit",
                week_label=_clean_text(raw_unit.week_label, 80) or None,
                summary=_clean_text(raw_unit.summary, 600),
                existing_unit_key=unit_key if unit_key in set(existing_unit_keys) else None,
                topics=unit_topics,
            )
        )

    # 2. Assign every section once. `owner` is a ValidTopic or the key of an existing topic.
    owner: Dict[str, Any] = {}

    def assign(section_id: str, who: Any, ids: List[str]) -> None:
        if section_id not in by_id:
            stats["unknown_ids"] += 1
        elif section_id in owner:
            stats["duplicate_ids"] += 1
        else:
            owner[section_id] = who
            ids.append(section_id)

    for unit in units:
        for topic in unit.topics:
            claimed, topic.section_ids = topic.section_ids, []
            for section_id in claimed:
                assign(section_id, topic, topic.section_ids)
    additions: Dict[str, List[str]] = {}
    for addition in plan.additions:
        if addition.topic_key in set(existing_topic_keys):
            for section_id in addition.section_ids:
                assign(section_id, addition.topic_key, additions.setdefault(addition.topic_key, []))
        else:
            stats["unknown_ids"] += len(addition.section_ids)

    # 3. Sections nobody named: the neighbour's topic in the same file.
    all_topics = [topic for unit in units for topic in unit.topics]
    model_topics = list(all_topics)
    by_material: Dict[str, List[Section]] = {}
    for section in sections:
        by_material.setdefault(section.material_id, []).append(section)

    def give(section: Section, who: Any) -> None:
        owner[section.id] = who
        if isinstance(who, ValidTopic):
            who.section_ids.append(section.id)
        else:
            additions.setdefault(who, []).append(section.id)

    fallback_unit: Optional[ValidUnit] = None
    for material_sections in by_material.values():
        for index, section in enumerate(material_sections):
            if section.id in owner:
                continue
            stats["unassigned"] += 1
            who = None
            if index > 0:
                who = owner.get(material_sections[index - 1].id)
            if who is None:
                who = next((owner[s.id] for s in material_sections[index + 1 :] if s.id in owner), None)
            if who is None and len(model_topics) == 1 and not existing_topic_keys:
                who = model_topics[0]
            if who is None:
                # Nothing in this file is owned: it becomes a topic of its own.
                if fallback_unit is None:
                    fallback_unit = ValidUnit("Other material", None, "Material the plan did not place.", None, [])
                    units.append(fallback_unit)
                key = f"fallback{len(used_keys) + 1}"
                used_keys.add(key)
                heading = material_sections[0].heading
                name = _clean_text(heading if heading and not heading.startswith("Untitled") else _file_stem(section.filename))
                who = ValidTopic(
                    key=key, name=name, description=f"From {section.filename}.", objectives=[],
                    keywords=clean_keywords([], name), section_ids=[], prerequisite_keys=[],
                    estimated_minutes=0, fallback=True,
                )
                fallback_unit.topics.append(who)
                all_topics.append(who)
                stats["fallback_topics"] += 1
            else:
                stats["adjacency"] += 1
            give(section, who)

    # 4. Order sections, drop empty topics and units, fill in the rest.
    for topic in all_topics:
        topic.section_ids.sort(key=lambda sid: by_id[sid].position)
    for ids in additions.values():
        ids.sort(key=lambda sid: by_id[sid].position)
    for unit in units:
        kept = [topic for topic in unit.topics if topic.section_ids]
        stats["dropped_topics"] += len(unit.topics) - len(kept)
        unit.topics = kept
    kept_units = [unit for unit in units if unit.topics]
    stats["dropped_units"] = len(units) - len(kept_units)
    units = kept_units

    flat = [topic for unit in units for topic in unit.topics]
    for topic in flat:
        tokens = sum(by_id[sid].tokens for sid in topic.section_ids)
        topic.estimated_minutes = _clamp_minutes(topic.estimated_minutes, tokens)
        if not topic.name:
            topic.name = _clean_text(by_id[topic.section_ids[0]].heading) or _file_stem(by_id[topic.section_ids[0]].filename)
        if not topic.description:
            topic.description = f"Core ideas of {topic.name}."

    # 5. Prerequisites: only topics earlier in the order (existing topics always come earlier).
    position = {topic.key: index for index, topic in enumerate(flat)}
    existing = set(existing_topic_keys)
    for topic in flat:
        resolved: List[str] = []
        for raw_key in topic.prerequisite_keys:
            key = key_map.get(_clean_text(raw_key, 40), _clean_text(raw_key, 40))
            earlier = key in existing or (key in position and position[key] < position[topic.key])
            if key != topic.key and earlier and key not in resolved:
                resolved.append(key)
            else:
                stats["dropped_prerequisites"] += 1
        topic.prerequisite_keys = resolved[:MAX_PREREQUISITES]

    return ValidPlan(units=units, additions=additions, stats=stats)


# ---------------------------------------------------------------------------------------
# The model calls

PLANNER_SYSTEM = """You plan a university course for a study app. You get an outline of the student's files, split into numbered sections, and you group the sections into topics and the topics into units.

Rules:
- Every section id must appear in exactly one topic. Do not invent ids and do not leave any out.
- A topic covers roughly 1,500 to 6,000 tokens of source. Do not merge unrelated sections to reach that; split a big stretch into neighbouring topics instead. A single section larger than 6,000 tokens may be a topic on its own.
- Keep topics contiguous where the material is contiguous: a topic's sections are neighbours in one file unless the course really teaches them together.
- Units follow the syllabus or calendar (its weeks or classes) when one is given, otherwise the material's own chapters or lectures. Give a week_label such as "Week 3" or "Class 11" only when the syllabus or calendar says so.
- Order everything the way a student should learn it: follow the syllabus first, then document order. There is no limit on the number of topics: a 12-week course can have 40 or more.
- Topic names are 2 to 6 words and specific ("Bayes' rule for diagnostic tests", not "Probability"). Write one sentence for each description.
- Each topic has 3 to 5 objectives, each a verb phrase that finishes "By the end you can ..." (for example "compute a posterior probability with Bayes' rule"), 3 to 8 search keywords and an estimate of the study minutes (10 to 90).
- prerequisite_keys name topics that come EARLIER in your plan and that this topic really builds on. Most topics have one or two; use none when there is no real dependency.
- Plan only from the sections. Ignore logistics in a syllabus (grading, office hours); use it for order and naming. Past exams are listed only so you know they exist; they are not sections.
- The student's files may be in any subject; keep the course's own terminology."""

PLANNER_ADDITION_SYSTEM = """

You are adding to a course that already exists. The existing units and topics are fixed: never rename, merge, reorder or remove them. Place only the new sections listed. A new section that continues an existing topic goes into `additions` with that topic's key (E1, E2...). Other new sections form new topics in new units placed after the existing ones; to add a new topic to an existing unit instead, use that unit's key (U1, U2...) as existing_unit_key. prerequisite_keys may name existing topics (E1...) or earlier new ones. Leave `units` empty when everything belongs to existing topics."""

ORDER_SYSTEM = """You order the units of a university course. Each numbered line is a unit with its first topics. Return the unit numbers in the order a student should learn them: follow the syllabus when one is given, otherwise the usual order of the subject. Use every number exactly once."""


def plan_messages(
    course_name: str,
    sections: Sequence[Section],
    *,
    syllabus_text: str = "",
    exam_names: Sequence[str] = (),
    existing_context: str = "",
) -> List[LLMMessage]:
    parts = [f"Course: {course_name}"]
    if syllabus_text.strip():
        parts.append("Syllabus or schedule text (use it for order and unit names):\n<syllabus>\n" + syllabus_text.strip() + "\n</syllabus>")
    if exam_names:
        parts.append("Past exam files (not sections): " + ", ".join(exam_names))
    if existing_context:
        parts.append(existing_context)
        parts.append("New sections to place (id | file | pages, tokens | heading | start of text):")
    else:
        parts.append("Outline of the course files (id | file | pages, tokens | heading | start of text):")
    parts.append(format_outline(sections))
    system = PLANNER_SYSTEM + (PLANNER_ADDITION_SYSTEM if existing_context else "")
    return [LLMMessage(role="system", content=system), LLMMessage(role="user", content="\n\n".join(parts))]


async def _plan_call(messages: List[LLMMessage]) -> CoursePlan:
    llm = LLMFactory.get_provider()
    return await llm.generate_structured(messages, CoursePlan, max_tokens=16000, purpose="extract_topics")


def group_sections(
    sections: Sequence[Section], max_tokens: int, max_sections: int, max_source_tokens: int = 10**12
) -> List[List[Section]]:
    """Consecutive groups of whole files (a file bigger than a group is cut between sections)
    whose outlines, section counts and source sizes fit one call. Used when a course is too big
    to plan in one call."""
    per_section = {s.id: count_tokens(format_outline([s])) for s in sections}
    source = {s.id: s.tokens for s in sections}
    groups: List[List[Section]] = []
    current: List[Section] = []
    size = 0
    files: List[List[Section]] = []
    for section in sections:
        if files and files[-1][0].material_id == section.material_id:
            files[-1].append(section)
        else:
            files.append([section])
    current_source = 0
    for file_sections in files:
        file_size = sum(per_section[s.id] for s in file_sections)
        file_source = sum(source[s.id] for s in file_sections)
        if current and (
            size + file_size > max_tokens
            or len(current) + len(file_sections) > max_sections
            or current_source + file_source > max_source_tokens
        ):
            groups.append(current)
            current, size, current_source = [], 0, 0
        if file_size > max_tokens or len(file_sections) > max_sections or file_source > max_source_tokens:
            for section in file_sections:
                if current and (
                    size + per_section[section.id] > max_tokens
                    or len(current) + 1 > max_sections
                    or current_source + source[section.id] > max_source_tokens
                ):
                    groups.append(current)
                    current, size, current_source = [], 0, 0
                current.append(section)
                size += per_section[section.id]
                current_source += source[section.id]
            continue
        current.extend(file_sections)
        size += file_size
        current_source += file_source
    if current:
        groups.append(current)
    return groups


def _unit_listing(units: Sequence[ValidUnit]) -> str:
    lines = []
    for number, unit in enumerate(units, start=1):
        label = f"{unit.week_label}: " if unit.week_label else ""
        first = "; ".join(topic.name for topic in unit.topics[:3])
        lines.append(f"{number}. {label}{unit.title} (topics: {first})")
    return "\n".join(lines)


async def order_units(units: List[ValidUnit], syllabus_text: str) -> List[ValidUnit]:
    """One cheap call that puts the units of a plan made in groups into teaching order."""
    if len(units) < 2:
        return units
    prompt = _unit_listing(units)
    if syllabus_text.strip():
        prompt = "Syllabus or schedule text:\n<syllabus>\n" + syllabus_text.strip() + "\n</syllabus>\n\nUnits:\n" + prompt
    llm = LLMFactory.get_provider()
    result = await llm.generate_structured(
        [LLMMessage(role="system", content=ORDER_SYSTEM), LLMMessage(role="user", content=prompt)],
        UnitOrder,
        max_tokens=2000,
        purpose="order_units",
    )
    ordered: List[int] = []
    for number in result.order:
        if 1 <= number <= len(units) and number not in ordered:
            ordered.append(number)
    ordered += [number for number in range(1, len(units) + 1) if number not in ordered]
    return [units[number - 1] for number in ordered]


async def plan_sections(
    course_name: str,
    sections: List[Section],
    *,
    syllabus_text: str = "",
    exam_names: Sequence[str] = (),
    existing_context: str = "",
    existing_topic_keys: Sequence[str] = (),
    existing_unit_keys: Sequence[str] = (),
) -> ValidPlan:
    """Plan `sections`: one call, or one per group of files when the outline is too big."""
    too_big = (
        len(sections) > settings.PLANNER_MAX_SECTIONS_PER_CALL
        or sum(section.tokens for section in sections) > settings.PLANNER_MAX_SOURCE_TOKENS_PER_CALL
        or outline_tokens(sections) > settings.PLANNER_MAX_OUTLINE_TOKENS
    )
    if not too_big:
        plan = await _plan_call(
            plan_messages(course_name, sections, syllabus_text=syllabus_text, exam_names=exam_names,
                          existing_context=existing_context)
        )
        valid = validate_plan(plan, sections, existing_topic_keys=existing_topic_keys, existing_unit_keys=existing_unit_keys)
        logger.info("Course plan for %r: %s sections, %s units, %s topics, %s", course_name, len(sections),
                    len(valid.units), len(valid.topics()), valid.stats)
        return valid

    groups = group_sections(
        sections,
        settings.PLANNER_MAX_OUTLINE_TOKENS,
        settings.PLANNER_MAX_SECTIONS_PER_CALL,
        settings.PLANNER_MAX_SOURCE_TOKENS_PER_CALL,
    )
    logger.info("Outline of %s sections is too big for one call: planning %s groups", len(sections), len(groups))
    units: List[ValidUnit] = []
    additions: Dict[str, List[str]] = {}
    stats: Dict[str, int] = {}
    seen_topic_keys = list(existing_topic_keys)
    for number, group in enumerate(groups, start=1):
        plan = await _plan_call(
            plan_messages(course_name, group, syllabus_text=syllabus_text, exam_names=exam_names,
                          existing_context=existing_context)
        )
        valid = validate_plan(plan, group, existing_topic_keys=existing_topic_keys, existing_unit_keys=existing_unit_keys)
        # Keys are only unique inside one call: prefix them so groups can be joined.
        for topic in valid.topics():
            old = topic.key
            topic.key = f"g{number}_{old}"
            for other in valid.topics():
                other.prerequisite_keys = [topic.key if k == old else k for k in other.prerequisite_keys]
        seen_topic_keys += [topic.key for topic in valid.topics()]
        units += valid.units
        for key, ids in valid.additions.items():
            additions.setdefault(key, []).extend(ids)
        for name, value in valid.stats.items():
            stats[name] = stats.get(name, 0) + value
    units = await order_units(units, syllabus_text)
    # After the cross-file order, a prerequisite must still come earlier.
    position = {topic.key: index for index, topic in enumerate(topic for unit in units for topic in unit.topics)}
    for unit in units:
        for topic in unit.topics:
            topic.prerequisite_keys = [
                key for key in topic.prerequisite_keys
                if key in existing_topic_keys or position.get(key, len(position)) < position[topic.key]
            ]
    return ValidPlan(units=units, additions=additions, stats=stats)


# ---------------------------------------------------------------------------------------
# Loading what to plan


@dataclass
class ExistingTopic:
    id: str
    name: str
    unit_id: Optional[str]
    confirmed: bool
    order_index: int
    objectives: List[str]
    sections_text: str = ""
    key: str = ""


@dataclass
class ExistingUnit:
    id: str
    title: str
    week_label: Optional[str]
    order_index: int
    key: str = ""


@dataclass
class PlanJob:
    """Everything one planning run decided, ready for `write_plan`."""

    project_id: str
    mode: str  # full | incremental
    plan: ValidPlan
    sections: List[Section]
    existing_topics: List[ExistingTopic]
    existing_units: List[ExistingUnit]


def _spans_text(sources: Sequence[Dict[str, Any]]) -> str:
    by_file: Dict[str, List[Dict[str, Any]]] = {}
    for source in sources:
        by_file.setdefault(source["filename"], []).append(source)
    parts = []
    for filename, rows in by_file.items():
        starts = [r["page_start"] for r in rows if r["page_start"] is not None]
        ends = [r["page_end"] for r in rows if r["page_end"] is not None]
        parts.append(f"{filename} pp. {min(starts)}-{max(ends)}" if starts and ends else filename)
    return "; ".join(parts)


def existing_context_text(topics: Sequence[ExistingTopic], units: Sequence[ExistingUnit]) -> str:
    lines = ["The course already has these units and topics (fixed):"]
    for unit in units:
        label = f"{unit.week_label}: " if unit.week_label else ""
        members = ", ".join(t.key for t in topics if t.unit_id == unit.id)
        lines.append(f"{unit.key} | {label}{unit.title} | topics {members or 'none'}")
    for topic in topics:
        unit = next((u.key for u in units if u.id == topic.unit_id), "no unit")
        objectives = "; ".join(topic.objectives[:3])
        lines.append(f"{topic.key} | {topic.name} | {unit} | taught from: {topic.sections_text or 'not recorded'}"
                     + (f" | objectives: {objectives}" if objectives else ""))
    return "\n".join(lines)


async def _syllabus_text(project_id: str) -> str:
    rows = await execute_query(
        """
        SELECT mc.chunk_text, mc.token_count
        FROM material_chunks mc
        JOIN materials m ON m.id = mc.material_id
        WHERE m.project_id = $1 AND m.validation_status = 'valid' AND m.role = 'syllabus'
        ORDER BY m.uploaded_at, m.id, mc.chunk_index
        """,
        project_id,
    )
    budget = settings.PLANNER_SYLLABUS_TOKENS
    parts: List[str] = []
    used = 0
    for row in rows:
        tokens = int(row["token_count"] or count_tokens(row["chunk_text"]))
        if used + tokens > budget and parts:
            break
        parts.append(row["chunk_text"].strip())
        used += tokens
    return "\n\n".join(parts)


async def covered_section_ids(
    project_id: str, sections: Sequence[Section], topic_ids: Sequence[str]
) -> set:
    """Sections whose chunks lie inside a source row of one of the topics."""
    if not topic_ids or not sections:
        return set()
    rows = await execute_query(
        "SELECT material_id, chunk_index_start, chunk_index_end FROM topic_sources WHERE topic_id = ANY($1::text[])",
        list(topic_ids),
    )
    spans: Dict[str, List[Tuple[int, int]]] = {}
    for row in rows:
        spans.setdefault(row["material_id"], []).append((row["chunk_index_start"], row["chunk_index_end"]))
    return {
        section.id
        for section in sections
        if any(start <= section.chunk_start and section.chunk_end <= end for start, end in spans.get(section.material_id, []))
    }


async def plan_course(project_id: str) -> PlanJob:
    """Plan a project: the whole course, or (once topics are confirmed) only what is new.

    Makes the model call(s) and writes nothing; `write_plan` stores the result. Raises
    `NoPlannableMaterialError` when no file is course content with text.
    """
    project = (await execute_query("SELECT name FROM projects WHERE id = $1", project_id))
    course_name = project[0]["name"] if project else "Course"

    materials = await execute_query(
        """
        SELECT id, filename, role, uploaded_at FROM materials
        WHERE project_id = $1 AND validation_status = 'valid'
        ORDER BY uploaded_at, id
        """,
        project_id,
    )
    plannable = [m for m in materials if m["role"] not in NON_CONTENT_ROLES]
    exam_names = [m["filename"] for m in materials if m["role"] == "exam"]

    chunk_rows = await execute_query(
        """
        SELECT mc.id, mc.material_id, m.filename, mc.chunk_index, mc.section_hierarchy,
               mc.page_start, mc.page_end, mc.token_count, left(mc.chunk_text, 1500) AS chunk_text
        FROM material_chunks mc
        JOIN materials m ON m.id = mc.material_id
        WHERE m.project_id = $1 AND m.validation_status = 'valid' AND m.role <> ALL($2::text[])
        ORDER BY m.uploaded_at, m.id, mc.chunk_index
        """,
        project_id,
        list(NON_CONTENT_ROLES),
    )
    if not chunk_rows:
        raise NoPlannableMaterialError(
            "No material in this course is marked as course content with readable text. "
            "Mark at least one as course content (not a syllabus or a past exam)."
        )
    all_sections = build_outline([dict(row) for row in chunk_rows])
    syllabus = await _syllabus_text(project_id)

    topic_rows = await execute_query(
        f"""
        SELECT id, name, unit_id, {KEPT_TOPIC} AS user_confirmed, order_index, objectives, created_at
        FROM topics t WHERE project_id = $1 ORDER BY order_index, created_at, id
        """,
        project_id,
    )
    unit_rows = await execute_query(
        "SELECT id, title, week_label, order_index FROM units WHERE project_id = $1 ORDER BY order_index, id",
        project_id,
    )
    source_rows = await execute_query(
        """
        SELECT ts.topic_id, ts.page_start, ts.page_end, m.filename
        FROM topic_sources ts JOIN materials m ON m.id = ts.material_id
        JOIN topics t ON t.id = ts.topic_id
        WHERE t.project_id = $1 AND ts.role = 'primary'
        ORDER BY m.uploaded_at, ts.chunk_index_start
        """,
        project_id,
    )
    confirmed = [row for row in topic_rows if row["user_confirmed"]]

    if not confirmed:
        plan = await plan_sections(course_name, all_sections, syllabus_text=syllabus, exam_names=exam_names)
        return PlanJob(project_id, "full", plan, all_sections, [], [])

    # Confirmed topics exist: place only the sections they do not cover. A project planned before
    # sources existed has none anywhere; its files count as planned when they were uploaded before
    # the newest confirmed topic was created.
    covered = await covered_section_ids(project_id, all_sections, [row["id"] for row in confirmed])
    legacy = not source_rows
    if legacy:
        cutoff = max(row["created_at"] for row in confirmed)
        old_materials = {str(m["id"]) for m in plannable if m["uploaded_at"] <= cutoff}
        covered |= {s.id for s in all_sections if s.material_id in old_materials}
    new_sections = [s for s in all_sections if s.id not in covered]

    sources_by_topic: Dict[str, List[Dict[str, Any]]] = {}
    for row in source_rows:
        sources_by_topic.setdefault(row["topic_id"], []).append(dict(row))
    units = [
        ExistingUnit(row["id"], row["title"], row["week_label"], row["order_index"], key=f"U{number}")
        for number, row in enumerate(unit_rows, start=1)
    ]
    topics = [
        ExistingTopic(
            id=row["id"], name=row["name"], unit_id=row["unit_id"], confirmed=True, order_index=row["order_index"],
            objectives=list(row["objectives"] or []), key=f"E{number}",
            sections_text=_spans_text(sources_by_topic.get(row["id"], [])),
        )
        for number, row in enumerate(confirmed, start=1)
    ]
    if not new_sections:
        logger.info("Project %s: nothing new to place", project_id)
        return PlanJob(project_id, "incremental", ValidPlan(units=[]), [], topics, units)

    # Units that only hold unconfirmed topics are about to go; leave them out of the context.
    confirmed_unit_ids = {t.unit_id for t in topics if t.unit_id}
    context_units = [u for u in units if u.id in confirmed_unit_ids]
    plan = await plan_sections(
        course_name,
        new_sections,
        syllabus_text=syllabus,
        exam_names=exam_names,
        existing_context=existing_context_text(topics, context_units),
        existing_topic_keys=[t.key for t in topics],
        existing_unit_keys=[u.key for u in context_units],
    )
    return PlanJob(project_id, "incremental", plan, new_sections, topics, context_units)


# ---------------------------------------------------------------------------------------
# Writing the plan


# A topic the planner never deletes or replaces: confirmed by the student, or with study activity
# (content, progress, attempts, a review date), whatever its flag says. Used as a column of `topics t`.
KEPT_TOPIC = """(t.user_confirmed
    OR EXISTS (SELECT 1 FROM topic_content x WHERE x.topic_id = t.id)
    OR EXISTS (SELECT 1 FROM topic_progress x WHERE x.topic_id = t.id)
    OR EXISTS (SELECT 1 FROM quiz_attempts x WHERE x.topic_id = t.id)
    OR EXISTS (SELECT 1 FROM practice_progress x WHERE x.topic_id = t.id)
    OR EXISTS (SELECT 1 FROM review_schedules x WHERE x.topic_id = t.id))"""


class StalePlanError(Exception):
    """The confirmed topics changed while the plan was being made (the student pressed Confirm)."""


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


async def write_plan(job: PlanJob) -> Dict[str, int]:
    """Store a plan in one transaction. Returns counts (topics, units, sources, additions).

    A full plan replaces the project's unconfirmed topics: a planned topic with the name of an
    unconfirmed one reuses its row (so its content and ids stay), the others are deleted. An
    incremental plan deletes unconfirmed topics too but only appends to confirmed ones: it adds
    sources to a topic it extends, and new topics and units after the existing ones.
    """
    project_id = job.project_id
    by_id = {section.id: section for section in job.sections}
    plan = job.plan
    section_rows = lambda ids: [by_id[sid] for sid in ids if sid in by_id]  # noqa: E731

    async def write(conn) -> Dict[str, int]:
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", f"plan:{project_id}")
        existing = await conn.fetch(
            f"SELECT id, name, {KEPT_TOPIC} AS user_confirmed, unit_id FROM topics t "
            "WHERE project_id = $1 ORDER BY order_index, created_at, id",
            project_id,
        )
        confirmed_ids = [row["id"] for row in existing if row["user_confirmed"]]
        # The plan was made from the confirmed topics at that time (a full plan from none). If Confirm
        # (or a first study step) changed them while the model was working, what was placed as new may
        # now be covered: nothing is written, and the caller plans again.
        planned_from = {topic.id for topic in job.existing_topics}
        if set(confirmed_ids) != planned_from:
            raise StalePlanError(project_id)
        unconfirmed = [row for row in existing if not row["user_confirmed"]]
        reusable = {} if job.mode == "incremental" else {
            normalize_name(row["name"]): row["id"] for row in reversed(unconfirmed) if normalize_name(row["name"])
        }

        # Reused topic ids, by planned topic key.
        reuse_for: Dict[str, str] = {}
        if job.mode == "full":
            taken: set = set()
            for topic in plan.topics():
                match = reusable.get(normalize_name(topic.name))
                if match and match not in taken:
                    reuse_for[topic.key] = match
                    taken.add(match)
        reused_ids = set(reuse_for.values())

        stale = [row["id"] for row in unconfirmed if row["id"] not in reused_ids]
        if stale:
            await conn.execute("DELETE FROM topics WHERE id = ANY($1::text[])", stale)

        # Units: a full plan starts from a clean slate (nothing confirmed holds on to one); an
        # incremental one drops only the units its deleted topics emptied.
        if job.mode == "full":
            await conn.execute("DELETE FROM units WHERE project_id = $1", project_id)
        else:
            await conn.execute(
                """
                DELETE FROM units u WHERE u.project_id = $1
                  AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.unit_id = u.id)
                  AND u.id = ANY($2::text[])
                """,
                project_id,
                [row["unit_id"] for row in unconfirmed if row["unit_id"]],
            )
        unit_ids_by_key = {unit.key: unit.id for unit in job.existing_units}
        max_unit = await conn.fetchval("SELECT COALESCE(MAX(order_index), -1) FROM units WHERE project_id = $1", project_id)
        max_topic = await conn.fetchval(
            "SELECT COALESCE(MAX(order_index), -1) FROM topics WHERE project_id = $1 AND id <> ALL($2::text[])",
            project_id,
            list(reused_ids),
        )

        topic_ids: Dict[str, str] = {topic.key: topic.id for topic in job.existing_topics}
        next_unit = max_unit + 1
        next_topic = max_topic + 1 if job.mode == "incremental" else 0
        created_topics: List[Tuple[str, Optional[str]]] = []  # (topic id, existing unit id) for ordering
        source_count = 0
        planned: List[Tuple[Any, str]] = []

        for unit in plan.units:
            if unit.existing_unit_key and unit.existing_unit_key in unit_ids_by_key:
                unit_id = unit_ids_by_key[unit.existing_unit_key]
                joined_existing = True
            else:
                unit_id = await conn.fetchval(
                    "INSERT INTO units (id, project_id, title, summary, order_index, week_label) "
                    "VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5) RETURNING id",
                    project_id, unit.title, unit.summary or None, next_unit, unit.week_label,
                )
                next_unit += 1
                joined_existing = False
            for topic in unit.topics:
                sections = section_rows(topic.section_ids)
                material_ids = list(dict.fromkeys(section.material_id for section in sections))
                reused = reuse_for.get(topic.key)
                if reused:
                    await conn.execute(
                        """
                        UPDATE topics SET name = $2, description = $3, keywords = $4, order_index = $5,
                            source_material_ids = $6, unit_id = $7, objectives = $8, estimated_minutes = $9,
                            prerequisite_ids = ARRAY[]::text[]
                        WHERE id = $1
                        """,
                        reused, topic.name, topic.description, topic.keywords, next_topic, material_ids,
                        unit_id, topic.objectives, topic.estimated_minutes,
                    )
                    await conn.execute("DELETE FROM topic_sources WHERE topic_id = $1", reused)
                    topic_id = reused
                else:
                    topic_id = await conn.fetchval(
                        """
                        INSERT INTO topics (id, project_id, name, description, keywords, order_index,
                            source_material_ids, user_confirmed, unit_id, objectives, estimated_minutes,
                            prerequisite_ids)
                        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, ARRAY[]::text[])
                        RETURNING id
                        """,
                        project_id, topic.name, topic.description, topic.keywords, next_topic, material_ids,
                        unit_id, topic.objectives, topic.estimated_minutes,
                    )
                next_topic += 1
                topic_ids[topic.key] = topic_id
                planned.append((topic, topic_id))
                created_topics.append((topic_id, unit_id if joined_existing else None))
                source_count += await _write_sources(conn, topic_id, sections, replace_mappings=True)

        # Prerequisites, now that every planned topic has an id.
        for topic, topic_id in planned:
            prerequisite_ids = [topic_ids[key] for key in topic.prerequisite_keys if key in topic_ids]
            if prerequisite_ids:
                await conn.execute("UPDATE topics SET prerequisite_ids = $2 WHERE id = $1", topic_id, prerequisite_ids)

        # Sections that join an existing (confirmed) topic: add sources and mappings, nothing else.
        added = 0
        for key, section_ids in plan.additions.items():
            topic_id = topic_ids.get(key)
            if topic_id is None:
                continue
            sections = section_rows(section_ids)
            added += await _write_sources(conn, topic_id, sections, replace_mappings=False)
            await conn.execute(
                """
                UPDATE topics SET source_material_ids = (
                    SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::text[])
                    FROM unnest(source_material_ids || $2::text[]) AS x)
                WHERE id = $1
                """,
                topic_id, [section.material_id for section in sections],
            )

        await _place_in_existing_units(conn, project_id, created_topics)

        if plan.units or job.mode == "full":
            # A course the student already confirmed stays active: its new topics wait for review.
            await conn.execute(
                "UPDATE projects SET status = 'topics_pending' WHERE id = $1 AND status NOT IN ('active', 'completed')",
                project_id,
            )
        return {
            "topics": len(planned),
            "units": len(plan.units),
            "sources": source_count + added,
            "additions": len(plan.additions),
            "kept_confirmed": len(confirmed_ids),
        }

    return await execute_in_transaction(write)


async def _write_sources(conn, topic_id: str, sections: Sequence[Section], *, replace_mappings: bool) -> int:
    """One primary source row per section, and mappings for its chunks (so chat can favour them)."""
    if not sections:
        return 0
    await conn.executemany(
        """
        INSERT INTO topic_sources (id, topic_id, material_id, page_start, page_end,
                                   chunk_index_start, chunk_index_end, role)
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, 'primary')
        """,
        [
            (topic_id, s.material_id, s.page_start, s.page_end, s.chunk_start, s.chunk_end)
            for s in sections
        ],
    )
    chunks = [
        {"id": chunk_id, "relevance_score": 1.0, "relevance_source": "course_plan"}
        for section in sections
        for chunk_id in section.chunk_ids
    ]
    if replace_mappings:
        await replace_topic_mappings(conn, topic_id, chunks)
    else:
        await conn.executemany(
            f"""
            INSERT INTO topic_chunk_mappings (id, topic_id, chunk_id, relevance_score, relevance_source, created_at)
            VALUES (gen_random_uuid()::text, $1, $2, 1.0, 'course_plan', {UTC_NOW})
            ON CONFLICT (topic_id, chunk_id) DO NOTHING
            """,
            [(topic_id, chunk["id"]) for chunk in chunks],
        )
    return len(sections)


async def _place_in_existing_units(conn, project_id: str, created: Sequence[Tuple[str, Optional[str]]]) -> None:
    """Topics added to a unit that already existed go right after that unit's last topic."""
    joined = [(topic_id, unit_id) for topic_id, unit_id in created if unit_id]
    if not joined:
        return
    rows = await conn.fetch(
        "SELECT id, unit_id FROM topics WHERE project_id = $1 ORDER BY order_index, created_at, id", project_id
    )
    order = [row["id"] for row in rows]
    unit_of = {row["id"]: row["unit_id"] for row in rows}
    for topic_id, unit_id in joined:
        order.remove(topic_id)
        last = max((i for i, tid in enumerate(order) if unit_of[tid] == unit_id and tid != topic_id), default=None)
        order.insert(len(order) if last is None else last + 1, topic_id)
    for index, topic_id in enumerate(order):
        await conn.execute("UPDATE topics SET order_index = $2 WHERE id = $1", topic_id, index)

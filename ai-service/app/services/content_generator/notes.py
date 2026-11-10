"""
Section notes generator service.
Writes a lesson for one topic from the excerpts of its primary sources.
"""

import re
from typing import List, Dict, Optional
from datetime import UTC, datetime

from app.services.content_generator.context import (
    NoSourceMaterialError,
    content_messages,
    fetch_topic_context,
    focus_line,
)
from app.services.llm.base import LLMOutputError
from app.services.llm.factory import LLMFactory


_DETAIL_LEVELS = {
    "brief": "Keep it short: about 400-600 words in all.",
    "moderate": "Give a balanced lesson with the important details, in about 700-1000 words.",
    "comprehensive": "Cover the topic thoroughly, in about 1000-1500 words.",
}

_MIN_NOTES_WORDS = 80

# The lesson's headings, new ones first, then the headings older notes used. A bare line with
# one of these words (no "#") is promoted to a "##" heading, whatever the capitalisation.
_SECTION_LABELS = (
    "What you'll learn",
    "The idea",
    "Key concepts",
    "Worked example",
    "Check yourself",
    "Common pitfalls",
    "Summary",
    "Overview",
    "How it works",
    "Exam-ready recap",
)
_CANONICAL_LABEL = {label.lower(): label for label in _SECTION_LABELS}
# "Key Concepts" and "Common Pitfalls" are written in title case by older notes; keep what the
# model wrote when it was already a heading and only promote bare lines.
_LABEL_LINE = re.compile(
    r"(?im)^[ \t]*(?:\*\*|__)?(" + "|".join(re.escape(label).replace("'", "['\u2019]") for label in _SECTION_LABELS)
    + r")(?:\*\*|__)?:?[ \t]*$"
)
_FENCED_BLOCK = re.compile(r"(?ms)(^```.*?^```[^\n]*$)")
_CHECK_FENCE_OPEN = re.compile(r"(?m)^```[ \t]*check[ \t]*$", re.IGNORECASE)
_HEADING = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t]*$")
_QUESTION_LINE = re.compile(r"^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:Q(?:uestion)?[ \t]*\d*)[:.)](?:\*\*|__)?[ \t]*(.*)$", re.IGNORECASE)
_ANSWER_LINE = re.compile(r"^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:A(?:nswer)?)[:.)](?:\*\*|__)?[ \t]*(.*)$", re.IGNORECASE)


def _promote_labels(text: str) -> str:
    def promote(match: re.Match) -> str:
        label = match.group(1).replace("\u2019", "'")
        return f"## {_CANONICAL_LABEL.get(label.lower(), label)}"

    return _LABEL_LINE.sub(promote, text)


def _wrap_check_blocks(section_lines: List[str]) -> List[str]:
    """Q:/A: pairs written as plain lines under "Check yourself" become ```check blocks.

    Lines before the first question and a section that already has ```check blocks are left
    as they are.
    """
    pairs: List[Dict[str, List[str]]] = []
    head: List[str] = []
    current: Optional[Dict[str, List[str]]] = None
    target: Optional[List[str]] = None
    for line in section_lines:
        question = _QUESTION_LINE.match(line)
        answer = _ANSWER_LINE.match(line)
        if question:
            current = {"q": [question.group(1)], "a": []}
            pairs.append(current)
            target = current["q"]
        elif answer and current is not None:
            current["a"].append(answer.group(1))
            target = current["a"]
        elif current is not None and line.strip():
            target.append(line.strip())
        elif current is None:
            head.append(line)
    if not pairs or any(not pair["a"] for pair in pairs):
        return section_lines
    out = list(head)
    while out and not out[-1].strip():
        out.pop()
    for pair in pairs:
        out += ["", "```check", "Q: " + " ".join(part for part in pair["q"] if part).strip(),
                "A: " + " ".join(part for part in pair["a"] if part).strip(), "```"]
    return out + [""]


def _repair_check_section(text: str) -> str:
    """Normalise the fence of ```check blocks and wrap loose Q:/A: pairs in "Check yourself"."""
    text = re.sub(r"(?m)^```[ \t]*check[ \t]*$", "```check", text, flags=re.IGNORECASE)
    lines = text.split("\n")
    out: List[str] = []
    in_fence = False
    start: Optional[int] = None  # index in `out` of the first line of the Check yourself body
    for line in lines + ["## __end__"]:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        heading = None if in_fence else _HEADING.match(line)
        if heading and line.startswith("##") and not line.startswith("###"):
            if start is not None:
                body = out[start:]
                if not _CHECK_FENCE_OPEN.search("\n".join(body)):
                    out[start:] = _wrap_check_blocks(body)
                start = None
            if heading.group(1).strip().lower().rstrip(":") == "check yourself":
                out.append(line)
                start = len(out)
                continue
        if line != "## __end__":
            out.append(line)
    return "\n".join(out)


class NotesGenerator:
    """Generate a topic lesson from material chunks."""

    def __init__(self):
        self.llm = LLMFactory.get_provider()

    async def generate_notes(
        self,
        topic_id: str,
        topic_name: str,
        topic_description: str,
        user_preferences: Optional[Dict] = None,
        cache_excerpts: bool = False,
    ) -> Dict:
        """
        Generate notes for a topic.

        Args:
            topic_id: Topic ID
            topic_name: Topic name
            topic_description: Topic description
            user_preferences: Optional preferences (detail_level, include_examples, focus)
            cache_excerpts: True for a regeneration, so the excerpt block is cached

        Returns:
            Dict with generated content and metadata
        """
        context = await fetch_topic_context(topic_id)
        chunks = context.chunks
        if not chunks:
            raise NoSourceMaterialError(f"No source material is mapped to topic {topic_id}")

        preferences = user_preferences or {}
        notes_content = await self._generate_with_llm(
            topic_name=topic_name,
            topic_description=topic_description,
            chunks=chunks,
            detail_level=preferences.get('detail_level', 'comprehensive'),
            include_examples=preferences.get('include_examples', True),
            focus=preferences.get('focus'),
            cache_excerpts=cache_excerpts,
            course_map=context.course_map,
            has_objectives=bool(context.topic.get("objectives")),
        )
        notes_content = self._postprocess_notes_markdown(notes_content)
        if len(notes_content.split()) < _MIN_NOTES_WORDS:
            raise LLMOutputError(
                f"Notes for topic {topic_id} were too short ({len(notes_content.split())} words)"
            )

        return {
            'content': notes_content,
            'citations': self._extract_citations(chunks),
            'chunk_count': len(chunks),
            'generated_at': datetime.now(UTC).isoformat()
        }

    async def _generate_with_llm(
        self,
        topic_name: str,
        topic_description: str,
        chunks: List[Dict],
        detail_level: str,
        include_examples: bool,
        focus: Optional[str] = None,
        cache_excerpts: bool = False,
        course_map: str = "",
        has_objectives: bool = False,
    ) -> str:
        """Generate notes markdown."""
        detail_instruction = _DETAIL_LEVELS.get(detail_level, _DETAIL_LEVELS['comprehensive'])
        learn_line = (
            "(the topic's objectives from the course map, as bullets that start with \"You can\")"
            if has_objectives
            else "(3-5 bullets of what the student can do after the lesson, each starting with \"You can\")"
        )
        worked_example = (
            """## Worked example
(ONE example taken from the source excerpts, solved step by step with the reason for each step; if the excerpts hold none, write one that uses the same ideas)
"""
            if include_examples
            else ""
        )

        instructions = f"""Write a lesson for the topic "{topic_name}" from the excerpts above.
{focus_line(focus, v2=False)}
{detail_instruction}
Teach this topic's objectives only and assume its prerequisites. Build understanding: intuition first, concrete before abstract, then the precise statement.

Use exactly this structure:
# {topic_name}

## What you'll learn
{learn_line}
## The idea
(the intuition in plain words, with a concrete picture or case before any formula)
## Key concepts
(each definition or result, with one small example each)
{worked_example}## Check yourself
(2-3 quick questions about this topic, each in its own fenced block that starts with ```check, with the question on the first line as "Q: ..." and the answer on the next as "A: ...", then a closing fence. Math is allowed in both lines.)
## Common pitfalls
(the mistakes students commonly make, and how to avoid them)
## Summary
(5-8 recall bullets)

Return only the markdown."""

        response = await self.llm.generate_text(
            content_messages(topic_name, topic_description, chunks, instructions, cache_excerpts, course_map, v2=False),
            max_tokens=12000,
            purpose="section_notes",
        )
        return response.content

    def _postprocess_notes_markdown(self, content: str) -> str:
        """Tidy model markdown for the notes viewer. Fenced code blocks are left untouched."""
        text = (content or "").replace("\r\n", "\n").strip()
        if not text:
            return text

        # Odd-numbered parts are fenced code blocks.
        parts = _FENCED_BLOCK.split(text)
        cleaned_parts = []
        for index, part in enumerate(parts):
            if index % 2 == 1:
                cleaned_parts.append(part)
                continue
            part = re.sub(r"[ \t]*\[Citation:[^\]]+\]", "", part, flags=re.IGNORECASE)
            part = re.sub(r"(?im)^\s*If you want, I can\b.*$", "", part)
            # Promote bare section labels to headings if the model left off the '#'.
            part = _promote_labels(part)
            part = re.sub(r"\n{3,}", "\n\n", part)
            cleaned_parts.append(part)
        return _repair_check_section("".join(cleaned_parts).strip()).strip()

    def _extract_citations(self, chunks: List[Dict]) -> List[Dict]:
        """One citation per source file: its name, category and pages.

        A topic taught from planned sources cites those spans: the first to the last page of the
        file's primary chunks. A topic taught from mappings cites the pages of the file's most
        relevant chunk. `material_id` and `page` (the first page, None for formats without pages)
        let the notes page link to the file viewer.
        """
        primary = [chunk for chunk in chunks if chunk.get("source_kind") == "primary"]
        per_file: Dict[str, List[Dict]] = {}
        for chunk in primary or chunks:
            per_file.setdefault(chunk['filename'], []).append(chunk)

        citations = []
        for filename, file_chunks in per_file.items():
            first = file_chunks[0]
            if primary:
                paged = [c for c in file_chunks if c.get('page_start') is not None]
                first_page = min((c['page_start'] for c in paged), default=None)
                last_page = max((c['page_end'] if c.get('page_end') is not None else c['page_start'] for c in paged), default=None)
            else:
                first_page, last_page = first.get('page_start'), first.get('page_end')
            if first_page is None:
                pages = "n/a"  # formats without pages, such as DOCX
            elif last_page is None or last_page == first_page:
                pages = str(first_page)
            else:
                pages = f"{first_page}-{last_page}"
            material_id = first.get('material_id')
            citations.append({
                'filename': filename,
                'category': first['category'],
                'pages': pages,
                'material_id': str(material_id) if material_id is not None else None,
                'page': first_page,
            })
        return citations

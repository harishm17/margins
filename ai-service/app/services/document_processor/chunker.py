"""Split extracted pages into chunks for embedding and retrieval.

The text is markdown. It is cut into sections at headings, and each section is split by a
recursive, token-based splitter: paragraphs first, then lines, sentences, words and finally
raw characters, so CJK text or an unbroken string still ends up in pieces. Chunks are about
`CHUNK_TOKENS` long (cl100k_base tokens) and each one starts with the tail of the previous
one (`OVERLAP_TOKENS`). Headings stay in the chunk text; `section_hierarchy` is the heading
path. Every chunk knows the pages it covers.

The embedding model takes 512 tokens, so chunks have a hard character cap as well: a string
with no spaces can be a lot of characters per token or very few.
"""
import bisect
import functools
import logging
import re
from typing import List, Optional, Sequence, Tuple

import tiktoken
from pydantic import BaseModel

from app.services.document_processor.parse_types import ExtractedPage

logger = logging.getLogger(__name__)

CHUNK_TOKENS = 350
OVERLAP_TOKENS = 50
CHUNK_CHARS = 2000  # hard cap on a chunk, overlap included
OVERLAP_CHARS = 400
# Pieces are split down to this size before packing, so a piece plus the overlap always fits.
PIECE_TOKENS = CHUNK_TOKENS - OVERLAP_TOKENS
PIECE_CHARS = CHUNK_CHARS - OVERLAP_CHARS
# An overlap shorter than this starts mid-sentence instead of at a sentence boundary.
MIN_SENTENCE_OVERLAP_TOKENS = 20
MAX_HEADING_CHARS = 120

HEADING_LINE = re.compile(r"^(#{1,6})[ \t]+(\S.*)$")
# "2", "2.1", "2.1.3." followed by a space. Bounded groups keep this linear.
NUMBERED_HEADING = re.compile(r"^(\d{1,3}(?:\.\d{1,3})*)\.?\s+")
CODE_FENCE = re.compile(r"^\s*(```|~~~)")
PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n\s*")
SENTENCE_END = re.compile(r"[.!?][\"')\]]*\s+|[。！？]|\n")
WHITESPACE_RUN = re.compile(r"\s+")


class Chunk(BaseModel):
    """A piece of a material, ready to embed."""

    chunk_text: str
    section_hierarchy: Optional[str] = None  # e.g. "Chapter 2 > 2.1 Hashing"
    page_start: Optional[int] = None  # 1-indexed; None for formats without pages
    page_end: Optional[int] = None
    chunk_index: int
    token_count: int


class NoContentError(ValueError):
    """The file produced no text to chunk. A content problem, so retrying will not help."""

    code = "NO_CONTENT"


@functools.lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    # Material text may contain strings like "<|endoftext|>"; count them as plain text.
    return len(_encoding().encode(text, disallowed_special=()))


# Sections

class _Section:
    """A heading and the text under it, with the page each line came from."""

    def __init__(self, path: Tuple[str, ...]):
        self.path = path
        self.lines: List[Tuple[Optional[int], str]] = []
        self.has_body = False
        self.heading_level = 0

    def add_line(self, page: Optional[int], line: str, is_heading: bool = False) -> None:
        if not line.strip() and (not self.lines or not self.lines[-1][1].strip()):
            return  # no leading or doubled blank lines
        self.lines.append((page, line))
        if line.strip() and not is_heading:
            self.has_body = True

    def text_and_pages(self) -> Tuple[str, List[int], List[Optional[int]]]:
        """Section text, plus the offset where each line starts and that line's page."""
        offsets, pages, parts, position = [], [], [], 0
        for page, line in self.lines:
            offsets.append(position)
            pages.append(page)
            parts.append(line)
            position += len(line) + 1
        return "\n".join(parts), offsets, pages


def _clean_heading(text: str) -> str:
    text = text.strip().rstrip("#").strip()
    text = re.sub(r"^[*_]+|[*_]+$", "", text).strip()
    text = text.replace("**", "").replace("__", "")
    return text


def _nested_numbered_level(
    text: str, level: int, stack: List[Tuple[int, str]]
) -> int:
    """Deepen a numbered heading ("2.1.1") that sits at the same level as its parent ("2.1").

    Some PDFs set every heading in one font size, so the parser gives them all one level.
    """
    if not stack:
        return level
    parent_level, parent_text = stack[-1]
    current, parent = NUMBERED_HEADING.match(text), NUMBERED_HEADING.match(parent_text)
    if not current or not parent or parent_level != level:
        return level
    if current.group(1).startswith(parent.group(1) + "."):
        return min(level + 1, 6)
    return level


def _split_sections(pages: Sequence[ExtractedPage]) -> List[_Section]:
    sections: List[_Section] = []
    stack: List[Tuple[int, str]] = []
    current = _Section(path=())
    in_code = False

    def start_section(page: Optional[int], level: int, heading_line: str) -> None:
        nonlocal current
        # A heading with nothing under it yet is kept with the next, deeper heading, so a
        # chapter title does not become a chunk of its own.
        absorb = current.lines and not current.has_body and level > current.heading_level
        if not absorb:
            if current.lines:
                sections.append(current)
            current = _Section(path=())
        current.path = tuple(text for _, text in stack)
        current.heading_level = level
        current.add_line(page, heading_line, is_heading=True)

    for page in pages:
        if current.lines and current.lines[-1][1].strip():
            current.add_line(page.number, "")  # a page break ends the paragraph
        for raw_line in page.text.split("\n"):
            line = raw_line.rstrip()
            if CODE_FENCE.match(line):
                in_code = not in_code
            heading = None if in_code else HEADING_LINE.match(line)
            heading_text = _clean_heading(heading.group(2)) if heading else ""
            # A "heading" this long is body text set in a large font (an author list, a quote).
            if heading and heading_text and len(heading_text) <= MAX_HEADING_CHARS:
                level = _nested_numbered_level(heading_text, len(heading.group(1)), stack)
                while stack and stack[-1][0] >= level:
                    stack.pop()
                stack.append((level, heading_text))
                start_section(page.number, level, f"{'#' * level} {heading_text}")
            else:
                current.add_line(page.number, line)
    if current.lines:
        sections.append(current)
    return sections


# Splitting

def _boundaries(text: str, lo: int, hi: int, pattern: "re.Pattern[str]") -> List[Tuple[int, int]]:
    """Cut [lo, hi) after every match of `pattern`; the pieces cover the range exactly."""
    pieces, start = [], lo
    for match in pattern.finditer(text, lo, hi):
        if lo < match.end() < hi:
            pieces.append((start, match.end()))
            start = match.end()
    pieces.append((start, hi))
    return pieces


class _Splitter:
    """Splits one section's text into pieces, then packs them into overlapping chunks."""

    def __init__(self, text: str):
        self.text = text

    def _hard_cut(self, lo: int, hi: int) -> List[Tuple[int, int, int]]:
        pieces = []
        while lo < hi:
            size = min(PIECE_CHARS, hi - lo)
            tokens = count_tokens(self.text[lo : lo + size])
            while size > 1 and tokens > PIECE_TOKENS:
                size = max(1, size * 3 // 4)
                tokens = count_tokens(self.text[lo : lo + size])
            pieces.append((lo, lo + size, tokens))
            lo += size
        return pieces

    def pieces(self, lo: int, hi: int, level: int = 0) -> List[Tuple[int, int, int]]:
        """(start, end, tokens) pieces of [lo, hi), each within the piece limits."""
        if hi - lo <= PIECE_CHARS:
            tokens = count_tokens(self.text[lo:hi])
            if tokens <= PIECE_TOKENS:
                return [(lo, hi, tokens)]
        if level >= len(_LEVELS):
            return self._hard_cut(lo, hi)
        result = []
        for start, end in _LEVELS[level](self.text, lo, hi):
            result.extend(self.pieces(start, end, level + 1))
        return result

    def _overlap_start(self, chunk_start: int, chunk_end: int) -> Optional[int]:
        """Where the next chunk starts so that it repeats the tail of this one."""
        text = self.text
        # Earliest position whose tail fits the overlap limits (tokens grow as it moves left).
        low, high = max(chunk_start + 1, chunk_end - OVERLAP_CHARS), chunk_end
        while low < high:
            middle = (low + high) // 2
            if count_tokens(text[middle:chunk_end]) <= OVERLAP_TOKENS:
                high = middle
            else:
                low = middle + 1
        earliest = low
        if earliest >= chunk_end or not text[earliest:chunk_end].strip():
            return None

        # Prefer a sentence or line start, then a word start, over cutting mid-word.
        for match in SENTENCE_END.finditer(text, earliest, chunk_end):
            start = match.end()
            if start < chunk_end and text[start:chunk_end].strip():
                if count_tokens(text[start:chunk_end]) >= MIN_SENTENCE_OVERLAP_TOKENS:
                    return start
                break
        if earliest > chunk_start and not text[earliest - 1].isspace():
            word_start = WHITESPACE_RUN.search(text, earliest, chunk_end)
            if word_start and word_start.end() < chunk_end:
                return word_start.end()
        return earliest

    def chunks(self) -> List[Tuple[int, int]]:
        """(start, end) character ranges of the chunks, each overlapping the one before."""
        pieces = self.pieces(0, len(self.text))
        ranges: List[Tuple[int, int]] = []
        if not pieces:
            return ranges

        start, content_start, end, tokens = pieces[0][0], pieces[0][0], pieces[0][1], pieces[0][2]
        for piece_start, piece_end, piece_tokens in pieces[1:]:
            if tokens + piece_tokens <= CHUNK_TOKENS and piece_end - start <= CHUNK_CHARS:
                end, tokens = piece_end, tokens + piece_tokens
                continue

            if self.text[content_start:end].strip():
                ranges.append((start, end))
            overlap = self._overlap_start(start, end)
            overlap_tokens = count_tokens(self.text[overlap:end]) if overlap is not None else 0
            if (
                overlap is not None
                and overlap_tokens + piece_tokens <= CHUNK_TOKENS
                and piece_end - overlap <= CHUNK_CHARS
            ):
                start, tokens = overlap, overlap_tokens + piece_tokens
            else:
                start, tokens = piece_start, piece_tokens
            content_start, end = piece_start, piece_end

        if self.text[content_start:end].strip():
            ranges.append((start, end))
        return ranges


_LEVELS = (
    lambda text, lo, hi: _boundaries(text, lo, hi, PARAGRAPH_BREAK),
    lambda text, lo, hi: _boundaries(text, lo, hi, re.compile(r"\n")),
    lambda text, lo, hi: _boundaries(text, lo, hi, SENTENCE_END),
    lambda text, lo, hi: _boundaries(text, lo, hi, WHITESPACE_RUN),
)


# Public API

def chunk_pages(pages: Sequence[ExtractedPage]) -> List[Chunk]:
    """Chunk markdown pages. Raises `NoContentError` when there is no text."""
    chunks: List[Chunk] = []
    for section in _split_sections(pages):
        text, line_offsets, line_pages = section.text_and_pages()
        hierarchy = " > ".join(section.path) or None
        for start, end in _Splitter(text).chunks():
            body = text[start:end]
            lead = len(body) - len(body.lstrip())
            body = body.strip()
            if not body:
                continue
            first = bisect.bisect_right(line_offsets, start + lead) - 1
            last = bisect.bisect_right(line_offsets, start + lead + len(body) - 1) - 1
            chunks.append(
                Chunk(
                    chunk_text=body,
                    section_hierarchy=hierarchy,
                    page_start=line_pages[first],
                    page_end=line_pages[last],
                    chunk_index=len(chunks),
                    token_count=count_tokens(body),
                )
            )
    if not chunks:
        raise NoContentError(
            "No chunks were created from the material. The file may be empty or contain "
            "unreadable text."
        )
    return chunks

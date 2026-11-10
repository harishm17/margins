"""Turn uploaded study materials into markdown pages.

Every format ends up as a list of pages of markdown text: headings as `#` lines, tables as
markdown tables. PDFs come out of pymupdf4llm one page at a time, so each chunk can later be
traced to its pages. PPTX is one page per slide. DOCX has no page breaks to read, so it is a
single page with no page number.

This module runs only inside the limited child process (`sandbox_child.py`); the app reads
files through `sandbox.parse_document`. It is blocking and single-threaded.
"""
from __future__ import annotations

import logging
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Iterator, List, Optional

# pymupdf loads an ONNX layout model when `pymupdf.layout` can be imported, which costs seconds and
# about 3 GB of address space. Layout mode is off (see below), so keep that import from working.
sys.modules["pymupdf.layout"] = None  # type: ignore[assignment]

import pymupdf
import pymupdf4llm
from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from pptx import Presentation
from pptx.shapes.group import GroupShape

from app.services.document_processor.parse_types import (
    SUPPORTED_EXTENSIONS,
    ExtractedDocument,
    ExtractedPage,
    ParseLimits,
    ParseRefused,
    UnreadableDocumentError,
    infer_extension,
)

logger = logging.getLogger(__name__)

CORRUPT_NOTE = "This file could not be read. It may be corrupt."
DOCX_CHARS_PER_PAGE = 2400  # page-count estimate only; DOCX has no real pages to count

# The plain heading detection (font sizes across the whole document) is the one that stays
# consistent between pages. Layout mode decides each page on its own and would give "2.2" a
# different level on page 2 than "2.1" had on page 1.
pymupdf4llm.use_layout(False)

class _TextBudget:
    """Counts extracted characters and stops the read once the cap is passed."""

    def __init__(self, max_chars: int):
        self.max_chars = max_chars
        self.used = 0

    def add(self, text: str) -> None:
        self.used += len(text)
        if self.used > self.max_chars:
            raise ParseRefused("too_much_text")


def _normalize_text(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _clean_table_cell(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def _markdown_table(rows: List[List[str]]) -> str:
    """Markdown table from rows of cell text; the first row is the header."""
    rows = [row for row in rows if any(cell for cell in row)]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


# PDF

def _extract_pdf(file_path: str, markdown: bool, limits: ParseLimits) -> ExtractedDocument:
    doc = pymupdf.open(file_path)
    try:
        if doc.needs_pass:
            raise UnreadableDocumentError("The PDF is password-protected.")
        # Refused before any page is converted.
        if doc.page_count > limits.max_pdf_pages:
            raise ParseRefused("too_many_pages", max_pages=limits.max_pdf_pages)
        budget = _TextBudget(limits.max_chars)
        pages: List[ExtractedPage] = []
        # Heading levels come from font sizes over the whole document, computed once.
        headers = pymupdf4llm.IdentifyHeaders(doc, body_limit=10) if markdown else None
        for index in range(doc.page_count):
            if markdown:
                text = pymupdf4llm.to_markdown(
                    doc, pages=[index], hdr_info=headers, ignore_images=True
                )
                # "mc <sup>2</sup>" -> "mc<sup>2</sup>"
                text = re.sub(r"[ \t]+(<su[bp]>)", r"\1", text)
            else:
                text = doc[index].get_text()
            text = _normalize_text(text)
            budget.add(text)
            pages.append(ExtractedPage(number=index + 1, text=text))
        return ExtractedDocument(pages=pages, extension=".pdf", page_count=doc.page_count)
    finally:
        doc.close()


# DOCX and PPTX are zip files of XML parts. The declared sizes in a zip's directory are what the
# reader honours, so they bound the work: check them before any XML is parsed.

_XML_PART_SUFFIXES = (".xml", ".rels")
_SMALL_PART_BYTES = 1024 * 1024  # a part this small cannot hurt, whatever its ratio


def _check_zip_package(file_path: str, limits: ParseLimits) -> None:
    """Refuse a package with too many members, too much XML, or an absurdly packed XML part.
    Media parts are ignored, so a deck full of pictures passes."""
    try:
        archive = zipfile.ZipFile(file_path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise UnreadableDocumentError(CORRUPT_NOTE) from exc
    with archive:
        members = archive.infolist()
        if len(members) > limits.max_zip_members:
            raise ParseRefused("unsafe")
        total_xml = 0
        for member in members:
            if not member.filename.lower().endswith(_XML_PART_SUFFIXES):
                continue
            total_xml += member.file_size
            if total_xml > limits.max_xml_mb * 1024 * 1024:
                raise ParseRefused("unsafe")
            if (
                member.file_size > _SMALL_PART_BYTES
                and member.file_size > limits.max_xml_ratio * max(member.compress_size, 1)
            ):
                raise ParseRefused("unsafe")


# DOCX

_HEADING_STYLE = re.compile(r"^heading (\d)$", re.IGNORECASE)


def _iter_docx_blocks(parent) -> Iterator[object]:
    """Paragraphs and tables of a body element in document order, through content controls."""
    for child in parent.iterchildren():
        if child.tag == qn("w:p"):
            yield child
        elif child.tag == qn("w:tbl"):
            yield child
        elif child.tag == qn("w:sdt"):
            content = child.find(qn("w:sdtContent"))
            if content is not None:
                yield from _iter_docx_blocks(content)


def _docx_run_text(run: Run) -> str:
    text = run.text
    if not text.strip():
        return text
    if run.font.subscript:
        return f"<sub>{text}</sub>"
    if run.font.superscript:
        return f"<sup>{text}</sup>"
    return text


def _docx_paragraph_text(paragraph: Paragraph) -> str:
    parts = []
    for item in paragraph.iter_inner_content():
        parts.append(_docx_run_text(item) if isinstance(item, Run) else item.text)
    return "".join(parts).strip()


def _docx_paragraph_markdown(paragraph: Paragraph) -> str:
    text = _docx_paragraph_text(paragraph)
    if not text:
        return ""
    style_name = (paragraph.style.name if paragraph.style is not None else "") or ""
    if style_name.lower() == "title":
        return f"# {text}"
    match = _HEADING_STYLE.match(style_name)
    if match:
        return f"{'#' * min(int(match.group(1)), 6)} {text}"
    properties = paragraph._p.pPr
    numbering = properties.numPr if properties is not None else None
    if numbering is not None or style_name.lower().startswith("list"):
        level = 0
        if numbering is not None and numbering.ilvl is not None:
            level = numbering.ilvl.val or 0
        return f"{'  ' * level}- {text}"
    return text


def _docx_table_markdown(table: Table) -> str:
    rows = []
    for row in table.rows:
        cells, previous = [], None
        for cell in row.cells:
            if cell._tc is previous:  # horizontally merged cells repeat the same cell
                continue
            previous = cell._tc
            cells.append(_clean_table_cell(cell.text))
        rows.append(cells)
    return _markdown_table(rows)


def _extract_docx(file_path: str, limits: ParseLimits) -> ExtractedDocument:
    _check_zip_package(file_path, limits)
    document = Document(file_path)
    budget = _TextBudget(limits.max_chars)
    blocks: List[str] = []
    for element in _iter_docx_blocks(document.element.body):
        if element.tag == qn("w:p"):
            block = _docx_paragraph_markdown(Paragraph(element, document))
        else:
            block = _docx_table_markdown(Table(element, document))
        if block:
            budget.add(block)
            blocks.append(block)

    text = _normalize_text("\n\n".join(blocks))
    page_count = max(1, len(text) // DOCX_CHARS_PER_PAGE)
    return ExtractedDocument(
        pages=[ExtractedPage(number=None, text=text)], extension=".docx", page_count=page_count
    )


# PPTX

def _iter_pptx_shapes(shapes) -> Iterator[object]:
    """Shapes in reading order (top to bottom, left to right), descending into groups."""
    for shape in sorted(shapes, key=lambda s: (s.top or 0, s.left or 0)):
        if isinstance(shape, GroupShape):
            yield from _iter_pptx_shapes(shape.shapes)
        else:
            yield shape


def _pptx_text_frame_markdown(text_frame) -> str:
    paragraphs = []
    for paragraph in text_frame.paragraphs:
        text = " ".join(paragraph.text.replace("\x0b", " ").split())
        if text:
            paragraphs.append((paragraph.level or 0, text))
    if len(paragraphs) == 1 and paragraphs[0][0] == 0:
        return paragraphs[0][1]
    return "\n".join(f"{'  ' * level}- {text}" for level, text in paragraphs)


def _pptx_slide_markdown(slide, number: int) -> str:
    title_shape = slide.shapes.title
    title = ""
    if title_shape is not None and title_shape.has_text_frame:
        title = " ".join(title_shape.text_frame.text.split())
    blocks = [f"# {title or f'Slide {number}'}"]

    for shape in _iter_pptx_shapes(slide.shapes):
        if title_shape is not None and shape.shape_id == title_shape.shape_id:
            continue
        if getattr(shape, "has_table", False) and shape.has_table:
            rows = [
                [_clean_table_cell(cell.text) for cell in row.cells] for row in shape.table.rows
            ]
            block = _markdown_table(rows)
        elif getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            block = _pptx_text_frame_markdown(shape.text_frame)
        else:
            continue
        if block:
            blocks.append(block)

    if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
        notes = slide.notes_slide.notes_text_frame.text.strip()
        if notes:
            blocks.append(f"Speaker notes:\n{notes}")
    return "\n\n".join(blocks)


def _extract_pptx(file_path: str, limits: ParseLimits) -> ExtractedDocument:
    _check_zip_package(file_path, limits)
    presentation = Presentation(file_path)
    budget = _TextBudget(limits.max_chars)
    pages = []
    for number, slide in enumerate(presentation.slides, start=1):
        text = _normalize_text(_pptx_slide_markdown(slide, number))
        budget.add(text)
        pages.append(ExtractedPage(number=number, text=text))
    return ExtractedDocument(pages=pages, extension=".pptx", page_count=len(pages))


# Legacy DOC

def _extract_doc(file_path: str, limits: ParseLimits) -> ExtractedDocument:
    """Plain text of a legacy Word file through catdoc (no headings or tables). catdoc is what
    the Docker image ships. It runs as a child of the limited process, so it inherits the
    limits, and writes to a file so its output is never buffered in memory."""
    catdoc = shutil.which("catdoc")
    if not catdoc:
        raise UnreadableDocumentError(
            "Legacy .doc files cannot be read on this server. "
            "Please save the file as .docx or PDF and upload it again."
        )
    work_dir = tempfile.mkdtemp(prefix="margins-doc-")
    try:
        out_path = Path(work_dir) / "text.txt"
        with open(out_path, "wb") as out:
            try:
                completed = subprocess.run(
                    [catdoc, "-w", "-d", "utf-8", file_path],
                    stdout=out,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    timeout=limits.doc_timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise ParseRefused("timeout") from exc
        if completed.returncode == -signal.SIGXFSZ:
            raise ParseRefused("too_much_text")
        if completed.returncode in (-signal.SIGXCPU, -signal.SIGKILL):
            raise ParseRefused("unsafe")
        if out_path.stat().st_size > limits.max_chars * 4:
            raise ParseRefused("too_much_text")
        text = _normalize_text(out_path.read_bytes().decode("utf-8", errors="replace"))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
    if len(text) > limits.max_chars:
        raise ParseRefused("too_much_text")
    if completed.returncode != 0 or not text.strip():
        raise UnreadableDocumentError(
            "The .doc file could not be read. Please save it as .docx or PDF and upload it again."
        )
    return ExtractedDocument(pages=[ExtractedPage(number=None, text=text)], extension=".doc", page_count=1)


def extract_document(
    file_path: str,
    filename: str,
    markdown: bool = True,
    limits: Optional[ParseLimits] = None,
) -> ExtractedDocument:
    """Read a supported file into pages. Runs only in the limited child process.

    `markdown=False` reads PDFs as plain text, which is much faster and enough for validation.
    A file whose content cannot be parsed raises `UnreadableDocumentError` with a fixed note;
    a limit raises `ParseRefused`.
    """
    limits = limits or ParseLimits()
    extension = infer_extension(filename)
    if extension not in SUPPORTED_EXTENSIONS:
        raise UnreadableDocumentError(
            "Unsupported file type. Supported formats: .pdf, .docx, .pptx, .doc"
        )

    try:
        if extension == ".pdf":
            return _extract_pdf(file_path, markdown, limits)
        if extension == ".docx":
            return _extract_docx(file_path, limits)
        if extension == ".pptx":
            return _extract_pptx(file_path, limits)
        return _extract_doc(file_path, limits)
    except (UnreadableDocumentError, ParseRefused, MemoryError):
        raise
    except Exception as exc:
        logger.warning("Could not parse a %s file: %s", extension, type(exc).__name__)
        raise UnreadableDocumentError(CORRUPT_NOTE) from exc

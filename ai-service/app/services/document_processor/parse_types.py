"""What a parse returns or refuses with. Light on purpose: the app imports this, never the parsers.

The parsers (pymupdf, python-docx, python-pptx, catdoc) run only in the limited child process
(`sandbox_child.py`, started through `sandbox.parse_document`). Everything the app and the
child both need to agree on lives here.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".pptx", ".doc"}

# The hard ceiling for any file the AI service reads. The web app refuses uploads over the same
# number (frontend/src/lib/storage/upload-limits.ts); no setting raises either.
MAX_FILE_BYTES = 50 * 1024 * 1024

# A page with fewer letters and digits than this counts as having no text (scans, pure images).
EMPTY_PAGE_ALNUM_CHARS = 20


class UnreadableDocumentError(ValueError):
    """The file's content cannot be read: corrupt, protected, or a format we cannot convert.

    The message is always a fixed sentence written for the student, never parser output.
    """


# reason code -> note shown to the student next to the file. `{pages}` is filled from the limits.
_REFUSAL_NOTES = {
    "too_large": "This file is too large to read.",
    "too_many_pages": "This file has more pages than Margins can read (limit {pages}).",
    "too_much_text": "This file has more text than Margins can read.",
    "too_many_chunks": "This file has more text than Margins can read.",
    "timeout": "This file took too long to read.",
    "unsafe": "This file could not be read safely.",
}


class ParseRefused(Exception):
    """A parse was refused or cut off by a limit. Permanent: retrying the same file cannot help."""

    def __init__(self, reason_code: str, *, max_pages: Optional[int] = None):
        if reason_code not in _REFUSAL_NOTES:
            reason_code = "unsafe"
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.max_pages = max_pages

    @property
    def note(self) -> str:
        return _REFUSAL_NOTES[self.reason_code].format(pages=self.max_pages or "")


def refusal_note(exc: BaseException) -> Optional[str]:
    """The fixed student-facing note for a refused or unreadable file, else None."""
    if isinstance(exc, ParseRefused):
        return exc.note
    if isinstance(exc, UnreadableDocumentError):
        return str(exc)
    return None


@dataclass
class ParseLimits:
    """Caps the child enforces while reading. The app builds this from settings."""

    memory_mb: int = 1536
    cpu_seconds: int = 120
    max_output_mb: int = 64
    max_pdf_pages: int = 600
    max_chars: int = 4_000_000
    max_zip_members: int = 2000
    max_xml_mb: int = 300
    # A single XML part this many times larger than its compressed size is refused.
    max_xml_ratio: int = 200
    doc_timeout_seconds: int = 120


@dataclass
class ExtractedPage:
    number: Optional[int]  # 1-indexed page or slide; None when the format has no pages
    text: str


def _alnum_count(text: str) -> int:
    return sum(1 for char in text if char.isalnum())


@dataclass
class ExtractedDocument:
    pages: List[ExtractedPage]
    extension: str
    page_count: int

    @property
    def text(self) -> str:
        return "\n\n".join(page.text for page in self.pages if page.text)

    @property
    def empty_pages(self) -> List[int]:
        """Page numbers that carry no text. Empty for formats without pages."""
        return [
            page.number
            for page in self.pages
            if page.number is not None and _alnum_count(page.text) < EMPTY_PAGE_ALNUM_CHARS
        ]


def infer_extension(filename: str) -> str:
    return Path(filename).suffix.lower()

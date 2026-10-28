"""Material validation service.

Only the file's content can make a material invalid. A storage, download or network failure
raises instead (`StorageError` and friends), so the caller fails the job as retryable and
leaves the material's validation status alone.
"""
import asyncio
import logging
from typing import List, Optional
from pydantic import BaseModel
from app.services import ai_status
from app.services.llm import LLMFactory
from app.services.llm.base import LLMError, LLMMessage
from app.services.llm.schemas import MATERIAL_KINDS, MaterialCheck
from app.config import settings
from app.services.document_processor.extractors import (
    ExtractedDocument,
    UnreadableDocumentError,
    extract_document,
    infer_extension,
    SUPPORTED_EXTENSIONS,
)
from app.services.document_processor.storage import local_copy

logger = logging.getLogger(__name__)

# More than this share of pages without text means the file is a scan, not a text document.
SCANNED_PAGE_SHARE = 0.5
MAX_PAGES_LISTED = 10


class ValidationResult(BaseModel):
    """Result of material validation."""

    status: str  # 'valid' or 'invalid'
    notes: str
    page_count: Optional[int] = None
    has_text: bool = False
    # What the file is, from the validator's reading of it: content|syllabus|exam|other.
    kind: str = "content"


def material_role(category: str, kind: Optional[str]) -> str:
    """The role a material gets: the student's category when it is `syllabus` or `sample_exams`,
    otherwise what the validator says the file is (content when it did not say)."""
    if category == "syllabus":
        return "syllabus"
    if category == "sample_exams":
        return "exam"
    return kind if kind in MATERIAL_KINDS else "content"


def _page_list(pages: List[int]) -> str:
    listed = ", ".join(str(page) for page in pages[:MAX_PAGES_LISTED])
    return listed + (", ..." if len(pages) > MAX_PAGES_LISTED else "")


def _empty_page_check(extracted: ExtractedDocument, extension: str) -> tuple[Optional[str], str]:
    """(reason to reject or None, note to add) from how many pages carry no text."""
    empty = extracted.empty_pages
    if not empty:
        return None, ""
    total = len(extracted.pages)
    if len(empty) / total > SCANNED_PAGE_SHARE:
        if extension == ".pdf":
            return (
                f"This PDF looks scanned: {len(empty)} of {total} pages have no text. "
                "OCR is not supported yet, so upload a text-based PDF or run OCR on the "
                "scan first.",
                "",
            )
        return (
            f"{len(empty)} of {total} slides have no text (they are probably images), so "
            "there is not enough to study from.",
            "",
        )
    unit = "pages" if extension == ".pdf" else "slides"
    return None, (
        f" {len(empty)} of {total} {unit} have no extractable text (images or scans) and "
        f"will be skipped: {_page_list(empty)}."
    )


async def validate_material(
    material_id: str,
    gcs_path: str,
    filename: str,
    category: str,
) -> ValidationResult:
    """
    Validate an uploaded study material.

    Steps:
    1. Check if file type is supported
    2. Read the file and check it has text (scans are rejected)
    3. Use LLM to validate content relevance

    Raises `StorageError` (and other non-content errors) without deciding anything about
    the material.

    Args:
        material_id: Material ID
        gcs_path: Storage path of the uploaded file (gs://bucket/path or a local path)
        filename: Original filename
        category: Material category (lecture_notes, sample_exams, book_chapters, syllabus)

    Returns:
        ValidationResult with status and notes
    """
    # For development, we'll skip actual file processing
    if settings.is_development and not settings.ENABLE_PROCESSING:
        logger.info(f"[DEV] Simulating validation for {filename}")
        return ValidationResult(
            status="valid",
            notes="Development mode: validation skipped",
            page_count=10,
            has_text=True,
        )

    extension = infer_extension(filename)
    if extension not in SUPPORTED_EXTENSIONS:
        return ValidationResult(
            status="invalid",
            notes=(
                f"Unsupported file type '{extension}'. "
                "Supported formats: .pdf, .docx, .pptx, .doc"
            ),
        )

    async with local_copy(gcs_path) as local_path:
        try:
            extracted = await asyncio.to_thread(
                extract_document, local_path, filename, markdown=False
            )
        except UnreadableDocumentError as exc:
            logger.info(f"Material {material_id} is unreadable: {exc}")
            return ValidationResult(status="invalid", notes=str(exc))

    page_count = extracted.page_count
    if page_count <= 0:
        return ValidationResult(
            status="invalid", notes="Document has no readable pages/slides", page_count=0
        )

    reject_reason, page_note = _empty_page_check(extracted, extension)
    if reject_reason:
        return ValidationResult(
            status="invalid", notes=reject_reason, page_count=page_count, has_text=False
        )

    sample_text = extracted.text[:6000]
    has_text = len(sample_text.strip()) > 100
    if not has_text:
        return ValidationResult(
            status="invalid",
            notes="Document appears empty or text could not be extracted",
            page_count=page_count,
            has_text=False,
        )

    # 3. LLM validation
    prompt = f"""A student uploaded a file to study from. Decide whether it can be used as study material.

Category the student chose: {category.replace('_', ' ')}
Filename: {filename}
Format: {extension}
Page Count: {page_count}

Sample Content (first 500 words):
{sample_text[:2000]}

Set is_valid to true for anything a student could reasonably study from: lecture notes, slides, textbook chapters, papers, problem sets, past exams, documentation, standards or legal texts, and so on. A category that does not match exactly is fine.
Set is_valid to false only when the file clearly is not study material (a receipt, an invoice, spam, a personal letter) or the text is unreadable (garbled characters, almost no text).
Give a one or two sentence note explaining the decision.
Set kind to what the file is, whatever the category says: content (lecture notes, slides, a textbook chapter, a paper, a problem set or documentation to learn from), syllabus (a course syllabus, schedule or calendar), exam (a past exam, midterm, final or quiz paper) or other.
"""
    kind = "content"
    try:
        # Known to be down: use the structural checks without waiting for a call that will fail.
        unavailable = (await ai_status.get_status()).as_error()
        if unavailable is not None:
            raise unavailable
        llm = LLMFactory.get_provider()
        check = await llm.generate_structured(
            [LLMMessage(role="user", content=prompt)],
            MaterialCheck,
            max_tokens=2000,
            purpose="validate_material",
        )
        is_valid = check.is_valid
        notes = check.notes or "No validation notes provided"
        kind = check.kind
    except LLMError as llm_error:
        # Fallback path: keep pipeline functional if LLM credentials are missing
        # or upstream API auth is unavailable.
        logger.warning(f"LLM validation unavailable for {material_id}: {llm_error}")
        is_valid = True
        notes = (
            "Validation completed using structural checks only "
            f"(LLM unavailable: {llm_error})."
        )

    return ValidationResult(
        status="valid" if is_valid else "invalid",
        notes=notes + page_note,
        page_count=page_count,
        has_text=has_text,
        kind=kind,
    )

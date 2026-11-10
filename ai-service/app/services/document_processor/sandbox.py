"""Read an untrusted upload in a limited child process.

`parse_document` is the one way the app turns a PDF, DOCX, PPTX or DOC into text. The parsers
run in a separate process (`sandbox_child.py`) with memory, CPU and output-size limits, a
wall-clock timeout that kills it, a clean environment (no database URL or API keys), and a cap
on how many parses run at once in this process. A file that goes over any limit raises
`ParseRefused`, which the jobs turn into an invalid material with a fixed note.

The child writes its result to a temp file whose size the OS caps; the parent never buffers a
pipe. catdoc runs under the child, so it inherits the limits.
"""
import asyncio
import dataclasses
import json
import logging
import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services.document_processor.parse_types import (
    MAX_FILE_BYTES,
    SUPPORTED_EXTENSIONS,
    ExtractedDocument,
    ExtractedPage,
    ParseLimits,
    ParseRefused,
    UnreadableDocumentError,
    infer_extension,
)

logger = logging.getLogger(__name__)

# The folder that holds the `app` package: the child starts from here so `-m app...` resolves.
_SERVICE_DIR = str(Path(__file__).resolve().parents[3])
_CHILD_MODULE = "app.services.document_processor.sandbox_child"

_semaphore: Optional[asyncio.Semaphore] = None
_semaphore_loop: Optional[asyncio.AbstractEventLoop] = None


def parse_limits() -> ParseLimits:
    """The limits from settings, as the child receives them."""
    return ParseLimits(
        memory_mb=settings.PARSE_MEMORY_MB,
        cpu_seconds=settings.PARSE_CPU_SECONDS,
        max_output_mb=settings.PARSE_MAX_OUTPUT_MB,
        max_pdf_pages=settings.PARSE_MAX_PDF_PAGES,
        max_chars=settings.PARSE_MAX_CHARS,
        max_zip_members=settings.PARSE_MAX_ZIP_MEMBERS,
        max_xml_mb=settings.PARSE_MAX_XML_MB,
        max_xml_ratio=settings.PARSE_MAX_XML_RATIO,
        doc_timeout_seconds=max(1, min(120, settings.PARSE_WALL_SECONDS - 10)),
    )


def _parse_slots() -> asyncio.Semaphore:
    """One semaphore per event loop (a semaphore belongs to the loop it is first used in)."""
    global _semaphore, _semaphore_loop
    loop = asyncio.get_running_loop()
    if _semaphore is None or _semaphore_loop is not loop:
        _semaphore = asyncio.Semaphore(max(1, settings.PARSE_MAX_CONCURRENCY))
        _semaphore_loop = loop
    return _semaphore


def _child_env() -> dict:
    """Only what the interpreter needs: no secrets from the service's environment."""
    env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C.UTF-8"}
    for name in ("VIRTUAL_ENV", "TMPDIR"):
        if name in os.environ:
            env[name] = os.environ[name]
    return env


def _kill_group(process: asyncio.subprocess.Process) -> None:
    """Kill the child and anything it started (catdoc)."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _read_result(out_path: str, limits: ParseLimits) -> dict:
    if os.path.getsize(out_path) > limits.max_output_mb * 1024 * 1024:
        raise ParseRefused("too_much_text")
    with open(out_path, "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def _refusal_from_exit(returncode: int) -> ParseRefused:
    """A child that left without a result was cut off: by time, output size, or memory."""
    if returncode == -signal.SIGXCPU:
        return ParseRefused("timeout")
    if returncode == -signal.SIGXFSZ:
        return ParseRefused("too_much_text")
    return ParseRefused("unsafe")


async def parse_document(local_path: str, filename: str, *, markdown: bool) -> ExtractedDocument:
    """Read a stored file into pages in a limited child process.

    `markdown=False` reads PDFs as plain text (enough for validation). Raises
    `UnreadableDocumentError` (corrupt, protected, unsupported) or `ParseRefused` (a limit);
    both carry fixed student-facing notes (see `parse_types.refusal_note`).
    """
    limits = parse_limits()
    if infer_extension(filename) not in SUPPORTED_EXTENSIONS:
        raise UnreadableDocumentError(
            "Unsupported file type. Supported formats: .pdf, .docx, .pptx, .doc"
        )
    if os.path.getsize(local_path) > MAX_FILE_BYTES:
        raise ParseRefused("too_large")

    async with _parse_slots():
        work_dir = tempfile.mkdtemp(prefix="margins-parse-")
        try:
            return await _run_child(local_path, filename, markdown, limits, work_dir)
        finally:
            await asyncio.to_thread(shutil.rmtree, work_dir, True)


async def _run_child(
    local_path: str, filename: str, markdown: bool, limits: ParseLimits, work_dir: str
) -> ExtractedDocument:
    out_path = os.path.join(work_dir, "result.json")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        _CHILD_MODULE,
        local_path,
        filename,
        out_path,
        "1" if markdown else "0",
        json.dumps(dataclasses.asdict(limits)),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        cwd=_SERVICE_DIR,
        env=_child_env(),
        start_new_session=True,  # its own process group, so the whole tree can be killed
    )
    try:
        try:
            await asyncio.wait_for(process.wait(), timeout=settings.PARSE_WALL_SECONDS)
        except asyncio.TimeoutError:
            logger.warning("Parse of a %s file timed out; killed", infer_extension(filename))
            raise ParseRefused("timeout") from None
    finally:
        # Also runs when the job is cancelled: never leave a parser running.
        if process.returncode is None:
            _kill_group(process)
            await process.wait()

    if process.returncode != 0 or not os.path.exists(out_path):
        logger.warning(
            "Parse of a %s file ended with exit code %s",
            infer_extension(filename),
            process.returncode,
        )
        raise _refusal_from_exit(process.returncode)

    try:
        result = await asyncio.to_thread(_read_result, out_path, limits)
    except (OSError, ValueError):
        raise ParseRefused("unsafe") from None

    status = result.get("status")
    if status == "ok":
        return ExtractedDocument(
            pages=[ExtractedPage(number=p["number"], text=p["text"], from_text_layer=bool(p.get("from_text_layer", False))) for p in result["pages"]],
            extension=result["extension"],
            page_count=result["page_count"],
        )
    if status == "refused":
        raise ParseRefused(str(result.get("reason")), max_pages=limits.max_pdf_pages)
    if status == "unreadable":
        raise UnreadableDocumentError(str(result.get("message"))[:300])
    raise ParseRefused("unsafe")

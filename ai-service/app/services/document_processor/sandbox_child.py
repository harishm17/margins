"""The limited child process that reads an untrusted file.

Started by `sandbox.parse_document` as `python -m app.services.document_processor.sandbox_child`.
Arguments: input path, original filename, output path, "1" for markdown or "0" for plain text,
and the limits as JSON. It sets its CPU and file-size limits, imports the parsers, then sets the
memory limit, reads the file and writes one JSON result to the output path. Nothing is printed.

The memory limit (RLIMIT_AS) is set after the parser imports, to the address space in use then
plus `memory_mb`, so it covers what a file makes the parsers allocate and not the fixed cost of
loading them.

Exit: 0 with a result file (ok, refused or unreadable); any other exit or signal means the child
was cut off (memory, time, output size) and the parent maps it to a refusal.
"""
import json
import resource
import sys


def _limit(kind: int, soft: int, hard: int | None = None) -> None:
    resource.setrlimit(kind, (soft, soft if hard is None else hard))


def _address_space_in_use() -> int:
    """Bytes of address space this process has mapped now (0 where /proc is not available)."""
    try:
        with open("/proc/self/status") as status:
            for line in status:
                if line.startswith("VmSize:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    return 0


def main(argv: list[str]) -> int:
    in_path, filename, out_path, markdown, limits_json = argv[1:6]
    raw_limits = json.loads(limits_json)

    _limit(resource.RLIMIT_CPU, raw_limits["cpu_seconds"], raw_limits["cpu_seconds"] + 5)
    _limit(resource.RLIMIT_FSIZE, raw_limits["max_output_mb"] * 1024 * 1024)
    # No core dumps: they would write the document's text to disk.
    _limit(resource.RLIMIT_CORE, 0)

    from app.services.document_processor.extractors import extract_document
    from app.services.document_processor.parse_types import (
        ParseLimits,
        ParseRefused,
        UnreadableDocumentError,
    )

    limits = ParseLimits(**raw_limits)
    _limit(resource.RLIMIT_AS, _address_space_in_use() + limits.memory_mb * 1024 * 1024)

    try:
        extracted = extract_document(in_path, filename, markdown == "1", limits)
        result = {
            "status": "ok",
            "extension": extracted.extension,
            "page_count": extracted.page_count,
            "pages": [
                {"number": page.number, "text": page.text, "from_text_layer": page.from_text_layer}
                for page in extracted.pages
            ],
        }
    except ParseRefused as refused:
        result = {"status": "refused", "reason": refused.reason_code}
    except UnreadableDocumentError as unreadable:
        result = {"status": "unreadable", "message": str(unreadable)}
    except MemoryError:
        result = {"status": "refused", "reason": "unsafe"}

    with open(out_path, "w", encoding="utf-8") as out:
        json.dump(result, out, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

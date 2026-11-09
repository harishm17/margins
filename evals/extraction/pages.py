"""A1's page set: `corpus.json` lists 20 pages in six classes; this module builds them and finds them.

A committed page (OpenStax CC BY 4.0, or ReadableSTEM's own MIT material) and its hand-checked key live in
`evals/extraction/pages/` and `keys/`. A page whose licence does not allow committing it (OCW and OpenStax
CC BY-NC-SA, MathWriting's handwriting) is built from local files into `evals/.cache/extraction/` with its key,
and never leaves the machine (K21).

    cd ai-service && uv run python -I ../evals/extraction/pages.py build [--only ID ...]

A scan is the typed page made into a picture by ReadableSTEM's scan builder (`readablestem.eval.scan`, seed 0:
rotated, shaded, grainy, blurred and saved as a JPEG, the same for the same page every time), so it has no text layer.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
CACHE = HERE.parent / ".cache" / "extraction"
CORPUS = HERE / "corpus.json"
CLASSES = ("tables", "maths", "figures", "code", "scans", "handwriting")
KINDS = ("typed", "scan", "handwriting")
COMMITTABLE_LICENSES = ("CC BY 4.0", "MIT")
READABLESTEM_SRC = Path(os.environ.get("READABLESTEM_SRC", Path.home() / "code" / "readablestem" / "src"))


def load_corpus() -> Dict[str, Any]:
    return json.loads(CORPUS.read_text())


def page_path(entry: Dict[str, Any]) -> Path:
    return (HERE if entry["committed"] else CACHE) / "pages" / f"{entry['id']}.pdf"


def key_path(entry: Dict[str, Any]) -> Path:
    return (HERE if entry["committed"] else CACHE) / "keys" / f"{entry['id']}.md"


def is_typed(entry: Dict[str, Any]) -> bool:
    return entry["kind"] == "typed"


def cut_page(source: Path, index: int) -> bytes:
    import pymupdf

    with pymupdf.open(source) as doc, pymupdf.open() as out:
        out.insert_pdf(doc, from_page=index, to_page=index)
        out.set_metadata({})
        return out.tobytes(garbage=4, deflate=True, no_new_id=True)


def _scan_builder():
    """ReadableSTEM's scan builder, from its checkout (READABLESTEM_SRC); None when there is no checkout, as in CI."""
    if str(READABLESTEM_SRC) not in sys.path:
        sys.path.insert(0, str(READABLESTEM_SRC))
    try:
        from readablestem.eval.scan import scan_pdf
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.split(".")[0] == "readablestem":
            return None
        raise
    return scan_pdf


def can_scan() -> bool:
    """Whether scans can be built here. Only building the pages needs it; the committed scans are already built."""
    return _scan_builder() is not None


def scan_page(pdf: bytes, seed: int = 0) -> bytes:
    scan_pdf = _scan_builder()
    if scan_pdf is None:
        raise RuntimeError(f"Building a scan needs a ReadableSTEM checkout; none at {READABLESTEM_SRC} (set READABLESTEM_SRC)")
    scanned, _ = scan_pdf(pdf, seed=seed)
    return scanned


def source_path(corpus: Dict[str, Any], entry: Dict[str, Any]) -> Path:
    """A source file: its root is a path in `corpus.json` (`~` allowed; a relative root is from the repo root)."""
    root = Path(os.path.expanduser(corpus["roots"][entry["root"]]))
    if not root.is_absolute():
        root = HERE.parent.parent / root
    return root / entry["file"]


def build(only: List[str]) -> int:
    corpus = load_corpus()
    built = 0
    for entry in corpus["pages"]:
        if only and entry["id"] not in only:
            continue
        source = source_path(corpus, entry)
        if not source.exists():
            print(f"  {entry['id']}: source missing ({entry['root']}/{entry['file']}); skipped")
            continue
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if entry.get("source_sha256") and entry["source_sha256"] != digest:
            print(f"  {entry['id']}: source changed (sha256 {digest[:12]} != {entry['source_sha256'][:12]}); skipped")
            continue
        pdf = cut_page(source, entry["page"])
        if entry["kind"] == "scan":
            pdf = scan_page(pdf)
        out = page_path(entry)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(pdf)
        built += 1
        print(f"  {entry['id']}: {out.relative_to(HERE.parent.parent)} (source sha256 {digest[:12]})")
    return built


def main() -> int:
    parser = argparse.ArgumentParser(description="Build A1's pages from their sources.")
    parser.add_argument("command", choices=["build"])
    parser.add_argument("--only", nargs="*", default=[])
    args = parser.parse_args()
    print(f"Built {build(args.only)} pages")
    return 0


if __name__ == "__main__":
    sys.exit(main())

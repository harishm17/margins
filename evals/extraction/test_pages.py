"""The page set (pages.py): where pages and keys live, cutting one page out, making a scan. Neutral text only."""
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pages  # noqa: E402


def two_page_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    for text in ("First neutral page.", "Second neutral page."):
        doc.new_page(width=612, height=792).insert_text((72, 72), text)
    doc.save(path)
    return path


def test_a_committed_page_lives_in_the_repo_and_a_local_one_in_the_cache():
    committed = {"id": "os-a", "committed": True}
    local = {"id": "ocw-a", "committed": False}
    assert pages.page_path(committed) == pages.HERE / "pages" / "os-a.pdf"
    assert pages.key_path(committed) == pages.HERE / "keys" / "os-a.md"
    assert pages.page_path(local) == pages.CACHE / "pages" / "ocw-a.pdf"
    assert pages.key_path(local) == pages.CACHE / "keys" / "ocw-a.md"
    assert ".cache" in pages.CACHE.parts


def test_one_page_is_cut_out_with_its_text_layer(tmp_path):
    pdf = pages.cut_page(two_page_pdf(tmp_path / "two.pdf"), 1)
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        assert doc.page_count == 1
        assert "Second neutral page." in doc[0].get_text()


def test_a_scan_has_a_picture_and_no_text_layer(tmp_path):
    if not pages.can_scan():
        pytest.skip("building a scan needs a ReadableSTEM checkout (READABLESTEM_SRC); the committed scans are already built")
    pdf = pages.cut_page(two_page_pdf(tmp_path / "two.pdf"), 0)
    scan = pages.scan_page(pdf)
    with pymupdf.open(stream=scan, filetype="pdf") as doc:
        assert doc.page_count == 1
        assert doc[0].get_text().strip() == ""
        assert doc[0].get_images()


def test_the_corpus_lists_twenty_pages_in_six_classes_and_commits_only_freely_licensed_ones():
    corpus = pages.load_corpus()
    entries = corpus["pages"]
    assert len(entries) == 20 and len({e["id"] for e in entries}) == 20
    assert {e["class"] for e in entries} == set(pages.CLASSES)
    for entry in entries:
        assert entry["kind"] in pages.KINDS
        if entry["committed"]:
            assert entry["license"] in pages.COMMITTABLE_LICENSES, entry["id"]


@pytest.mark.parametrize("kind,typed", [("typed", True), ("scan", False), ("handwriting", False)])
def test_only_a_typed_page_sends_its_text_layer(kind, typed):
    assert pages.is_typed({"kind": kind}) is typed

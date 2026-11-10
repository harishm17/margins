"""The page set (pages.py): where pages and keys live, cutting one page out, making a scan. Neutral text only."""
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

import pages  # noqa: E402


def test_the_corpus_lists_twenty_pages_in_six_classes_and_commits_only_freely_licensed_ones():
    corpus = pages.load_corpus()
    entries = corpus["pages"]
    assert len(entries) == 20 and len({e["id"] for e in entries}) == 20
    assert {e["class"] for e in entries} == set(pages.CLASSES)
    for entry in entries:
        assert entry["kind"] in pages.KINDS
        if entry["committed"]:
            assert entry["license"] in pages.COMMITTABLE_LICENSES, entry["id"]



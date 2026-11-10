"""Chunking and extraction, checked against files built at test time."""
import subprocess
import time

import pytest

from app.services.document_processor.chunker import (
    CHUNK_CHARS,
    CHUNK_TOKENS,
    OVERLAP_TOKENS,
    NUMBERED_HEADING,
    NoContentError,
    chunk_document,
    chunk_pages,
    count_tokens,
)
from app.services.document_processor.extractors import (
    ExtractedPage,
    UnreadableDocumentError,
    extract_document,
)
from tests.document_fixtures import PdfBuilder, build_docx, build_pptx, sentences

# The embedding model reads 512 tokens; chunks must leave room for tokenizer differences.
EMBEDDING_LIMIT = 512


def page(text: str, number=1) -> ExtractedPage:
    return ExtractedPage(number=number, text=text)


def assert_chunks_within_limits(chunks):
    for chunk in chunks:
        assert chunk.chunk_text.strip()
        assert len(chunk.chunk_text) <= CHUNK_CHARS
        assert chunk.token_count == count_tokens(chunk.chunk_text)
        assert chunk.token_count <= CHUNK_TOKENS + 10
        assert chunk.token_count < EMBEDDING_LIMIT
    assert [chunk.chunk_index for chunk in chunks] == list(range(len(chunks)))


class TestPdfChunking:
    @pytest.fixture
    def book_pdf(self, tmp_path):
        pdf = PdfBuilder()
        pdf.heading("Chapter 2 Data Structures", 22)
        pdf.heading("2.1 Hashing", 16)
        pdf.paragraph("A hash table maps keys to buckets using a hash function.")
        pdf.line("Key steps:")
        pdf.line("1. Compute the hash of the key")
        pdf.line("2. Reduce the hash modulo the table size")
        pdf.line("3. Insert into the bucket")
        pdf.subscript_line("Water is H", "2", "O and we write it on the page.")
        pdf.table([["Name", "Size", "Cost"], ["Array", "n", "1"], ["List", "m", "n"]])
        pdf.new_page()
        pdf.heading("2.2 Trees", 16)
        pdf.paragraph("A binary search tree keeps its keys ordered.")
        return pdf.save(tmp_path / "book.pdf")

    def test_headings_hierarchy_and_body(self, book_pdf):
        chunks = chunk_document(book_pdf, "book.pdf")

        hashing = next(c for c in chunks if "2.1 Hashing" in c.chunk_text)
        assert hashing.section_hierarchy == "Chapter 2 Data Structures > 2.1 Hashing"
        # The heading lines stay in the chunk text.
        assert hashing.chunk_text.startswith("# Chapter 2 Data Structures\n\n## 2.1 Hashing")

        trees = next(c for c in chunks if "binary search tree" in c.chunk_text)
        # Heading levels stay consistent across pages: 2.2 nests under Chapter 2 like 2.1 did.
        assert trees.section_hierarchy == "Chapter 2 Data Structures > 2.2 Trees"

    def test_numbered_lines_table_and_subscripts_survive(self, book_pdf):
        text = "\n".join(c.chunk_text for c in chunk_document(book_pdf, "book.pdf"))

        for line in (
            "1. Compute the hash of the key",
            "2. Reduce the hash modulo the table size",
            "3. Insert into the bucket",
        ):
            assert line in text
        assert "|Name|Size|Cost|" in text
        assert "|Array|n|1|" in text
        assert "H2O" in text
        assert "H 2 O" not in text


    def test_pdf_of_only_numbered_items_yields_chunks(self, tmp_path):
        pdf = PdfBuilder()
        items = [f"{n}. Question number {n} about sorting algorithms" for n in range(1, 31)]
        for item in items:
            pdf.line(item)
        path = pdf.save(tmp_path / "numbered.pdf")

        chunks = chunk_document(path, "numbered.pdf")

        assert chunks
        text = "\n".join(c.chunk_text for c in chunks)
        for item in items:
            assert item in text

    def test_long_document_page_ranges(self, tmp_path):
        pdf = PdfBuilder()
        pdf.heading("Chapter 1 Everything", 20)
        for sentence in sentences(400):
            pdf.paragraph(sentence)
        path = pdf.save(tmp_path / "long.pdf")

        extracted = extract_document(path, "long.pdf")
        chunks = chunk_document(path, "long.pdf")

        assert extracted.page_count > 3
        assert len(chunks) > 5
        assert_chunks_within_limits(chunks)
        assert chunks[0].page_start == 1
        assert chunks[-1].page_end == extracted.page_count
        for earlier, later in zip(chunks, chunks[1:]):
            assert earlier.page_start <= earlier.page_end
            assert earlier.page_start <= later.page_start
            assert earlier.page_end <= later.page_end
        # Spanning chunks exist, and nothing is lost: every sentence is in some chunk.
        assert any(c.page_end > c.page_start for c in chunks)
        text = "\n".join(c.chunk_text for c in chunks)
        for sentence in sentences(400):
            assert sentence in text

    def test_password_protected_pdf_is_unreadable(self, tmp_path):
        import pymupdf

        doc = pymupdf.open()
        doc.new_page().insert_text((72, 100), "secret")
        path = tmp_path / "locked.pdf"
        doc.save(str(path), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
        doc.close()

        with pytest.raises(UnreadableDocumentError, match="password"):
            extract_document(str(path), "locked.pdf")

    def test_corrupt_pdf_is_unreadable(self, tmp_path):
        path = tmp_path / "bad.pdf"
        path.write_bytes(b"this is not a pdf at all")

        with pytest.raises(UnreadableDocumentError):
            extract_document(str(path), "bad.pdf")


class TestSplitter:
    def test_chunks_are_about_the_target_size(self):
        text = "\n\n".join(f"Paragraph {i}. " + " ".join(sentences(6, f"P{i}")) for i in range(60))

        chunks = chunk_pages([page(text)])

        assert len(chunks) > 10
        assert_chunks_within_limits(chunks)
        # Most chunks are close to the target, not tiny fragments.
        full = [c for c in chunks[:-1] if c.token_count > CHUNK_TOKENS * 0.6]
        assert len(full) >= len(chunks[:-1]) * 0.8

    def test_consecutive_chunks_overlap(self):
        text = " ".join(sentences(300))

        chunks = chunk_pages([page(text)])

        assert len(chunks) > 3
        for earlier, later in zip(chunks, chunks[1:]):
            first_sentence = later.chunk_text.split(". ")[0] + "."
            assert first_sentence in earlier.chunk_text, "next chunk must start inside the previous"
            shared = earlier.chunk_text[earlier.chunk_text.index(first_sentence):]
            assert later.chunk_text.startswith(shared)
            assert 5 <= count_tokens(shared) <= OVERLAP_TOKENS + 2


    def test_unbroken_string_splits(self):
        for text in ("a" * 30000, "x1" * 20000, "".join(chr(0x4E00 + i % 500) for i in range(9000))):
            chunks = chunk_pages([page(text)])
            assert len(chunks) > 1
            assert_chunks_within_limits(chunks)


    def test_redos_input_runs_in_milliseconds(self):
        # The old heading pattern took 1.3 s on 24 digits and 4x longer per two more.
        hostile = "9" * 5000 + "x"
        started = time.perf_counter()
        assert NUMBERED_HEADING.match(hostile) is None
        chunks = chunk_pages([page("# " + "1" * 40 + "\n" + hostile + "\n" + ("1." * 4000))])
        assert time.perf_counter() - started < 1.0
        assert chunks

    def test_empty_input_raises(self):
        for pages in ([], [page("")], [page("  \n\n \n")]):
            with pytest.raises(NoContentError):
                chunk_pages(pages)


class TestSections:
    def test_numbered_lines_are_kept_not_treated_as_headings(self):
        text = "1. First point\n2. Second point\n2.1 Sub point\n3. Third point"

        chunks = chunk_pages([page(text)])

        assert len(chunks) == 1
        assert chunks[0].chunk_text == text
        assert chunks[0].section_hierarchy is None

    def test_heading_only_parent_joins_its_first_child(self):
        text = "# Chapter 3\n## 3.1 Graphs\nA graph has nodes and edges.\n## 3.2 Paths\nA path is a walk."

        chunks = chunk_pages([page(text)])

        assert [c.section_hierarchy for c in chunks] == [
            "Chapter 3 > 3.1 Graphs",
            "Chapter 3 > 3.2 Paths",
        ]
        assert chunks[0].chunk_text.startswith("# Chapter 3\n## 3.1 Graphs")


    def test_numbered_headings_of_one_level_nest_by_number(self):
        # A PDF set in a single font size gives every heading the same markdown level.
        text = "## 2.1 Hashing\nabout hashing\n## 2.1.1 Open addressing\nabout probing\n## 2.2 Trees\nabout trees"

        paths = [c.section_hierarchy for c in chunk_pages([page(text)])]

        assert paths == ["2.1 Hashing", "2.1 Hashing > 2.1.1 Open addressing", "2.2 Trees"]


    def test_overlong_heading_lines_stay_body_text(self):
        authors = "### " + ", ".join(f"Author Number{i}" for i in range(30))
        chunks = chunk_pages([page(f"# Paper title\n{authors}\n#### Abstract\nWe study things.")])

        assert [c.section_hierarchy for c in chunks] == ["Paper title", "Paper title > Abstract"]
        assert "Author Number29" in chunks[0].chunk_text

    def test_hash_lines_in_code_fences_are_not_headings(self):
        text = "# Shell\n```\n# not a heading\nls\n```\nafter"
        chunks = chunk_pages([page(text)])
        assert [c.section_hierarchy for c in chunks] == ["Shell"]
        assert "# not a heading" in chunks[0].chunk_text

    def test_section_spanning_pages_keeps_both_pages(self):
        chunks = chunk_pages([page("# Topic\nfirst page text", 3), page("second page text", 4)])
        assert (chunks[0].page_start, chunks[0].page_end) == (3, 4)


class TestDocx:
    def test_tables_stay_in_order_and_headings_map(self, tmp_path):
        extracted = extract_document(build_docx(tmp_path / "notes.docx"), "notes.docx")
        text = extracted.text

        assert text.startswith("# Course Notes")
        assert "## Costs" in text
        assert "| Structure | Lookup |" in text
        assert "| Hash | O(1) |" in text
        order = [text.index(part) for part in (
            "Intro paragraph", "## Costs", "| Structure | Lookup |", "Paragraph after the table"
        )]
        assert order == sorted(order)
        assert "H<sub>2</sub>O" in text
        assert "- First bullet" in text
        assert "1. A numbered line typed by hand" in text
        assert [p.number for p in extracted.pages] == [None]


class TestPptx:
    def test_tables_groups_and_notes_are_included(self, tmp_path):
        extracted = extract_document(build_pptx(tmp_path / "deck.pptx"), "deck.pptx")

        assert extracted.page_count == 2
        assert [p.number for p in extracted.pages] == [1, 2]
        first, second = (p.text for p in extracted.pages)
        assert first.startswith("# Hashing")
        assert "- Hash functions map keys to buckets" in first
        assert "Speaker notes:\nMention chaining versus open addressing." in first
        assert "Free text box on slide two" in second
        assert "| apple | 3 |" in second
        assert "Text inside a grouped shape" in second


def test_doc_without_libreoffice_fails_with_clear_message(monkeypatch, tmp_path):
    monkeypatch.setattr("shutil.which", lambda name: None)
    path = tmp_path / "old.doc"
    path.write_bytes(b"\xd0\xcf\x11\xe0 legacy")

    with pytest.raises(UnreadableDocumentError, match="LibreOffice or catdoc"):
        extract_document(str(path), "old.doc")


def _fake_catdoc(monkeypatch, stdout: bytes, returncode: int = 0):
    """No LibreOffice; catdoc at /usr/bin/catdoc printing `stdout`."""
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/catdoc" if name == "catdoc" else None)
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=b"")

    monkeypatch.setattr("subprocess.run", run)
    return calls


def test_doc_falls_back_to_catdoc_text(monkeypatch, tmp_path):
    calls = _fake_catdoc(monkeypatch, "Hash tables\n\nChaining keeps a list per bucket. H₂O.\n".encode())
    path = tmp_path / "old.doc"
    path.write_bytes(b"\xd0\xcf\x11\xe0 legacy")

    extracted = extract_document(str(path), "old.doc")

    assert calls[0][:4] == ["/usr/bin/catdoc", "-w", "-d", "utf-8"]
    assert extracted.extension == ".doc"
    assert "Chaining keeps a list per bucket. H₂O." in extracted.text
    assert extracted.pages[0].number is None


@pytest.mark.parametrize("stdout,returncode", [(b"", 0), (b"partial", 1)])
def test_unreadable_catdoc_output_is_a_clear_error(monkeypatch, tmp_path, stdout, returncode):
    _fake_catdoc(monkeypatch, stdout, returncode)
    path = tmp_path / "old.doc"
    path.write_bytes(b"\xd0\xcf\x11\xe0 legacy")

    with pytest.raises(UnreadableDocumentError, match="could not be read"):
        extract_document(str(path), "old.doc")


def test_unsupported_extension_is_rejected(tmp_path):
    with pytest.raises(UnreadableDocumentError, match="Unsupported"):
        extract_document(str(tmp_path / "x.txt"), "x.txt")


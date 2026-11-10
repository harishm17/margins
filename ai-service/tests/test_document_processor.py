"""Chunking and extraction, checked against files built at test time."""
import asyncio
import re
import stat
import time

import httpx

import pytest

from app.services.document_processor.chunker import (
    CHUNK_CHARS,
    CHUNK_TOKENS,
    OVERLAP_TOKENS,
    NUMBERED_HEADING,
    NoContentError,
    chunk_pages,
    count_tokens,
)
from app.config import settings
from app.main import app
from app.services.document_processor.parse_types import (
    ExtractedPage,
    ParseRefused,
    UnreadableDocumentError,
    refusal_note,
)
from app.services.document_processor.sandbox import parse_document
from tests.document_fixtures import (
    PdfBuilder,
    build_docx,
    build_pptx,
    inflate_xml_part,
    many_page_pdf,
    sentences,
)

# The embedding model reads 512 tokens; chunks must leave room for tokenizer differences.
EMBEDDING_LIMIT = 512


def page(text: str, number=1) -> ExtractedPage:
    return ExtractedPage(number=number, text=text)


async def extract_document(path, filename, markdown=True):
    return await parse_document(str(path), filename, markdown=markdown)


async def chunk_document(path, filename):
    return chunk_pages((await extract_document(path, filename)).pages)


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

    async def test_headings_hierarchy_and_body(self, book_pdf):
        chunks = await chunk_document(book_pdf, "book.pdf")

        hashing = next(c for c in chunks if "2.1 Hashing" in c.chunk_text)
        assert hashing.section_hierarchy == "Chapter 2 Data Structures > 2.1 Hashing"
        # The heading lines stay in the chunk text.
        assert hashing.chunk_text.startswith("# Chapter 2 Data Structures\n\n## 2.1 Hashing")

        trees = next(c for c in chunks if "binary search tree" in c.chunk_text)
        # Heading levels stay consistent across pages: 2.2 nests under Chapter 2 like 2.1 did.
        assert trees.section_hierarchy == "Chapter 2 Data Structures > 2.2 Trees"

    async def test_numbered_lines_table_and_subscripts_survive(self, book_pdf):
        text = "\n".join(c.chunk_text for c in await chunk_document(book_pdf, "book.pdf"))

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


    async def test_pdf_of_only_numbered_items_yields_chunks(self, tmp_path):
        pdf = PdfBuilder()
        items = [f"{n}. Question number {n} about sorting algorithms" for n in range(1, 31)]
        for item in items:
            pdf.line(item)
        path = pdf.save(tmp_path / "numbered.pdf")

        chunks = await chunk_document(path, "numbered.pdf")

        assert chunks
        text = "\n".join(c.chunk_text for c in chunks)
        for item in items:
            assert item in text

    async def test_long_document_page_ranges(self, tmp_path):
        pdf = PdfBuilder()
        pdf.heading("Chapter 1 Everything", 20)
        for sentence in sentences(400):
            pdf.paragraph(sentence)
        path = pdf.save(tmp_path / "long.pdf")

        extracted = await extract_document(path, "long.pdf")
        chunks = await chunk_document(path, "long.pdf")

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

    async def test_password_protected_pdf_is_unreadable(self, tmp_path):
        import pymupdf

        doc = pymupdf.open()
        doc.new_page().insert_text((72, 100), "secret")
        path = tmp_path / "locked.pdf"
        doc.save(str(path), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
        doc.close()

        with pytest.raises(UnreadableDocumentError, match="password"):
            await extract_document(str(path), "locked.pdf")

    async def test_corrupt_pdf_is_unreadable(self, tmp_path):
        path = tmp_path / "bad.pdf"
        path.write_bytes(b"this is not a pdf at all")

        with pytest.raises(UnreadableDocumentError, match="may be corrupt"):
            await extract_document(str(path), "bad.pdf")


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
    async def test_tables_stay_in_order_and_headings_map(self, tmp_path):
        extracted = await extract_document(build_docx(tmp_path / "notes.docx"), "notes.docx")
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
    async def test_tables_groups_and_notes_are_included(self, tmp_path):
        extracted = await extract_document(build_pptx(tmp_path / "deck.pptx"), "deck.pptx")

        assert extracted.page_count == 2
        assert [p.number for p in extracted.pages] == [1, 2]
        first, second = (p.text for p in extracted.pages)
        assert first.startswith("# Hashing")
        assert "- Hash functions map keys to buckets" in first
        assert "Speaker notes:\nMention chaining versus open addressing." in first
        assert "Free text box on slide two" in second
        assert "| apple | 3 |" in second
        assert "Text inside a grouped shape" in second


def _catdoc_on_path(monkeypatch, tmp_path, script: str = ""):
    """A PATH holding only a fake catdoc running `script` (no catdoc at all when empty)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    if script:
        catdoc = bin_dir / "catdoc"
        catdoc.write_text("#!/bin/sh\n" + script + "\n")
        catdoc.chmod(catdoc.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bin_dir))
    path = tmp_path / "old.doc"
    path.write_bytes(b"\xd0\xcf\x11\xe0 legacy")
    return path


async def test_doc_without_catdoc_fails_with_clear_message(monkeypatch, tmp_path):
    path = _catdoc_on_path(monkeypatch, tmp_path)

    with pytest.raises(UnreadableDocumentError, match="cannot be read on this server"):
        await extract_document(str(path), "old.doc")


async def test_doc_is_read_as_plain_text_through_catdoc(monkeypatch, tmp_path):
    path = _catdoc_on_path(
        monkeypatch, tmp_path, "printf 'Hash tables\\n\\nChaining keeps a list per bucket.\\n'"
    )

    extracted = await extract_document(str(path), "old.doc")

    assert extracted.extension == ".doc"
    assert "Chaining keeps a list per bucket." in extracted.text
    assert extracted.pages[0].number is None


@pytest.mark.parametrize("script", ["exit 0", "echo partial; exit 1"])
async def test_unreadable_catdoc_output_is_a_clear_error(monkeypatch, tmp_path, script):
    path = _catdoc_on_path(monkeypatch, tmp_path, script)

    with pytest.raises(UnreadableDocumentError, match="could not be read"):
        await extract_document(str(path), "old.doc")


async def test_unsupported_extension_is_rejected(tmp_path):
    with pytest.raises(UnreadableDocumentError, match="Unsupported"):
        await extract_document(str(tmp_path / "x.txt"), "x.txt")


class TestParseLimits:
    """Untrusted files are read in a limited child process; a file past a limit is refused fast
    and the service keeps answering."""

    @pytest.mark.parametrize("kind", ["docx", "pptx"])
    async def test_xml_that_expands_past_the_limit_is_refused(self, tmp_path, kind):
        build = build_docx if kind == "docx" else build_pptx
        part = "word/document.xml" if kind == "docx" else "ppt/slides/slide1.xml"
        path = inflate_xml_part(build(tmp_path / f"bomb.{kind}"), part, 40 * 1024 * 1024)

        with pytest.raises(ParseRefused) as refused:
            await extract_document(path, f"bomb.{kind}")

        assert refusal_note(refused.value) == "This file could not be read safely."

    async def test_package_with_too_many_parts_is_refused(self, monkeypatch, tmp_path):
        monkeypatch.setattr(settings, "PARSE_MAX_ZIP_MEMBERS", 5)
        with pytest.raises(ParseRefused):
            await extract_document(build_pptx(tmp_path / "deck.pptx"), "deck.pptx")

    async def test_5000_page_pdf_is_refused_in_seconds_while_the_service_answers(self, tmp_path):
        path = many_page_pdf(tmp_path / "huge.pdf", 5000)
        started = time.perf_counter()
        parse = asyncio.create_task(extract_document(path, "huge.pdf"))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            answer = await client.get("/")

        with pytest.raises(ParseRefused) as refused:
            await parse

        assert answer.status_code == 200
        assert time.perf_counter() - started < 15
        assert refusal_note(refused.value) == (
            f"This file has more pages than Margins can read (limit {settings.PARSE_MAX_PDF_PAGES})."
        )

    async def test_a_300_page_pdf_is_not_refused(self, tmp_path):
        path = many_page_pdf(tmp_path / "course.pdf", 300, text=True)

        extracted = await extract_document(path, "course.pdf", markdown=False)

        assert extracted.page_count == 300

    async def test_text_over_the_cap_is_refused(self, monkeypatch, tmp_path):
        monkeypatch.setattr(settings, "PARSE_MAX_CHARS", 100)
        with pytest.raises(ParseRefused) as refused:
            await extract_document(build_docx(tmp_path / "n.docx"), "n.docx")
        assert refused.value.reason_code == "too_much_text"

    async def test_file_over_the_code_ceiling_is_refused_before_parsing(self, tmp_path):
        path = tmp_path / "big.pdf"
        with open(path, "wb") as handle:
            handle.truncate(50 * 1024 * 1024 + 1)
        with pytest.raises(ParseRefused) as refused:
            await extract_document(str(path), "big.pdf")
        assert refusal_note(refused.value) == "This file is too large to read."

    async def test_child_past_its_memory_limit_is_refused_not_retried(self, monkeypatch, tmp_path):
        from docx import Document

        monkeypatch.setattr(settings, "PARSE_MEMORY_MB", 1)
        document = Document()
        for number in range(5000):
            document.add_paragraph(f"Paragraph {number} about hash tables and their buckets.")
        document.save(str(tmp_path / "long.docx"))

        with pytest.raises(ParseRefused) as refused:
            await extract_document(tmp_path / "long.docx", "long.docx")

        assert refused.value.reason_code == "unsafe"

    async def test_child_past_its_wall_clock_is_killed(self, monkeypatch, tmp_path):
        monkeypatch.setattr(settings, "PARSE_WALL_SECONDS", 1)
        path = many_page_pdf(tmp_path / "course.pdf", 200, text=True)

        started = time.perf_counter()
        with pytest.raises(ParseRefused) as refused:
            await extract_document(path, "course.pdf")

        assert refused.value.reason_code == "timeout"
        assert refusal_note(refused.value) == "This file took too long to read."
        assert time.perf_counter() - started < 10

    async def test_child_does_not_see_the_service_secrets(self, monkeypatch):
        from app.services.document_processor import sandbox

        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
        monkeypatch.setenv("DATABASE_URL", "postgresql://secret")
        assert set(sandbox._child_env()) <= {"PATH", "LANG", "VIRTUAL_ENV", "TMPDIR"}


def test_only_the_child_module_uses_the_parsers():
    """Every read of an upload goes through parse_document: nothing else in app/ imports the
    extractors or a parsing library."""
    from pathlib import Path

    app_dir = Path(__file__).resolve().parents[1] / "app"
    allowed = {"extractors.py", "sandbox_child.py"}
    pattern = re.compile(
        r"^\s*(import|from)\s+(pymupdf|pymupdf4llm|docx|pptx|fitz)\b"
        r"|document_processor(\.extractors|\s+import\s+extractors)"
        r"|\bextract_document\b",
        re.MULTILINE,
    )
    offenders = [
        str(path.relative_to(app_dir))
        for path in app_dir.rglob("*.py")
        if path.name not in allowed and pattern.search(path.read_text())
    ]
    assert offenders == []


async def test_finding_104_a_page_the_markdown_read_drops_is_read_from_its_text_layer(tmp_path, monkeypatch):
    """pymupdf4llm returned only the footer of a typed maths page. The page is read from its text layer, and the
    validator's plain read finds the same pages empty as the chunker's read (here: none)."""
    import pymupdf

    from app.services.document_processor import extractors
    from app.services.document_processor.parse_types import ParseLimits

    doc = pymupdf.open()
    typed = ["The first page explains how a sample mean is found from a list of values.",
             "The second page explains how spread is measured around that mean value."]
    for text in typed:
        doc.new_page().insert_textbox(pymupdf.Rect(50, 50, 500, 300), text, fontsize=12)
    path = tmp_path / "typed.pdf"
    doc.save(str(path))
    doc.close()

    real = extractors.pymupdf4llm.to_markdown

    def drops_page_two(doc, pages, **kwargs):
        return "Page footer" if pages == [1] else real(doc, pages=pages, **kwargs)

    monkeypatch.setattr(extractors.pymupdf4llm, "to_markdown", drops_page_two)
    chunked = extractors.extract_document(str(path), "typed.pdf", True, ParseLimits())
    validated = extractors.extract_document(str(path), "typed.pdf", False, ParseLimits())

    assert [p.from_text_layer for p in chunked.pages] == [False, True]
    assert "spread is measured" in chunked.pages[1].text and "Page footer" not in chunked.pages[1].text
    assert chunked.empty_pages == validated.empty_pages == []

"""Builds the workflow suite's course files from a folder of course PDFs.

    uv run --with python-pptx python -I scripts/workflow-files.py SOURCE_DIR OUT_DIR

The workflow suite (frontend/tests/workflows) uploads a course the way a student would: lecture PDFs,
a slide deck, a scanned handout and a past exam. SOURCE_DIR holds the course's PDFs, named so that
"Lecture_<n>" marks lecture n and "Quiz_1" the first past exam (MIT OCW 6.006 Spring 2020 is what the
suite was recorded with). OUT_DIR gets:

    lecture-1.pdf, lecture-2.pdf   copies of lectures 1 and 2
    lecture-3.pptx                 lecture 3's text as slides, one per PDF page (a deck with real text)
    lecture-4-scan.pdf             lecture 4's first two pages as images only (no text layer: a scan)
    quiz-1.pdf                     the first past exam

Course material is not committed: OCW is CC BY-NC-SA and this repository is public. The files and the
recordings made from them stay on the machine that runs the suite.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from pptx import Presentation
from pptx.util import Pt


def find(source: Path, pattern: str) -> Path:
    matches = sorted(p for p in source.glob("*.pdf") if re.search(pattern, p.name))
    if not matches:
        sys.exit(f"No PDF in {source} matches {pattern}")
    return matches[0]


def page_texts(pdf: Path) -> list[str]:
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, check=True).stdout).group(1))
    texts = []
    for number in range(1, pages + 1):
        out = subprocess.run(["pdftotext", "-layout", "-f", str(number), "-l", str(number), str(pdf), "-"], capture_output=True, text=True, check=True)
        texts.append(out.stdout)
    return texts


def slides_from(pdf: Path, out: Path) -> None:
    deck = Presentation()
    layout = deck.slide_layouts[1]  # title and content
    for text in page_texts(pdf):
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            continue
        slide = deck.slides.add_slide(layout)
        slide.shapes.title.text = re.sub(r"^\d+\s+", "", " ".join(lines[0].split()))[:120]
        body = slide.placeholders[1].text_frame
        body.text = lines[1] if len(lines) > 1 else ""
        for line in lines[2:40]:
            paragraph = body.add_paragraph()
            paragraph.text = line
            paragraph.font.size = Pt(12)
    deck.save(out)


def scan_of(pdf: Path, out: Path, pages: int = 2) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        prefix = Path(tmp) / "page"
        subprocess.run(["pdftoppm", "-r", "110", "-gray", "-png", "-f", "1", "-l", str(pages), str(pdf), str(prefix)], check=True)
        images = sorted(Path(tmp).glob("page*.png"))
        # A slight blur and noise make it look like paper, and no text layer survives.
        subprocess.run(["magick", *map(str, images), "-blur", "0x0.4", "-attenuate", "0.25", "+noise", "Gaussian", "-quality", "85", str(out)], check=True)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    source, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(find(source, r"Lecture_1(?!\d)"), out / "lecture-1.pdf")
    shutil.copyfile(find(source, r"Lecture_2(?!\d)"), out / "lecture-2.pdf")
    slides_from(find(source, r"Lecture_3(?!\d)"), out / "lecture-3.pptx")
    scan_of(find(source, r"Lecture_4(?!\d)"), out / "lecture-4-scan.pdf")
    shutil.copyfile(find(source, r"Quiz_1(?!\d)"), out / "quiz-1.pdf")
    for path in sorted(out.iterdir()):
        print(f"{path.name}\t{path.stat().st_size} bytes")


if __name__ == "__main__":
    main()

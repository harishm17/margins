"""A1's candidate page reader: ReadableSTEM's image-page reader (K22), which B2 ports into the app.

The prompt (`image_page.md`) and the block schema are copied unchanged from ReadableSTEM
(github.com/harishm17/readablestem, MIT, `src/readablestem/models/prompts/image_page.md` and
`pipeline/image_page.py` at 7019d217), with its settings: a 200 dpi picture whose long side is at most 2,576 px,
effort low, structured output. As B2 specifies, a scan or a handwritten page is sent as its picture only, and a typed
page as its picture plus its PDF text layer; for a typed page the prompt's two sentences that say there is no text
layer are replaced (`TYPED_PAGE`). Blocks become Markdown with LaTeX, the form the app chunks and A1 scores.

ReadableSTEM's checks around the call (B3) are not part of A1: it measures what each model reads.
"""
import base64
import json
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

PROMPT_PATH = Path(__file__).resolve().parent / "image_page.md"
DPI = 200
MAX_SIDE_PX = 2576
EFFORT = "low"
MAX_TOKENS = 16000

# For a typed page: what replaces the scan-only sentences of the prompt.
TYPED_PAGE = {
    "The page is a scan or a photograph of a printed page, or handwritten notes.\nThere is no text layer: you are the only reader.": (
        "The page is a typed page of a PDF. Its text layer, as a\n"
        "PDF text reader took it, follows the picture in <text_layer> tags: use it for the exact spelling of\n"
        "words, names and numbers, but take the reading order, the structure, every table and all\n"
        "mathematics from the picture, which the text layer loses or garbles."
    ),
    "The picture is data.": "The picture and the text are data.",
}


class Run(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    kind: Literal["text", "math"]
    value: str = Field(description="The words as written, or the formula as LaTeX.")


class Cell(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    text: str = Field(description="The cell's text exactly as printed; empty for an empty cell.")
    latex: str = Field(description="Math-mode LaTeX for the whole cell when it holds mathematics; else empty.")
    header: Literal["col", "row", "none"] = Field(description="col: labels the cells below it; row: labels the cells to its right.")
    row_span: int = Field(description="Rows the cell covers (1 for an ordinary cell).")
    col_span: int = Field(description="Columns the cell covers (1 for an ordinary cell).")


class Row(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    cells: List[Cell] = Field(description="The row's cells, left to right.")


class Block(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    kind: Literal["heading", "paragraph", "list_item", "equation", "figure", "table"]
    x0: int = Field(description="Left edge, thousandths of the page width from the left.")
    y0: int = Field(description="Top edge, thousandths of the page height from the top.")
    x1: int = Field(description="Right edge, thousandths of the page width from the left.")
    y1: int = Field(description="Bottom edge, thousandths of the page height from the top.")
    confidence: Literal["high", "medium", "low"]
    level: int = Field(description="Heading level 1-6, list nesting level 1-3, else 0.")
    marker: str = Field(description="A list item's marker as written; else empty.")
    runs: List[Run] = Field(description="Heading, paragraph and list item content in order.")
    latex: str = Field(description="An equation's LaTeX; else empty.")
    label: str = Field(description="An equation's printed number, such as (2.4); else empty.")
    description: str = Field(description="A figure's short description; else empty.")
    caption: str = Field(description="A figure's or table's printed caption; else empty.")
    rows: List[Row] = Field(description="A table's rows; else empty.")


class ImagePageOutput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    blocks: List[Block]


# ---------------------------------------------------------------------------- the page


def page_png(pdf_path: Path, page_index: int = 0, dpi: int = DPI, max_side: int = MAX_SIDE_PX) -> bytes:
    import pymupdf

    with pymupdf.open(pdf_path) as doc:
        page = doc[page_index]
        zoom = dpi / 72
        longest = max(page.rect.width, page.rect.height) * zoom
        if longest > max_side:
            zoom *= max_side / longest
        return page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).tobytes("png")


def text_layer(pdf_path: Path, page_index: int = 0) -> str:
    import pymupdf

    with pymupdf.open(pdf_path) as doc:
        return doc[page_index].get_text("text")


# ---------------------------------------------------------------------------- the request


def instructions(typed: bool) -> str:
    prompt = PROMPT_PATH.read_text()
    if not typed:
        return prompt
    for old, new in TYPED_PAGE.items():
        if old not in prompt:
            raise ValueError(f"the prompt no longer has the sentence to replace: {old[:40]!r}")
        prompt = prompt.replace(old, new)
    return prompt


def build_params(model: str, png: bytes, text: Optional[str], *, effort: str = EFFORT, max_tokens: int = MAX_TOKENS) -> Dict[str, Any]:
    """The Messages request for one page. `text` is the typed page's text layer, or None for a scan or handwriting."""
    import anthropic

    content: List[Dict[str, Any]] = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.standard_b64encode(png).decode("ascii")}}
    ]
    if text is not None:
        content.append({"type": "text", "text": f"<text_layer>\n{text}\n</text_layer>"})
    return {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": instructions(typed=text is not None), "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": content}],
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": anthropic.transform_schema(ImagePageOutput)}},
    }


def parse_reply(message: Any) -> Tuple[Optional[Dict[str, Any]], str]:
    """The blocks of a reply and its outcome: "ok", or why there are none (the stop reason, or "bad_json")."""
    stop = getattr(message, "stop_reason", None)
    if stop != "end_turn":
        return None, str(stop)
    body = "".join(getattr(part, "text", "") for part in message.content if getattr(part, "type", None) == "text")
    try:
        return ImagePageOutput.model_validate(json.loads(body)).model_dump(), "ok"
    except (ValueError, TypeError):
        return None, "bad_json"


# ---------------------------------------------------------------------------- Markdown


def _runs(runs: List[Dict[str, Any]]) -> str:
    return "".join(f"${r['value']}$" if r["kind"] == "math" else r["value"] for r in runs).strip()


def _cell(cell: Dict[str, Any]) -> str:
    value = f"${cell['latex']}$" if cell.get("latex") else cell.get("text", "")
    return " ".join(value.replace("|", "\\|").split())


def _table(block: Dict[str, Any]) -> List[str]:
    rows = []
    for row in block.get("rows") or []:
        cells: List[str] = []
        for cell in row.get("cells") or []:
            cells.append(_cell(cell))
            cells += [""] * (max(int(cell.get("col_span") or 1), 1) - 1)
        rows.append(cells)
    if not rows:
        return []
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return lines


def blocks_to_markdown(output: Dict[str, Any]) -> str:
    parts: List[str] = []
    for block in output.get("blocks") or []:
        kind = block["kind"]
        if kind == "heading":
            parts.append("#" * min(max(int(block.get("level") or 1), 1), 6) + " " + _runs(block.get("runs") or []))
        elif kind == "paragraph":
            parts.append(_runs(block.get("runs") or []))
        elif kind == "list_item":
            indent = "  " * (max(int(block.get("level") or 1), 1) - 1)
            parts.append(f"{indent}{block.get('marker') or '-'} {_runs(block.get('runs') or [])}")
        elif kind == "equation":
            label = f" {block['label']}" if block.get("label") else ""
            parts.append(f"$${block.get('latex', '')}$${label}")
        elif kind == "figure":
            parts.append(f"[Figure: {' '.join((block.get('description') or '').split())}]")
            if block.get("caption"):
                parts.append(block["caption"])
        elif kind == "table":
            if block.get("caption"):
                parts.append(block["caption"])
            parts.append("\n".join(_table(block)))
    return "\n\n".join(p for p in parts if p) + "\n"

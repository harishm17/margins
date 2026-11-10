"""The candidate page reader (reader.py): request, reply and Markdown. Neutral text only."""
import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reader  # noqa: E402
import score  # noqa: E402


def block(kind, **fields):
    empty = {"x0": 0, "y0": 0, "x1": 1000, "y1": 100, "confidence": "high", "level": 0, "marker": "", "runs": [],
             "latex": "", "label": "", "description": "", "caption": "", "rows": []}
    return {**empty, "kind": kind, **fields}


def text(value):
    return {"kind": "text", "value": value}


def math(value):
    return {"kind": "math", "value": value}


def cell(value, latex="", header="none", col_span=1):
    return {"text": value, "latex": latex, "header": header, "row_span": 1, "col_span": col_span}


def test_blocks_become_markdown_the_scorer_reads_back():
    output = {"blocks": [
        block("heading", level=1, runs=[text("Counting things")]),
        block("paragraph", runs=[text("The count is "), math("n^{2}"), text(" for each pair.")]),
        block("list_item", level=1, marker="1.", runs=[text("First item")]),
        block("equation", latex="\\frac{a}{b} = c", label="(2.1)"),
        block("figure", description="A bar chart of counts.", caption="Figure 1: counts"),
        block("table", caption="", rows=[
            {"cells": [cell("Name", header="col"), cell("Count", header="col")]},
            {"cells": [cell("pears"), cell("x1", latex="x_{1}")]},
            {"cells": [cell("both", col_span=2)]},
        ]),
    ]}
    markdown = reader.blocks_to_markdown(output)
    parsed = score.parse_markdown(markdown)
    assert parsed.headings == [(1, "counting things")]
    assert parsed.formulas == ["n^{2}", "\\frac{a}{b} = c", "x_{1}"]
    assert parsed.tables == [[["name", "count"], ["pears", "x1"], ["both", ""]]]
    assert parsed.figures == 1
    assert "1." in markdown and "First item" in markdown
    assert "bar" not in parsed.words and "counts" in parsed.words  # the description is not words; the caption is


def test_a_pipe_in_a_cell_does_not_split_it():
    output = {"blocks": [block("table", rows=[{"cells": [cell("a|b"), cell("c")]}, {"cells": [cell("1"), cell("2")]}])]}
    parsed = score.parse_markdown(reader.blocks_to_markdown(output))
    assert parsed.tables == [[["ab", "c"], ["1", "2"]]]


def test_a_scanned_page_is_sent_as_its_picture_only_and_a_typed_page_with_its_text_layer():
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 10
    scan = reader.build_params("claude-haiku-5-5", png, None)
    typed = reader.build_params("claude-opus-5-5", png, "Some words from the text layer.")
    assert scan["model"] == "claude-haiku-5-5" and typed["model"] == "claude-opus-5-5"
    assert [c["type"] for c in scan["messages"][0]["content"]] == ["image"]
    assert [c["type"] for c in typed["messages"][0]["content"]] == ["image", "text"]
    assert base64.b64decode(scan["messages"][0]["content"][0]["source"]["data"]) == png
    assert "Some words from the text layer." in typed["messages"][0]["content"][1]["text"]
    assert "There is no text layer" in scan["system"][0]["text"]
    assert "There is no text layer" not in typed["system"][0]["text"] and "text layer" in typed["system"][0]["text"]
    assert scan["output_config"]["effort"] == "low"
    assert scan["output_config"]["format"]["type"] == "json_schema"
    assert scan["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_a_reply_is_read_from_its_text_and_a_cut_off_or_refused_reply_is_named():
    body = json.dumps({"blocks": [block("paragraph", runs=[text("Hello")])]})
    ok = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=body)])
    output, outcome = reader.parse_reply(ok)
    assert outcome == "ok" and output["blocks"][0]["runs"][0]["value"] == "Hello"
    cut = SimpleNamespace(stop_reason="max_tokens", content=[SimpleNamespace(type="text", text=body[:20])])
    assert reader.parse_reply(cut) == (None, "max_tokens")
    refused = SimpleNamespace(stop_reason="refusal", content=[])
    assert reader.parse_reply(refused) == (None, "refusal")
    bad = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text="{not json")])
    assert reader.parse_reply(bad) == (None, "bad_json")


def test_the_page_picture_keeps_the_long_side_within_the_limit(tmp_path):
    import pymupdf

    path = tmp_path / "page.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), "A neutral line of text.")
    doc.save(path)
    png = reader.page_png(path)
    assert png.startswith(b"\x89PNG")
    picture = pymupdf.Pixmap(png)
    assert max(picture.width, picture.height) <= reader.MAX_SIDE_PX
    assert picture.height == round(792 / 72 * reader.DPI) or max(picture.width, picture.height) == reader.MAX_SIDE_PX
    assert "A neutral line of text." in reader.text_layer(path)

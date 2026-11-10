"""The candidate page reader (reader.py): request, reply and Markdown. Neutral text only."""
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



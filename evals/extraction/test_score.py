"""Scoring of a page read against its key (score.py). Neutral text only: no course material."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import score  # noqa: E402

KEY = """# Counting things

## Pairs

A pair has two parts. The count is $n^{2}$ for $n$ items.

$$\\frac{a}{b} = c$$

| Name | Count |
| --- | --- |
| apples | 3 |
| pears | $x_{1}$ |

```
for item in items:
    total += 1
```

[Figure]
"""


def test_a_key_is_parsed_into_headings_formulas_tables_code_figures_and_words():
    page = score.parse_markdown(KEY)
    assert page.headings == [(1, "counting things"), (2, "pairs")]
    assert page.formulas == ["n^{2}", "n", "\\frac{a}{b} = c", "x_{1}"]
    assert page.tables == [[["name", "count"], ["apples", "3"], ["pears", "x1"]]]
    assert page.code_lines == ["for item in items:", "total += 1"]
    assert page.figures == 1
    assert "pair" in page.words and "apples" in page.words and "for" in page.words
    assert "frac" not in page.words and "figure" not in page.words


def test_latex_is_normalised_so_spacing_sizing_and_braces_do_not_count():
    same = [
        ("\\frac{a}{b}", "\\dfrac{a}{b}"),
        ("x^{2}", "x^2"),
        ("\\left( a + b \\right)", "(a+b)"),
        ("5\\ \\text{m}", "5\\,\\mathrm{m}"),
        ("a \\le b", "a\\leq b"),
        ("a - b.", "a − b"),
        ("a \\longrightarrow b", "a \\to b"),
        ("a, \\quad b \\qquad c", "a, b c"),
        ("a \\implies b, \\dots", "a \\Longrightarrow b, \\ldots"),
        ("\\begin{array}{rcl} a & = & b \\\\ c & = & d \\end{array}", "\\begin{array}{lcl} a &=& b \\\\ c &=& d \\end{array}"),
    ]
    for a, b in same:
        assert score.normalize_latex(a) == score.normalize_latex(b), (a, b)
    assert score.normalize_latex("x^{2}") != score.normalize_latex("x_{2}")
    assert score.normalize_latex("a \\cdot b") != score.normalize_latex("a \\times b")


def test_a_text_read_that_loses_maths_layout_keeps_its_symbols_but_not_exact_formulas():
    text_read = """**Counting things**

Pairs

A pair has two parts. The count is n² for n items.

a / b = c

Name Count apples 3 pears x1

for item in items:
total += 1
"""
    result = score.score_page(score.parse_markdown(KEY), score.parse_markdown(text_read))
    assert result["words_dropped"] == 0.0
    assert result["words_invented"] == 0.0  # the formula's symbols are not invented words
    assert result["formulas_exact"] == 0.0
    assert result["formula_symbols"] == 1.0
    assert result["table_cells"] == 0.0 and result["table_shape"] == 0.0
    assert result["headings_found"] == 0.0 and result["heading_levels"] is None
    assert result["code_lines"] == 1.0
    assert result["figures_noted"] == 0.0


def test_dropped_and_invented_words_are_shares_of_the_key_and_of_the_read():
    key = score.parse_markdown("one two three four")
    read = score.parse_markdown("one two three five six")
    result = score.score_page(key, read)
    assert result["words_dropped"] == 0.25  # "four" of 4 key words
    assert result["words_invented"] == 0.4  # "five", "six" of 5 read words


def test_heading_levels_are_compared_relative_to_each_sides_top_heading():
    key = score.parse_markdown("# Top\n\n## Under")
    shifted = score.parse_markdown("## Top\n\n### Under")
    flat = score.parse_markdown("## Top\n\n## Under")
    assert score.score_page(key, shifted)["heading_levels"] == 1.0
    assert score.score_page(key, flat)["heading_levels"] == 0.5



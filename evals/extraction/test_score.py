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


def test_formula_tokens_read_latex_and_unicode_the_same_way():
    assert score.plain_tokens("\\frac{x^{2}}{\\alpha}") == ["x", "2", "α"]
    assert score.plain_tokens("x² / α") == ["x", "2", "α"]
    assert score.plain_tokens("H2O and \\text{m/s}") == ["h", "2", "o", "and", "m", "s"]


def test_a_perfect_read_scores_full_marks():
    result = score.score_page(score.parse_markdown(KEY), score.parse_markdown(KEY))
    assert result["words_dropped"] == 0.0 and result["words_invented"] == 0.0
    assert result["formulas_exact"] == 1.0 and result["formula_symbols"] == 1.0
    assert result["table_cells"] == 1.0 and result["table_shape"] == 1.0
    assert result["headings_found"] == 1.0 and result["heading_levels"] == 1.0
    assert result["code_lines"] == 1.0 and result["figures_noted"] == 1.0


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


def test_a_figure_description_is_not_counted_as_words():
    key = score.parse_markdown("A plot follows.\n\n[Figure]")
    read = score.parse_markdown("A plot follows.\n\n[Figure: a line graph of speed against time]")
    result = score.score_page(key, read)
    assert result["words_invented"] == 0.0 and result["figures_noted"] == 1.0


def test_heading_levels_are_compared_relative_to_each_sides_top_heading():
    key = score.parse_markdown("# Top\n\n## Under")
    shifted = score.parse_markdown("## Top\n\n### Under")
    flat = score.parse_markdown("## Top\n\n## Under")
    assert score.score_page(key, shifted)["heading_levels"] == 1.0
    assert score.score_page(key, flat)["heading_levels"] == 0.5


def test_a_heading_keeps_its_maths_whether_written_as_latex_or_plain():
    key = score.parse_markdown("# Intro\n\n$y$\n\n## Solve a 2 × 2 system")
    read = score.parse_markdown("# Intro\n\n$y$\n\n## Solve a $2 \\times 2$ system")
    assert key.headings[1] == (2, "solve a 2 2 system")
    assert score.score_page(key, read)["headings_found"] == 1.0
    assert score.parse_markdown("$y$\n\n# $x^{2}$").headings == [(1, "x 2")]


def test_a_page_without_a_feature_scores_none_for_it():
    result = score.score_page(score.parse_markdown("just words"), score.parse_markdown("just words"))
    assert result["formulas_exact"] is None and result["table_cells"] is None
    assert result["headings_found"] is None and result["code_lines"] is None and result["figures_noted"] is None


def test_markdown_escapes_and_emphasis_do_not_change_words():
    page = score.parse_markdown("**Bold** and \\_under\\_ and *it*")
    assert page.words == ["bold", "and", "under", "and", "it"]

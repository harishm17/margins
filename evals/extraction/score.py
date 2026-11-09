"""A1's scores: one page as a reader wrote it (Markdown with LaTeX) against its hand-checked key (the same form).

Both sides are parsed into headings, formulas, tables, code lines, figures and words, then compared:

- words dropped: the key's words the read has nowhere (not even inside a formula), as a share of the key's words;
- words invented: the read's words the key has nowhere, as a share of the read's words. A formula read as plain
  Unicode ("n²") is not invented: its symbols are in the key's formulas;
- formulas exact: key formulas the read wrote as the same LaTeX after normalising spacing, sizing and braces;
- formula symbols: the key formulas' letters, digits and Greek letters found anywhere in the read (lenient: a text
  read that keeps "x²" keeps the symbols of `x^{2}`);
- table cells: key cells found in the read's tables; table shape: key tables with a read table of the same size;
- headings found, and heading levels: of those found, the ones at the same level relative to each side's top one;
- code lines: key code lines found in the read, spacing aside; figures noted: figures the read tells the student of.

A score is None when the key has nothing of its kind.
"""
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

GREEK = {
    name: chr(code)
    for name, code in {
        "alpha": 0x3B1, "beta": 0x3B2, "gamma": 0x3B3, "delta": 0x3B4, "epsilon": 0x3B5, "varepsilon": 0x3B5,
        "zeta": 0x3B6, "eta": 0x3B7, "theta": 0x3B8, "vartheta": 0x3B8, "iota": 0x3B9, "kappa": 0x3BA,
        "lambda": 0x3BB, "mu": 0x3BC, "nu": 0x3BD, "xi": 0x3BE, "pi": 0x3C0, "rho": 0x3C1, "sigma": 0x3C3,
        "tau": 0x3C4, "upsilon": 0x3C5, "phi": 0x3C6, "varphi": 0x3C6, "chi": 0x3C7, "psi": 0x3C8, "omega": 0x3C9,
        "Gamma": 0x393, "Delta": 0x394, "Theta": 0x398, "Lambda": 0x39B, "Xi": 0x39E, "Pi": 0x3A0, "Sigma": 0x3A3,
        "Phi": 0x3A6, "Psi": 0x3A8, "Omega": 0x3A9,
    }.items()
}
_GREEK_COMMAND = re.compile(r"\\(" + "|".join(sorted(GREEK, key=len, reverse=True)) + r")(?![A-Za-z])")
_UNWRAP = re.compile(r"\\(?:text|mathrm|textrm|mathit|textit|textbf|operatorname|mbox)\s*\{([^{}]*)\}")
_SIZING = re.compile(r"\\(?:left|right|displaystyle|textstyle|big|Big|bigg|Bigg)(?![A-Za-z])")
_SPACING = re.compile(r"\\[,;:!> ]|\\q?quad(?![A-Za-z])|~")
_ALIASES = {
    "le": "leq", "ge": "geq", "ne": "neq", "to": "rightarrow", "gets": "leftarrow", "longrightarrow": "rightarrow",
    "longleftarrow": "leftarrow", "dfrac": "frac", "tfrac": "frac", "implies": "Longrightarrow", "dots": "ldots",
}
_ALIAS = re.compile(r"\\(" + "|".join(_ALIASES) + r")(?![A-Za-z])")
_ARRAY_SPEC = re.compile(r"(\\begin\s*\{array\})\s*\{[^{}]*\}")
_ALIGNMENT = re.compile(r"(?<!\\)&")
_LATEX_TOKEN = re.compile(r"\\[A-Za-z]+|\\.|\S")
_WORD = re.compile(r"[^\W\d_]+|\d+")
_DISPLAY = re.compile(r"\$\$(.+?)\$\$|\\\[(.+?)\\\]", re.DOTALL)
_INLINE = re.compile(r"\$(.+?)\$|\\\((.+?)\\\)")
_TAG = re.compile(r"</?[A-Za-z][^>]*>")
_ESCAPE = re.compile(r"\\([^\w\s])")
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_SEPARATOR = re.compile(r"^:?-{3,}:?$")
_FIGURE_LINE = re.compile(r"^\s*\[figure\b|intentionally omitted|^\s*!\[[^\]]*\]\([^)]*\)\s*$", re.IGNORECASE)
_PICTURE_TEXT_MARK = re.compile(r"-{3,}\s*(?:start|end) of picture text\s*-{3,}", re.IGNORECASE)
ILLEGIBLE = "[illegible]"


def normalize_latex(latex: str) -> str:
    """LaTeX with what does not change the formula taken out: `$`, spacing, \\left/\\right and sizing, \\text-like
    wrappers, braces around one token, aliases (\\le, \\dfrac), an array's column spec and `&` marks, and a full stop
    at the end. Tokens joined by spaces."""
    s = unicodedata.normalize("NFKC", latex).replace("\u2212", "-").strip().strip("$")
    s = _SIZING.sub("", s)
    s = _SPACING.sub(" ", s)
    s = _ALIGNMENT.sub(" ", _ARRAY_SPEC.sub(r"\1", s))
    s = _ALIAS.sub(lambda m: "\\" + _ALIASES[m.group(1)], s)
    while True:
        unwrapped = _UNWRAP.sub(r"\1", s)
        if unwrapped == s:
            break
        s = unwrapped
    tokens = _LATEX_TOKEN.findall(s)
    changed = True
    while changed:
        changed = False
        for i in range(len(tokens) - 2):
            if tokens[i] == "{" and tokens[i + 2] == "}" and tokens[i + 1] not in ("{", "}"):
                tokens[i : i + 3] = [tokens[i + 1]]
                changed = True
                break
    while tokens and tokens[-1] in (".", ",", ";"):
        tokens.pop()
    return " ".join(tokens)


def plain_tokens(text: str) -> List[str]:
    """Letters and digits of a text or a formula, LaTeX or Unicode alike: Greek commands become their letters, other
    commands are dropped, superscript digits become digits. Lower case."""
    s = unicodedata.normalize("NFKC", text)
    s = _GREEK_COMMAND.sub(lambda m: GREEK[m.group(1)], s)
    s = re.sub(r"\\[A-Za-z]+", " ", s)
    return [t.lower() for t in _WORD.findall(s)]


@dataclass
class Parsed:
    headings: List[Tuple[int, str]] = field(default_factory=list)
    formulas: List[str] = field(default_factory=list)
    tables: List[List[List[str]]] = field(default_factory=list)
    code_lines: List[str] = field(default_factory=list)
    figures: int = 0
    words: List[str] = field(default_factory=list)
    formula_tokens: List[str] = field(default_factory=list)
    flat: str = ""


def _prose(parsed: Parsed, text: str) -> None:
    """Take a line's formulas out into `parsed.formulas` and its other words into `parsed.words`."""

    def keep(match: re.Match) -> str:
        parsed.formulas.append(next(g for g in match.groups() if g is not None).strip())
        return " "

    text = _DISPLAY.sub(keep, text)
    text = _INLINE.sub(keep, text)
    text = _TAG.sub(" ", text).replace(ILLEGIBLE, " ")
    parsed.words += plain_tokens(_ESCAPE.sub(r"\1", text))


def _table_cells(line: str) -> List[str]:
    inner = line.strip()
    inner = inner[1:] if inner.startswith("|") else inner
    inner = inner[:-1] if inner.endswith("|") and not inner.endswith("\\|") else inner
    return [cell.strip() for cell in re.split(r"(?<!\\)\|", inner)]


def parse_markdown(text: str) -> Parsed:
    parsed = Parsed()
    lines = (text or "").splitlines()
    flat: List[str] = []
    i = 0
    in_code = False
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        i += 1
        if stripped.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            if stripped:
                parsed.code_lines.append(" ".join(stripped.split()))
                parsed.words += plain_tokens(stripped)
                flat.append(stripped)
            continue
        if not stripped or _PICTURE_TEXT_MARK.search(stripped):
            continue
        if _FIGURE_LINE.search(stripped):
            parsed.figures += 1
            continue
        if stripped.startswith("$$") and stripped.count("$$") == 1:
            block = [stripped]
            while i < len(lines) and "$$" not in lines[i]:
                block.append(lines[i].strip())
                i += 1
            if i < len(lines):
                block.append(lines[i].strip())
                i += 1
            stripped = " ".join(block)
        flat.append(_ESCAPE.sub(r"\1", stripped))
        heading = _HEADING.match(stripped)
        if heading:
            _prose(parsed, heading.group(2))
            title = _TAG.sub(" ", heading.group(2)).replace(ILLEGIBLE, " ")
            parsed.headings.append((len(heading.group(1)), " ".join(plain_tokens(_ESCAPE.sub(r"\1", title)))))
            continue
        if stripped.startswith("|"):
            rows = [stripped]
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                flat.append(_ESCAPE.sub(r"\1", lines[i].strip()))
                i += 1
            grid = []
            for row in rows:
                cells = _table_cells(row)
                if cells and all(_SEPARATOR.match(c.replace(" ", "")) for c in cells if c):
                    continue
                grid.append(["".join(plain_tokens(c)) for c in cells])
                for cell in cells:
                    _prose(parsed, cell)
            parsed.tables.append(grid)
            continue
        _prose(parsed, stripped)
    parsed.formula_tokens = [t for f in parsed.formulas for t in plain_tokens(f)]
    parsed.flat = " ".join(" ".join(flat).split())
    return parsed


def _share(found: int, total: int) -> Optional[float]:
    return round(found / total, 4) if total else None


def _matched(wanted: Counter, available: Counter) -> int:
    return sum(min(n, available[k]) for k, n in wanted.items())


def score_page(key: Parsed, read: Parsed) -> Dict[str, Optional[float]]:
    key_words, read_words = Counter(key.words), Counter(read.words)
    key_pool = key_words + Counter(key.formula_tokens)
    read_pool = read_words + Counter(read.formula_tokens)

    key_formulas = Counter(normalize_latex(f) for f in key.formulas)
    read_formulas = Counter(normalize_latex(f) for f in read.formulas)
    key_symbols = Counter(key.formula_tokens)

    key_cells = Counter(c for t in key.tables for row in t for c in row if c)
    read_cells = Counter(c for t in read.tables for row in t for c in row if c)
    read_shapes = Counter((len(t), max((len(r) for r in t), default=0)) for t in read.tables)
    shapes = Counter((len(t), max((len(r) for r in t), default=0)) for t in key.tables)

    read_headings: Dict[str, List[int]] = {}
    for level, title in read.headings:
        read_headings.setdefault(title, []).append(level)
    pairs = []
    for level, title in key.headings:
        if read_headings.get(title):
            pairs.append((level, read_headings[title].pop(0)))
    levels_right = None
    if pairs:
        key_top = min(k for k, _ in pairs)
        read_top = min(r for _, r in pairs)
        levels_right = _share(sum(1 for k, r in pairs if k - key_top == r - read_top), len(pairs))

    return {
        "words_dropped": _share(sum((key_words - read_pool).values()), len(key.words)),
        "words_invented": _share(sum((read_words - key_pool).values()), len(read.words)),
        "formulas_exact": _share(_matched(key_formulas, read_formulas), len(key.formulas)),
        "formula_symbols": _share(_matched(key_symbols, read_pool), len(key.formula_tokens)),
        "table_cells": _share(_matched(key_cells, read_cells), sum(key_cells.values())) if key.tables else None,
        "table_shape": _share(_matched(shapes, read_shapes), len(key.tables)),
        "headings_found": _share(len(pairs), len(key.headings)),
        "heading_levels": levels_right,
        "code_lines": _share(sum(1 for line in key.code_lines if line in read.flat), len(key.code_lines)),
        "figures_noted": _share(min(read.figures, key.figures), key.figures),
    }


SCORES = (
    "words_dropped",
    "words_invented",
    "formulas_exact",
    "formula_symbols",
    "table_cells",
    "table_shape",
    "headings_found",
    "heading_levels",
    "code_lines",
    "figures_noted",
)

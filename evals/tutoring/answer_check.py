"""Port of the answer checker the student's check button and the server use
(frontend/src/features/topic/practice-check.ts: cleanAnswer, numberCandidates, checkPracticeAnswer).

The eval needs it for two things: whether a scripted check is right (the server grades the answer
itself), and the numbers an authored answer stands for (the first wrong step). `test_app_state.py`
asserts that this port reproduces the TypeScript on every check in the committed scenarios
(fixtures/app_state_parity.json is made by the real code).

What is ported: the LaTeX and unicode clean-up (`\\frac`, `\\sqrt`, `\\text`, `\\cdot`, `x^{2}`, `$`),
numbers with thousands separators, decimals, fractions, mixed numbers, percents, exponents and a
trailing unit ("9.8 m/s^2"), text comparison, and multiple choice by option letter or text.

What is not: the algebra comparison (two expressions that are equal as formulas) and list answers
("2, 3" in any order). `unsupported_reason` names the steps that need them; the scenario builder
leaves those steps out, so a scenario never depends on a check this port cannot reproduce.
"""
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

NUMERIC_TOLERANCE = 0.01
TEXT_TOLERANCE = 1e-6


def _read_braces(text: str, start: int) -> Optional[Tuple[str, int]]:
    if text[start : start + 1] != "{":
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : i], i + 1
    return None


def _skip_spaces(text: str, index: int) -> int:
    while index < len(text) and text[index].isspace():
        index += 1
    return index


def _rewrite_command(text: str, pattern: "re.Pattern[str]", groups: int, build: Callable[[List[str]], str]) -> str:
    result = text
    for _ in range(200):
        match = pattern.search(result)
        if not match:
            break
        parts: List[str] = []
        end = match.end()
        for _group in range(groups):
            group = _read_braces(result, _skip_spaces(result, end))
            if not group:
                break
            parts.append(group[0])
            end = group[1]
        replacement = build(parts) if len(parts) == groups else ""
        result = result[: match.start()] + replacement + result[end:]
    return result


def _rewrite_superscripts(text: str) -> str:
    result = text
    for _ in range(200):
        at = result.find("^{")
        if at < 0:
            break
        group = _read_braces(result, at + 1)
        if not group:
            result = result[: at + 1] + result[at + 2 :]
            continue
        result = f"{result[:at]}^({group[0]}){result[group[1]:]}"
    return result


def clean_answer(value: str) -> str:
    """cleanAnswer: case-preserving clean-up shared by every comparison."""
    text = value.replace("$", "").replace("−", "-")
    text = re.sub(r"[×·]", "*", text).replace("÷", "/").replace("²", "^2").replace("³", "^3")
    text = text.replace("π", "pi").replace("√", "sqrt")
    text = re.sub(r"\\(?:left|right)(?![a-zA-Z])", "", text)
    text = re.sub(r"\\(?:cdot|times)(?![a-zA-Z])", "*", text)
    text = re.sub(r"\\[,;!:]", "", text).replace("\\%", "%")
    text = _rewrite_command(text, re.compile(r"\\[dt]?frac(?![a-zA-Z])"), 2, lambda p: f"({p[0]})/({p[1]})")
    text = _rewrite_command(text, re.compile(r"\\sqrt(?![a-zA-Z])"), 1, lambda p: f"sqrt({p[0]})")
    text = _rewrite_command(text, re.compile(r"\\(?:text|textbf|mathrm|mathbf|mathit|operatorname)(?![a-zA-Z])"), 1, lambda p: p[0])
    text = _rewrite_superscripts(text)
    text = re.sub(r"\\([a-zA-Z]+)", r"\1", text)
    text = re.sub(r"[\\{}]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"[.]+$", "", text).strip()


def normalize_answer(value: str) -> str:
    return clean_answer(value).lower()


def text_key(base: str) -> str:
    text = re.sub(r"(?<=[^\W\d_])-(?=[^\W\d_])", " ", base.lower())
    return re.sub(r"\s*([^\w\s]|_)\s*", r"\1", text)


_NUMBER_SOURCE = r"(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[-+]?\d+|\s*[*x]\s*10\s*\^\s*(?:[-+]?\d+|\([-+]?\d+\)))?"
_NUMBER_TOKEN = re.compile(_NUMBER_SOURCE)
_MIXED_NUMBER = re.compile(r"(\d+)\s+(\d+)\s*/\s*(\d+)")
_PERCENT = re.compile(r"^\s*%")
_UNIT = re.compile(r"^[a-zµμ°ω][a-z0-9µμ°ω^*/.\-() ]{0,24}$")
_UNIT_JOINERS = re.compile(r"\b(?:and|or)\b")
_SCIENTIFIC = re.compile(r"^(.*?)\s*[*x]\s*10\s*\^\s*\(?([-+]?\d+)\)?$")

Read = Tuple[float, int]


def _read_number(text: str, start: int) -> Optional[Read]:
    match = _NUMBER_TOKEN.match(text, start)
    if not match:
        return None
    token = match.group(0).replace(",", "")
    scientific = _SCIENTIFIC.match(token)
    try:
        value = float(scientific.group(1)) * 10 ** float(scientific.group(2)) if scientific else float(token)
    except ValueError:
        return None
    return (value, start + len(match.group(0))) if abs(value) != float("inf") else None


def _read_operand(text: str, start: int) -> Optional[Read]:
    if text[start : start + 1] != "(":
        return _read_number(text, start)
    i = _skip_spaces(text, start + 1)
    sign = 1.0
    if text[i : i + 1] in ("-", "+"):
        if text[i] == "-":
            sign = -1.0
        i = _skip_spaces(text, i + 1)
    number = _read_number(text, i)
    if not number:
        return None
    close = _skip_spaces(text, number[1])
    return (sign * number[0], close + 1) if text[close : close + 1] == ")" else None


def _read_value(text: str, start: int) -> Optional[Read]:
    mixed = _MIXED_NUMBER.match(text, start)
    if mixed:
        bottom = float(mixed.group(3))
        if bottom == 0:
            return None
        return float(mixed.group(1)) + float(mixed.group(2)) / bottom, start + len(mixed.group(0))
    top = _read_operand(text, start)
    if not top:
        return None
    slash = _skip_spaces(text, top[1])
    if text[slash : slash + 1] != "/":
        return top
    bottom = _read_operand(text, _skip_spaces(text, slash + 1))
    if not bottom:
        return top
    return None if bottom[0] == 0 else (top[0] / bottom[0], bottom[1])


def _is_wrapped(text: str) -> bool:
    if text[:1] != "(" or text[-1:] != ")":
        return False
    depth = 0
    for i, char in enumerate(text):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return i == len(text) - 1
    return False


def number_candidates(value: str, allow_unit: bool = True) -> Optional[List[float]]:
    """numberCandidates: the values a whole answer stands for, or None when it is not purely a number
    expression. "5.88%" gives two (0.0588 and 5.88); a trailing unit is ignored with `allow_unit`."""
    text = normalize_answer(value)
    if _is_wrapped(text):
        text = text[1:-1].strip()
    sign_match = re.match(r"^[-+]?\s*", text)
    sign = -1.0 if sign_match and sign_match.group(0).strip() == "-" else 1.0
    start = len(sign_match.group(0)) if sign_match else 0
    read = _read_value(text, start)
    if not read:
        return None
    end = read[1]
    values = [read[0]]
    percent = _PERCENT.match(text[end:])
    if percent:
        values = [read[0] / 100, read[0]]
        end += len(percent.group(0))
    rest = text[end:].strip()
    if rest and not (allow_unit and _UNIT.match(rest) and not _UNIT_JOINERS.search(rest)):
        return None
    return [sign * v for v in values]


def with_tolerance(given: float, target: float) -> bool:
    if target == 0:
        return abs(given) < 1e-9
    return abs(given - target) <= abs(target) * NUMERIC_TOLERANCE + 1e-12


def _close(given: float, target: float, numeric: bool, tolerance: Optional[float]) -> bool:
    if not numeric:
        if target == 0:
            return abs(given) < 1e-9
        return abs(given - target) <= abs(target) * TEXT_TOLERANCE + 1e-12
    if tolerance is not None:
        return abs(given - target) <= tolerance + 1e-12
    return with_tolerance(given, target)


def _matches_piece(numeric: bool, tolerance: Optional[float], given_text: str, target: str) -> bool:
    if text_key(given_text) == text_key(target):
        return True
    given = number_candidates(given_text, numeric)
    wanted = number_candidates(target, numeric)
    if given is not None and wanted is not None:
        return any(_close(g, w, numeric, tolerance) for g in given for w in wanted)
    return False  # a numeric step is not retried as algebra; algebra is not ported (see unsupported_reason)


def _legacy_normalize(value: str) -> str:
    text = re.sub(r"^\$+|\$+$", "", value.strip().lower())
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"[.]+$", "", text).strip()


_OPTION_LETTER = re.compile(r"^\(?([a-h])[).:]?(?:\s|$)", re.IGNORECASE)


def _option_letter(value: str) -> Optional[str]:
    match = _OPTION_LETTER.match(value.strip())
    return match.group(1).lower() if match else None


def check_practice_answer(step: Dict[str, Any], text: str) -> bool:
    """checkPracticeAnswer for a scenario step (answer_type, answer, acceptable_answers, tolerance)."""
    targets = [step["answer"], *step.get("acceptable_answers", [])]
    if step["answer_type"] == "multiple_choice":
        given = _legacy_normalize(text)
        if not given:
            return False
        if any(_legacy_normalize(t) == given for t in targets):
            return True
        letter = _option_letter(text)
        return bool(letter) and any(_option_letter(t) == letter for t in targets)
    given_text = clean_answer(text)
    if not given_text:
        return False
    tolerance = step.get("tolerance")
    tolerance = tolerance if isinstance(tolerance, (int, float)) and tolerance >= 0 else None
    numeric = step["answer_type"] == "numeric"
    for target in targets:
        wanted = clean_answer(target)
        if wanted and _matches_piece(numeric, tolerance, given_text, wanted):
            return True
    return False


_LIST = re.compile(r",(?!\d{3}\b)|;|\band\b|\bor\b")
_WORDS = re.compile(r"^[A-Za-z][A-Za-z '\-]*$")


def unsupported_reason(step: Dict[str, Any]) -> Optional[str]:
    """Why a step needs the part of the checker that is not ported, or None.

    A numeric step needs every form to be a plain number expression; a text step must be words (no
    formula, so no algebra comparison); no form may be a list."""
    forms = [step["answer"], *step.get("acceptable_answers", [])]
    kind = step["answer_type"]
    if kind == "multiple_choice":
        return None
    for form in forms:
        cleaned = clean_answer(form)
        if _LIST.search(cleaned):
            return f"'{form}' is a list"
        if kind == "numeric" and number_candidates(form, True) is None and form is step["answer"]:
            return f"'{form}' is not a number the checker reads"
        if kind == "text" and not _WORDS.match(cleaned):
            return f"'{form}' is not plain words (algebra comparison is not ported)"
    return None

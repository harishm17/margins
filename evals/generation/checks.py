"""Automatic checks on generated study content. No model, no database, no app imports.

Every function takes plain data (strings, lists, dicts shaped like the generators' output) and
returns plain data, so the checks are unit-tested in test_checks.py and can be re-run on stored
raw outputs.

Content types and their output shape (what the app's generators return):

    notes        a markdown string
    solved       list of dicts: title, problem_statement, solution_steps[{step_number,
                 description, work, explanation}], final_answer, key_concepts, difficulty
    interactive  list of dicts: title, problem_statement, steps[{step_number, question, hint,
                 answer_type, correct_answer, acceptable_answers, explanation, feedback_correct,
                 feedback_incorrect}], key_concepts, difficulty
    quiz         list of dicts: question_type, question_text, options[{id, text}],
                 correct_answer, explanation, concepts_tested, ...

These are lexical heuristics. They find things worth looking at; they do not prove content is
right or wrong. The README lists what each one can miss.
"""
import re
from collections import Counter
from typing import Dict, Iterable, Iterator, List, Optional, Set, Tuple

NOTES = "notes"
SOLVED = "solved"
INTERACTIVE = "interactive"
QUIZ = "quiz"
CONTENT_TYPES = (NOTES, SOLVED, INTERACTIVE, QUIZ)
# Concept-graph types. CONCEPTS is a snapshot of the topic's stored graph (no text a student
# reads); WARMUP is the topic's warm-up bank, shaped like a quiz.
CONCEPTS = "concepts"
WARMUP = "warmup"
GRAPH_TYPES = (CONCEPTS, WARMUP)
# concepts_per_topic bounds: the extraction prompt asks for 3-8 (concepts/extractor.py MIN/MAX_CONCEPTS).
CONCEPTS_PER_TOPIC = (3, 8)
CLAIM_QUOTE_GATE = 0.98
WARMUP_REUSE_JACCARD = 0.8

# The notes structure the notes generator asks for today (notes.py `_SECTION_LABELS`). The
# runner passes the app's own list when it can import it, so this follows a prompt change.
DEFAULT_NOTES_SECTIONS = ("Overview", "Key Concepts", "How It Works", "Common Pitfalls", "Exam-Ready Recap")
# notes.py `_DETAIL_LEVELS["comprehensive"]` (the default detail level): "about 900-1400 words".
DEFAULT_NOTES_WORD_BAND = (900, 1400)
# examples.py INTERACTIVE_GUIDANCE (steps per problem by difficulty).
INTERACTIVE_STEP_BANDS = {"easy": (2, 3), "medium": (3, 5), "hard": (5, 99)}

_FENCED = re.compile(r"(?ms)^```.*?^```[^\n]*$")
_INLINE_CODE = re.compile(r"`[^`\n]*`")


# ---------------------------------------------------------------------------- text helpers


def strip_code(text: str) -> str:
    """Remove fenced code blocks and inline code, which are plain text on purpose."""
    return _INLINE_CODE.sub(" ", _FENCED.sub(" ", text or ""))


def word_count(text: str) -> int:
    return len((text or "").split())


# ---------------------------------------------------------------------------- field access


def iter_text_fields(content_type: str, output) -> Iterator[Tuple[str, str, bool]]:
    """Yield (path, text, plain) for every model-written string the student sees.

    `plain` marks fields the UI shows as plain text today: key-concept chips, titles, step
    titles and the one-line correct answer. Everything else goes through the markdown + KaTeX
    renderer. Stage 1B of the learning v2 spec moves the plain fields to math rendering; the
    check stays to catch regressions. Edit this function if the UI changes.
    """
    if content_type == NOTES:
        yield "notes", str(output or ""), False
    elif content_type == SOLVED:
        for i, example in enumerate(output or []):
            yield f"[{i}].title", example.get("title", ""), True
            yield f"[{i}].problem_statement", example.get("problem_statement", ""), False
            for j, step in enumerate(example.get("solution_steps") or []):
                yield f"[{i}].steps[{j}].description", step.get("description", ""), True
                yield f"[{i}].steps[{j}].work", step.get("work", ""), False
                yield f"[{i}].steps[{j}].explanation", step.get("explanation", ""), False
            yield f"[{i}].final_answer", example.get("final_answer", ""), False
            for j, concept in enumerate(example.get("key_concepts") or []):
                yield f"[{i}].key_concepts[{j}]", concept, True
    elif content_type == INTERACTIVE:
        for i, example in enumerate(output or []):
            yield f"[{i}].title", example.get("title", ""), True
            yield f"[{i}].problem_statement", example.get("problem_statement", ""), False
            for j, step in enumerate(example.get("steps") or []):
                yield f"[{i}].steps[{j}].question", step.get("question", ""), False
                yield f"[{i}].steps[{j}].hint", step.get("hint", ""), False
                yield f"[{i}].steps[{j}].correct_answer", str(step.get("correct_answer", "")), True
                yield f"[{i}].steps[{j}].explanation", step.get("explanation", ""), False
                yield f"[{i}].steps[{j}].feedback_correct", step.get("feedback_correct", ""), False
                yield f"[{i}].steps[{j}].feedback_incorrect", step.get("feedback_incorrect", ""), False
            for j, concept in enumerate(example.get("key_concepts") or []):
                yield f"[{i}].key_concepts[{j}]", concept, True
    elif content_type in (QUIZ, WARMUP):
        for i, question in enumerate(output or []):
            yield f"[{i}].question_text", question.get("question_text", ""), False
            for option in question.get("options") or []:
                yield f"[{i}].option[{option.get('id')}]", option.get("text", ""), False
            yield f"[{i}].explanation", question.get("explanation", ""), False
            for j, concept in enumerate(question.get("concepts_tested") or []):
                yield f"[{i}].concepts_tested[{j}]", concept, True
    else:
        raise ValueError(f"unknown content type: {content_type}")


def all_text(content_type: str, output) -> str:
    """Every text field joined, for lexical comparisons."""
    return "\n".join(text for _, text, _ in iter_text_fields(content_type, output))


# ---------------------------------------------------------------------------- LaTeX hygiene

_LATEX_IN_PLAIN = re.compile(r"\$|\\[A-Za-z]+|\\[{}()\[\]|,;!]|[\^_]\{")
_MATH_MARKS = re.compile(r"[\\^_]")


def _prose_words(span: str) -> int:
    """Space-separated tokens of three or more letters (`and`, `lose`; not `len(arr)` or `n`)."""
    return sum(1 for token in span.split() if token.isalpha() and len(token) >= 3)


def has_latex(text: str) -> bool:
    """True when a plain-text field contains `$` or a backslash sequence (raw LaTeX would show)."""
    return bool(_LATEX_IN_PLAIN.search(strip_code(text)))


def _without_escaped_dollars(text: str) -> str:
    return strip_code(text).replace("\\$", "")


def unbalanced_dollar(text: str) -> bool:
    """True when the unescaped `$` signs outside code do not pair up (`$$` pairs count as one)."""
    body = _without_escaped_dollars(text)
    if body.count("$$") % 2:
        return True
    body = body.replace("$$", "")
    return body.count("$") % 2 == 1


def bare_currency_count(text: str) -> int:
    """Number of `$` signs that start a money amount instead of a math span.

    Uses the rule from the spec: a `$` followed by a digit starts currency when no `$` follows on
    the same line, or when the span up to the next `$` has two or more space-separated words of
    3+ letters and none of `\\`, `^`, `_` (an `=` alone does not make prose math). `\\$100` is escaped currency and is fine.
    """
    body = _without_escaped_dollars(text).replace("$$", "  ")
    count = 0
    for line in body.splitlines():
        positions = [i for i, ch in enumerate(line) if ch == "$"]
        for n, pos in enumerate(positions):
            if not re.match(r"\s?\d", line[pos + 1 :]):
                continue
            if n + 1 >= len(positions):
                count += 1
                continue
            span = line[pos + 1 : positions[n + 1]]
            if _prose_words(span) >= 2 and not _MATH_MARKS.search(span):
                count += 1
    return count


def latex_hygiene(content_type: str, output) -> Dict[str, List[str]]:
    """Field paths with a problem, by kind: plain_text_latex, unbalanced_dollar, bare_currency."""
    found: Dict[str, List[str]] = {"plain_text_latex": [], "unbalanced_dollar": [], "bare_currency": []}
    for path, text, plain in iter_text_fields(content_type, output):
        if not text:
            continue
        if plain and has_latex(text):
            found["plain_text_latex"].append(path)
        if unbalanced_dollar(text):
            found["unbalanced_dollar"].append(path)
        if bare_currency_count(text):
            found["bare_currency"].append(path)
    return found


# ---------------------------------------------------------------------------- MC letter references

_MATH_SPAN = re.compile(r"\$\$.*?\$\$|\$[^$\n]*\$", re.S)
# The keyword may be any case but the letter must be a capital A-D.
_STRICT_LETTER = re.compile(
    r"\b(?:[Oo]ption|[Cc]hoice|[Aa]nswer|[Ll]etter)s?\s+\(?[A-D]\)?(?![A-Za-z])|\([A-D]\)|^[ \t]*[A-D]\)[ \t]",
    re.M,
)
_LOOSE_LETTER = re.compile(
    r"\b[A-D]\s+(?:is|are|was|describes|gives|states|says|would|correctly|incorrectly|represents|confuses|mixes|reverses)\b"
)


def letter_references(text: str) -> Dict[str, List[str]]:
    """Option-letter mentions in `text`: strict (`Option C`, `(B)`) and loose (`C is`, `D gives`).

    Code and math spans are removed first, so an event named `$A$` does not count. A prose
    "A is ..." still does; that is the known false-positive cost of the loose pattern.
    """
    body = _MATH_SPAN.sub(" ", strip_code(text))
    return {
        "strict": [m.group(0).strip() for m in _STRICT_LETTER.finditer(body)],
        "loose": [m.group(0).strip() for m in _LOOSE_LETTER.finditer(body)],
    }


def mc_letter_reference_check(questions: List[dict]) -> Dict[str, object]:
    """Multiple-choice questions whose explanation names an option letter.

    The app shuffles options after the explanation is written, so such a reference can point at
    the wrong option (learning v2 stage 1B). Counts only multiple_choice questions.
    """
    mc = [(i, q) for i, q in enumerate(questions) if q.get("question_type") == "multiple_choice"]
    flagged = []
    strict_count = 0
    for i, question in mc:
        refs = letter_references(question.get("explanation", ""))
        if refs["strict"] or refs["loose"]:
            flagged.append({"index": i, "strict": refs["strict"], "loose": refs["loose"]})
        if refs["strict"]:
            strict_count += 1
    return {
        "multiple_choice": len(mc),
        "flagged": len(flagged),
        "flagged_strict": strict_count,
        "details": flagged,
    }


# ---------------------------------------------------------------------------- recall-copy

_NUMBER = re.compile(r"(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?|(?<![\w])\.\d+")
_IGNORED_NUMBERS = {0.0, 1.0, 2.0}


def significant_numbers(text: str) -> Set[str]:
    """Distinct numbers in `text`, as normalised strings, ignoring 0, 1 and 2."""
    found = set()
    for token in _NUMBER.findall(text or ""):
        value = float(token.replace(",", ""))
        if value in _IGNORED_NUMBERS:
            continue
        found.add(format(value, "g"))
    return found


_WORD = re.compile(r"[A-Za-z]{4,}")
_WINDOW_WORDS = 60
_MIN_WORD_SHARE = 0.4


def _windows(text: str, size: int = _WINDOW_WORDS) -> List[str]:
    """Overlapping windows of about `size` words (step size/2), so a passage is never split
    without also appearing whole in a neighbouring window."""
    words = (text or "").split()
    if len(words) <= size:
        return [" ".join(words)] if words else []
    step = size // 2
    return [" ".join(words[i : i + size]) for i in range(0, len(words) - step, step)]


def _content_words(text: str) -> Set[str]:
    return {w.lower() for w in _WORD.findall(text or "")}


def recall_copy_check(questions: List[dict], reference_text: str) -> Dict[str, object]:
    """Quiz questions that restate one of the topic's own worked examples or notes passages.

    A question counts when its question text has two or more significant numbers, and some
    window of about 60 words of `reference_text` (the topic's notes, worked examples and
    practice) contains every one of those numbers and at least 40% of the question's content
    words. Matching numbers alone is not enough: small numbers such as 3, 4 or 12 appear all
    over a set of notes, and a new scenario that happens to use them is transfer, not recall.
    The rate is over questions with two or more significant numbers.
    """
    windows = [(significant_numbers(w), _content_words(w)) for w in _windows(reference_text)]
    eligible = 0
    copied = []
    for i, question in enumerate(questions):
        text = question.get("question_text", "")
        numbers = significant_numbers(text)
        if len(numbers) < 2:
            continue
        eligible += 1
        words = _content_words(text)
        for window_numbers, window_words in windows:
            if numbers <= window_numbers and (
                not words or len(words & window_words) / len(words) >= _MIN_WORD_SHARE
            ):
                copied.append({"index": i, "numbers": sorted(numbers, key=float)})
                break
    return {
        "questions": len(questions),
        "with_numbers": eligible,
        "copied": len(copied),
        "rate": (len(copied) / eligible) if eligible else None,
        "details": copied,
    }


# ---------------------------------------------------------------------------- structure

_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$", re.M)
_BULLET = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S", re.M)


def notes_structure(
    text: str,
    sections: Iterable[str] = DEFAULT_NOTES_SECTIONS,
    word_band: Tuple[int, int] = DEFAULT_NOTES_WORD_BAND,
) -> Dict[str, object]:
    """Sections present, word count against the requested band, and recap bullets."""
    body = text or ""
    headings = [(len(m.group(1)), m.group(2).strip().rstrip(":").strip(), m.start()) for m in _HEADING.finditer(strip_code(body))]
    h2 = [name.lower() for level, name, _ in headings if level == 2]
    missing = [s for s in sections if not any(h.startswith(s.lower()) for h in h2)]
    words = word_count(body)

    # Bullets under the last "##" section (the recap).
    recap_bullets = 0
    last_h2 = [m for m in re.finditer(r"^##[ \t]+\S.*$", body, re.M)]
    if last_h2:
        recap_bullets = len(_BULLET.findall(body[last_h2[-1].end():]))
    return {
        "words": words,
        "word_band": list(word_band),
        "in_word_band": word_band[0] <= words <= word_band[1],
        "has_title": any(level == 1 for level, _, _ in headings),
        "sections_expected": list(sections),
        "sections_missing": missing,
        "sections_ok": not missing,
        "recap_bullets": recap_bullets,
        "recap_bullets_ok": 5 <= recap_bullets <= 8,
    }


def solved_structure(examples: List[dict], requested: int) -> Dict[str, object]:
    steps = [len(e.get("solution_steps") or []) for e in examples]
    return {
        "requested": requested,
        "count": len(examples),
        "count_ok": len(examples) == requested,
        "steps": steps,
        "mean_steps": (sum(steps) / len(steps)) if steps else 0.0,
        "missing_final_answer": sum(1 for e in examples if not str(e.get("final_answer", "")).strip()),
    }


def interactive_structure(examples: List[dict], requested: int, difficulty: str = "medium") -> Dict[str, object]:
    band = INTERACTIVE_STEP_BANDS.get(difficulty, INTERACTIVE_STEP_BANDS["medium"])
    steps = [len(e.get("steps") or []) for e in examples]
    return {
        "requested": requested,
        "count": len(examples),
        "count_ok": len(examples) == requested,
        "steps": steps,
        "mean_steps": (sum(steps) / len(steps)) if steps else 0.0,
        "step_band": list(band),
        "problems_in_step_band": sum(1 for n in steps if band[0] <= n <= band[1]),
    }


def quiz_structure(questions: List[dict], requested: int, requested_types: Iterable[str]) -> Dict[str, object]:
    types = Counter(q.get("question_type") for q in questions)
    wanted = list(requested_types)
    mc = [q for q in questions if q.get("question_type") == "multiple_choice"]
    return {
        "requested": requested,
        "count": len(questions),
        "count_ok": len(questions) == requested,
        "types": dict(types),
        "types_missing": [t for t in wanted if types.get(t, 0) == 0],
        "mc_not_four_options": sum(1 for q in mc if len(q.get("options") or []) != 4),
    }


# ---------------------------------------------------------------------------- grounding proxy

# Common English words of five or more letters that say nothing about the course.
_STOPWORDS = frozenset(
    """
    about above after again against along already also always another around because before being below between
    both cannot could does doing during each either else enough every first from further given gives going
    great having here high however into itself keep know large later least less like likely little looks made
    make many might more most much must need never next often once only other others over perhaps place rather
    really right same several shall should since small some something sometimes still such take taken than that
    their them then there these they thing things think this those though three through thus together under
    until upon using usually very want well were what when where whether which while whose will with within
    without would write your yourself
    """.split()
)
_WORD = re.compile(r"[A-Za-z][A-Za-z'-]{4,}")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_MATH_TOKEN = re.compile(r"\d{2,}|[A-Za-z]{2,}")


def excerpt_terms(texts: Iterable[str]) -> Set[str]:
    """Lowercase words of 5+ letters in the excerpts, minus a stoplist of common English."""
    terms: Set[str] = set()
    for text in texts:
        for word in _WORD.findall(text or ""):
            low = word.lower().strip("'-")
            if low not in _STOPWORDS:
                terms.add(low)
    return terms


def grounding_share(notes: str, excerpts: List[str]) -> Dict[str, object]:
    """Share of notes sentences that share vocabulary with the topic's excerpts.

    A sentence counts as grounded when it contains two or more terms that appear in the
    excerpts (see `excerpt_terms`), or a `$...$` math expression with a word or number
    (two or more characters, for example `Var` or `100`) that also appears in the excerpts.
    Headings, code blocks and very short lines are skipped. This is a cheap lexical overlap,
    not a faithfulness measure: a sentence can pass while being wrong, and a correct restatement
    in new words can fail.
    """
    terms = excerpt_terms(excerpts)
    excerpt_math_tokens = {t.lower() for text in excerpts for t in _MATH_TOKEN.findall(text or "")}
    body = "\n".join(
        line for line in strip_code(notes).splitlines() if not line.lstrip().startswith("#")
    )
    sentences = [s.strip(" -*>\t") for s in _SENTENCE_SPLIT.split(body)]
    sentences = [s for s in sentences if len(s.split()) >= 4]
    grounded = 0
    for sentence in sentences:
        shared = {w.lower().strip("'-") for w in _WORD.findall(sentence)} & terms
        if len(shared) >= 2:
            grounded += 1
            continue
        for expr in _MATH_SPAN.findall(sentence):
            tokens = {t.lower() for t in _MATH_TOKEN.findall(expr)}
            if tokens & excerpt_math_tokens:
                grounded += 1
                break
    return {
        "sentences": len(sentences),
        "grounded": grounded,
        "share": (grounded / len(sentences)) if sentences else None,
    }


# ---------------------------------------------------------------------------- cross-topic overlap

_TOKEN = re.compile(r"[a-z0-9]+")


def token_jaccard(a: str, b: str) -> float:
    left, right = set(_TOKEN.findall(a.lower())), set(_TOKEN.findall(b.lower()))
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def near_duplicate_statements(
    statements_by_topic: Dict[str, List[str]], threshold: float = 0.6
) -> List[Dict[str, object]]:
    """Pairs of problem statements in different topics with token Jaccard above `threshold`."""
    topics = list(statements_by_topic)
    pairs = []
    for a in range(len(topics)):
        for b in range(a + 1, len(topics)):
            for i, left in enumerate(statements_by_topic[topics[a]]):
                for j, right in enumerate(statements_by_topic[topics[b]]):
                    score = token_jaccard(left, right)
                    if score > threshold:
                        pairs.append(
                            {
                                "topic_a": topics[a],
                                "index_a": i,
                                "topic_b": topics[b],
                                "index_b": j,
                                "jaccard": round(score, 3),
                            }
                        )
    return pairs


# ---------------------------------------------------------------------------- concept graph
#
# Shapes (what adapters.read_concept_graph stores for the `concepts` type):
#
#     {"objective_count": int,
#      "concepts": [{id, name, objective_indexes}],
#      "claims":   [{concept_id, chunk_id, quote}],
#      "edges":    [{source_id, target_id, type}]}
#
# Items are the generators' stored dicts; each carries `concept_ids` (and its steps and
# multiple-choice options may carry `concept_ids` / `confusable_concept_id`).

_QUOTE_MARKS = str.maketrans(
    {
        "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
        "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
        "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-",
        "−": "-",
    }
)


def normalize_quote(text: str) -> str:
    """Whitespace collapsed and curly quotes and dashes made ASCII, the way the app matches a quote
    to its chunk (concepts/validate.py `normalize`)."""
    return re.sub(r"\s+", " ", (text or "").translate(_QUOTE_MARKS)).strip()


def claim_quote_substring_rate(claims: List[dict], chunk_texts: Dict[str, str]) -> Dict[str, object]:
    """Share of claim quotes that appear in the chunk they name. Gate: at least 98%.

    A claim whose chunk is not among the topic's excerpts counts as a miss. No claims is a pass
    (the topic has no graph to judge)."""
    chunks = {chunk_id: normalize_quote(text) for chunk_id, text in chunk_texts.items()}
    failures = []
    for claim in claims:
        quote = normalize_quote(claim.get("quote", ""))
        text = chunks.get(claim.get("chunk_id"))
        if not quote or text is None or quote not in text:
            failures.append({"concept_id": claim.get("concept_id"), "chunk_id": claim.get("chunk_id"), "quote": (claim.get("quote") or "")[:120]})
    total = len(claims)
    matched = total - len(failures)
    rate = (matched / total) if total else None
    return {"total": total, "matched": matched, "rate": rate, "ok": rate is None or rate >= CLAIM_QUOTE_GATE, "failures": failures}


def concepts_per_topic_in_range(concepts: List[dict], bounds: Tuple[int, int] = CONCEPTS_PER_TOPIC) -> Dict[str, object]:
    low, high = bounds
    return {"count": len(concepts), "range": [low, high], "ok": low <= len(concepts) <= high}


def objectives_all_mapped(concepts: List[dict], objective_count: int) -> Dict[str, object]:
    """Every objective index 0..objective_count-1 is served by at least one concept."""
    mapped = {i for concept in concepts for i in concept.get("objective_indexes") or []}
    unmapped = [i for i in range(objective_count) if i not in mapped]
    return {"objectives": objective_count, "unmapped": unmapped, "ok": not unmapped}


def prereq_graph_acyclic(edges: List[dict]) -> Dict[str, object]:
    """No directed cycle among the `prerequisite` edges. `cycle` lists the concept ids on one."""
    out: Dict[str, List[str]] = {}
    for edge in edges:
        if edge.get("type") == "prerequisite":
            out.setdefault(edge["source_id"], []).append(edge["target_id"])
    state: Dict[str, int] = {}  # 1 on the current path, 2 finished

    def visit(node: str, path: List[str]) -> Optional[List[str]]:
        state[node] = 1
        for nxt in out.get(node, []):
            if state.get(nxt) == 1:
                return path[path.index(nxt):]  # a node in state 1 is on the current path
            if nxt not in state:
                found = visit(nxt, path + [nxt])
                if found:
                    return found
        state[node] = 2
        return None

    for node in list(out):
        if node not in state:
            cycle = visit(node, [node])
            if cycle:
                return {"ok": False, "cycle": cycle}
    return {"ok": True, "cycle": []}


def item_concept_ids_valid(items_by_type: Dict[str, List[dict]], known_ids: Iterable[str]) -> Dict[str, object]:
    """Share of items whose concept tags are all real concepts of the topic. Gate: 100%.

    An item is invalid when a tag (on the item, on one of its steps, or an option's
    `confusable_concept_id`) is not a known id, or when it has no tag at all. The exception is a
    review question on a prerequisite topic (`prerequisite_topic` set), which keeps none on purpose.
    """
    known = set(known_ids)
    invalid = []
    total = 0
    for content_type, items in items_by_type.items():
        for index, item in enumerate(items or []):
            total += 1
            ids = item.get("concept_ids") or []
            stray = [i for i in ids if i not in known]
            for step in item.get("steps") or []:
                stray += [i for i in step.get("concept_ids") or [] if i not in known]
            for option in item.get("options") or []:
                other = option.get("confusable_concept_id")
                if other is not None and other not in known:
                    stray.append(other)
            untagged = not ids and not item.get("prerequisite_topic")
            if stray or untagged:
                invalid.append({"path": f"{content_type}[{index}]", "reason": "unknown id" if stray else "no concept_ids", "ids": stray})
    valid = total - len(invalid)
    return {"total": total, "valid": valid, "rate": (valid / total) if total else None, "ok": not invalid, "invalid": invalid}


def warmup_not_in_quiz(warmup: List[dict], quiz: List[dict], threshold: float = WARMUP_REUSE_JACCARD) -> Dict[str, object]:
    """Warm-up questions the topic quiz repeats (the same wording, or a light rewording: token
    Jaccard at or above `threshold`). The warm-up is a pretest; a quiz that reuses it measures
    memory of the pretest."""
    pairs = []
    for i, w in enumerate(warmup or []):
        for j, q in enumerate(quiz or []):
            score = token_jaccard(w.get("question_text", ""), q.get("question_text", ""))
            if score >= threshold:
                pairs.append({"warmup_index": i, "quiz_index": j, "jaccard": round(score, 2)})
                break
    return {"reused": len(pairs), "pairs": pairs, "ok": not pairs}


# ---------------------------------------------------------------------------- one model, all topics


def problem_statements(solved: Optional[list], interactive: Optional[list]) -> List[str]:
    return [e.get("problem_statement", "") for e in (solved or []) + (interactive or []) if e.get("problem_statement")]


def check_topic(
    outputs: Dict[str, object],
    excerpts: List[str],
    *,
    requested: Optional[Dict[str, object]] = None,
    notes_sections: Iterable[str] = DEFAULT_NOTES_SECTIONS,
    notes_word_band: Tuple[int, int] = DEFAULT_NOTES_WORD_BAND,
    chunk_texts: Optional[Dict[str, str]] = None,
) -> Dict[str, object]:
    """All checks for one model and one topic. `outputs` maps content type to generator output;
    a type that failed or was not generated is simply absent."""
    requested = {"examples": 3, "questions": 10, "difficulty": "medium", **(requested or {})}
    result: Dict[str, object] = {"types": sorted(outputs)}

    hygiene = {t: latex_hygiene(t, out) for t, out in outputs.items() if t != CONCEPTS}
    result["latex"] = {
        kind: sum(len(h[kind]) for h in hygiene.values())
        for kind in ("plain_text_latex", "unbalanced_dollar", "bare_currency")
    }
    result["latex_details"] = {t: {k: v for k, v in h.items() if v} for t, h in hygiene.items() if any(h.values())}

    if NOTES in outputs:
        result["notes"] = notes_structure(outputs[NOTES], notes_sections, notes_word_band)
        result["grounding"] = grounding_share(outputs[NOTES], excerpts)
    if SOLVED in outputs:
        result["solved"] = solved_structure(outputs[SOLVED], requested["examples"])
    if INTERACTIVE in outputs:
        result["interactive"] = interactive_structure(outputs[INTERACTIVE], requested["examples"], requested["difficulty"])
    if QUIZ in outputs:
        quiz = outputs[QUIZ]
        result["quiz"] = quiz_structure(
            quiz,
            requested["questions"],
            requested.get("question_types") or ["multiple_choice", "short_answer", "numerical", "true_false"],
        )
        result["mc_letter_refs"] = mc_letter_reference_check(quiz)
        reference = "\n".join(
            all_text(t, outputs[t]) for t in (NOTES, SOLVED, INTERACTIVE) if t in outputs
        )
        result["recall_copy"] = (
            recall_copy_check(quiz, reference) if reference.strip() else {"skipped": "no notes or examples to compare with"}
        )

    graph = outputs.get(CONCEPTS)
    if graph is not None:
        concepts = graph.get("concepts") or []
        result["concepts"] = {
            "claim_quotes": claim_quote_substring_rate(graph.get("claims") or [], chunk_texts or {}),
            "count": concepts_per_topic_in_range(concepts),
            "objectives": objectives_all_mapped(concepts, graph.get("objective_count", 0)),
            "prereq_acyclic": prereq_graph_acyclic(graph.get("edges") or []),
        }
        # Tags are only checkable against a graph. A topic without one (extraction failed) has
        # items with empty lists on purpose.
        tagged = {t: outputs[t] for t in (WARMUP, SOLVED, INTERACTIVE, QUIZ) if t in outputs}
        if tagged:
            result["item_concept_ids"] = item_concept_ids_valid(tagged, [c["id"] for c in concepts])
    if WARMUP in outputs and QUIZ in outputs:
        result["warmup_not_in_quiz"] = warmup_not_in_quiz(outputs[WARMUP], outputs[QUIZ])
    return result


def summarize_model(per_topic: Dict[str, Dict[str, object]], statements: Dict[str, List[str]]) -> Dict[str, object]:
    """Totals over one model's topics, from `check_topic` results.

    `statements` maps topic key to the worked-example and practice problem statements the model
    wrote for it, for the cross-topic overlap check.
    """

    def total(path: Tuple[str, ...]) -> int:
        n = 0
        for result in per_topic.values():
            node = result
            for key in path:
                node = node.get(key) if isinstance(node, dict) else None
            if isinstance(node, (int, float)) and not isinstance(node, bool):
                n += node
        return n

    def mean(path: Tuple[str, ...]) -> Optional[float]:
        values = []
        for result in per_topic.values():
            node = result
            for key in path:
                node = node.get(key) if isinstance(node, dict) else None
            if isinstance(node, (int, float)) and not isinstance(node, bool):
                values.append(float(node))
        return (sum(values) / len(values)) if values else None

    notes = [r["notes"] for r in per_topic.values() if "notes" in r]
    quizzes = [r["quiz"] for r in per_topic.values() if "quiz" in r]
    copies = [r["recall_copy"] for r in per_topic.values() if isinstance(r.get("recall_copy"), dict) and "rate" in r["recall_copy"]]
    eligible = sum(c["with_numbers"] for c in copies)
    copied = sum(c["copied"] for c in copies)
    mc_total = total(("mc_letter_refs", "multiple_choice"))
    pairs = near_duplicate_statements(statements)
    graphs = [r["concepts"] for r in per_topic.values() if "concepts" in r]
    tags = [r["item_concept_ids"] for r in per_topic.values() if "item_concept_ids" in r]
    claims_total = sum(g["claim_quotes"]["total"] for g in graphs)
    claims_matched = sum(g["claim_quotes"]["matched"] for g in graphs)
    items_tagged = sum(t["total"] for t in tags)
    items_valid = sum(t["valid"] for t in tags)
    warmups = [r["warmup_not_in_quiz"] for r in per_topic.values() if "warmup_not_in_quiz" in r]
    return {
        "concept_topics": len(graphs),
        "concept_count_ok": sum(1 for g in graphs if g["count"]["ok"]),
        "concept_count_mean": (sum(g["count"]["count"] for g in graphs) / len(graphs)) if graphs else None,
        "claims_total": claims_total,
        "claims_matched": claims_matched,
        "claim_quote_rate": (claims_matched / claims_total) if claims_total else None,
        "claim_quote_gate_ok": (claims_matched / claims_total >= CLAIM_QUOTE_GATE) if claims_total else None,
        "objectives_mapped_ok": sum(1 for g in graphs if g["objectives"]["ok"]),
        "prereq_acyclic_ok": sum(1 for g in graphs if g["prereq_acyclic"]["ok"]),
        "items_tagged": items_tagged,
        "items_tagged_valid": items_valid,
        "item_concept_id_rate": (items_valid / items_tagged) if items_tagged else None,
        "item_tag_gate_ok": (items_valid == items_tagged) if items_tagged else None,
        "warmup_topics": sum(1 for r in per_topic.values() if "warmup" in r.get("types", [])),
        "warmup_vs_quiz_topics": len(warmups),
        "warmup_reused_items": sum(w["reused"] for w in warmups),
        "warmup_reuse_gate_ok": (not any(w["reused"] for w in warmups)) if warmups else None,
        "topics": len(per_topic),
        "plain_text_latex_fields": total(("latex", "plain_text_latex")),
        "unbalanced_dollar_fields": total(("latex", "unbalanced_dollar")),
        "bare_currency_fields": total(("latex", "bare_currency")),
        "mc_questions": mc_total,
        "mc_letter_refs": total(("mc_letter_refs", "flagged")),
        "mc_letter_refs_strict": total(("mc_letter_refs", "flagged_strict")),
        "quiz_numeric_questions": eligible,
        "quiz_recall_copied": copied,
        "quiz_recall_copy_rate": (copied / eligible) if eligible else None,
        "notes_words_mean": (sum(n["words"] for n in notes) / len(notes)) if notes else None,
        "notes_in_word_band": sum(1 for n in notes if n["in_word_band"]),
        "notes_sections_ok": sum(1 for n in notes if n["sections_ok"]),
        "notes_count": len(notes),
        "notes_recap_bullets_ok": sum(1 for n in notes if n["recap_bullets_ok"]),
        "quiz_count_ok": sum(1 for q in quizzes if q["count_ok"]),
        "quiz_count": len(quizzes),
        "solved_count_ok": sum(1 for r in per_topic.values() if "solved" in r and r["solved"]["count_ok"]),
        "solved_count": sum(1 for r in per_topic.values() if "solved" in r),
        "interactive_count_ok": sum(1 for r in per_topic.values() if "interactive" in r and r["interactive"]["count_ok"]),
        "interactive_count": sum(1 for r in per_topic.values() if "interactive" in r),
        "grounding_share_mean": mean(("grounding", "share")),
        "duplicate_example_pairs": len(pairs),
        "duplicate_example_details": pairs,
    }


# ---------------------------------------------------------------------------- item defects (A2)
#
# Faults one generated item can have that no reader should meet, found without a model. A2 counts them per generator on
# what the model wrote and on what the app kept; the quality gate's stage 1 (plan Q1) runs the same tests in the app.

# The model thinking aloud in text a student reads. "wait" only at the start of a sentence (a queue's "expected wait" is
# not), "let me" only with a redo verb, "actually" only when it takes back what came before.
_SELF_CORRECTION = re.compile(
    r"(?:^|[.!?:;]\s+|\n)\s*(?:no,?\s+)?wait\b[,.!:;—-]"
    r"|\bhmm+\b|\boops\b|\bon second thought\b|\bscratch that\b|\bcorrection\s*:"
    r"|\bI (?:made|have made) (?:an?|a small) (?:error|mistake)\b"
    r"|\blet me (?:re-?check|re-?compute|re-?calculate|re-?consider|re-?do|re-?read|re-?examine|re-?verify|try (?:that |this )?again|correct (?:that|this|myself)|fix (?:that|this))\b"
    r"|\bactually,?\s+(?:that(?:'s| is)|this is|it(?:'s| is)) (?:not|wrong|incorrect)\b",
    re.IGNORECASE,
)
# A past exam's header: "Problem 3. [5 points]" or "(4 points)" anywhere, or "Problem 3." / "**Question 2:**" at the start.
_POINTS_HEADER = re.compile(
    r"(?:\b(?:problem|question|q)\s*\d+[.:)]?\s*)?[\[(]\s*\d+(?:\.\d+)?\s*(?:points?|pts?|marks?)\s*[\])]", re.IGNORECASE
)
_LEADING_HEADER = re.compile(r"^\s*(?:\*\*|__)?\s*(?:problem|question)\s+\d+\s*[.:)]", re.IGNORECASE)
_FRACTION = re.compile(r"^(-?\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)$")
_TEX_FRACTION = re.compile(r"^(-?)\\d?frac\{(-?\d+(?:\.\d+)?)\}\{(\d+(?:\.\d+)?)\}$")
# The correct option is a tell when it is the only longest one and this much longer than every wrong one.
LONGEST_TELL_RATIO = 1.3
QUESTION_DEFECTS = (
    "self_correction",
    "exam_header",
    "answer_not_in_options",
    "two_correct_options",
    "duplicate_options",
    "longest_option_tell",
)


def self_correction_phrases(text: str) -> List[str]:
    return [m.group(0).strip(" .,;:\n") for m in _SELF_CORRECTION.finditer(text or "")]


def exam_header_hits(text: str) -> List[str]:
    hits = [m.group(0) for m in _POINTS_HEADER.finditer(text or "")]
    leading = _LEADING_HEADER.match(text or "")
    return hits + ([leading.group(0).strip()] if leading and not hits else [])


def _plain_option(text: str) -> str:
    plain = re.sub(r"\s+", " ", (text or "").replace("$", "").strip().lower())
    return plain.rstrip(".").strip()


def _option_value(text: str) -> Optional[float]:
    plain = _plain_option(text).replace(" ", "").replace(",", "")
    try:
        if plain.endswith("%"):
            return float(plain[:-1]) / 100
        return float(plain)
    except ValueError:
        pass
    fraction = _FRACTION.match(plain)
    tex = _TEX_FRACTION.match(plain)
    try:
        if fraction:
            return float(fraction.group(1)) / float(fraction.group(2))
        if tex:
            value = float(tex.group(2)) / float(tex.group(3))
            return -value if tex.group(1) else value
    except ZeroDivisionError:
        return None
    return None


def same_option(a: str, b: str) -> bool:
    """Two options that say the same thing: the same text (case, spacing, `$` and a final full stop aside) or the
    same number written two ways ("0.5", "1/2", "\\frac{1}{2}", "50%")."""
    if _plain_option(a) == _plain_option(b):
        return True
    x, y = _option_value(a), _option_value(b)
    return x is not None and y is not None and abs(x - y) <= 1e-9 * max(1.0, abs(x))


def _question_texts(question: dict) -> List[str]:
    texts = [question.get("question_text", ""), question.get("explanation", ""), question.get("sample_answer") or ""]
    texts += [o.get("text", "") for o in question.get("options") or []]
    return texts


def question_defects(question: dict) -> List[str]:
    """The faults of one question (as the model wrote it or as the app stored it), in QUESTION_DEFECTS order."""
    found = set()
    if any(self_correction_phrases(text) for text in _question_texts(question)):
        found.add("self_correction")
    if exam_header_hits(question.get("question_text", "")):
        found.add("exam_header")
    if question.get("question_type") == "multiple_choice":
        options = [o for o in question.get("options") or [] if str(o.get("id", "")).strip()]
        ids = [str(o["id"]).strip().upper() for o in options]
        answer = str(question.get("correct_answer") or "").strip().upper()
        if answer not in ids:
            found.add("answer_not_in_options")
        for i, first in enumerate(options):
            for j in range(i + 1, len(options)):
                if same_option(first.get("text", ""), options[j].get("text", "")):
                    found.add("two_correct_options" if answer in (ids[i], ids[j]) else "duplicate_options")
        if answer in ids and len(options) >= 2:
            lengths = [len(_plain_option(o.get("text", ""))) for o in options]
            key = lengths[ids.index(answer)]
            wrong = [n for k, n in zip(ids, lengths) if k != answer]
            if key > max(wrong) and key >= LONGEST_TELL_RATIO * max(wrong):
                found.add("longest_option_tell")
    return [code for code in QUESTION_DEFECTS if code in found]


def problem_defects(content_type: str, problem: dict) -> List[str]:
    """Faults of one worked example or practice problem: thinking aloud anywhere, an exam header in its statement."""
    texts = [text for _, text, _ in iter_text_fields(content_type, [problem])]
    for step in problem.get("steps") or []:
        texts += [str(h) for h in step.get("hints") or []]
    found = []
    if any(self_correction_phrases(text) for text in texts):
        found.append("self_correction")
    if exam_header_hits(problem.get("problem_statement", "")):
        found.append("exam_header")
    return found


def _correct_is_longest(question: dict) -> Optional[bool]:
    options = question.get("options") or []
    ids = [str(o.get("id", "")).strip().upper() for o in options]
    answer = str(question.get("correct_answer") or "").strip().upper()
    if answer not in ids or len(options) < 2:
        return None
    lengths = [len(_plain_option(o.get("text", ""))) for o in options]
    key = lengths[ids.index(answer)]
    return key > max(n for k, n in zip(ids, lengths) if k != answer)


def item_set_report(questions: List[dict]) -> Dict[str, object]:
    """Faults over a set of questions, how often the correct option is the only longest one (against what chance gives:
    one in the number of options), and the share of true/false items (a coin flip answers half of them)."""
    defects = [question_defects(q) for q in questions]
    by_defect = Counter(code for found in defects for code in found)
    mc = [q for q in questions if q.get("question_type") == "multiple_choice"]
    longest = [x for x in (_correct_is_longest(q) for q in mc) if x is not None]
    true_false = sum(1 for q in questions if q.get("question_type") == "true_false")
    flagged = sum(1 for found in defects if found)
    return {
        "items": len(questions),
        "flagged": flagged,
        "flagged_rate": (flagged / len(questions)) if questions else None,
        "by_defect": dict(sorted(by_defect.items())),
        "multiple_choice": len(mc),
        "correct_longest": sum(longest),
        "chance_longest": sum(1 / len(q.get("options") or [None]) for q in mc),
        "true_false": true_false,
        "true_false_share": (true_false / len(questions)) if questions else None,
    }


def problem_set_report(content_type: str, problems: List[dict]) -> Dict[str, object]:
    defects = [problem_defects(content_type, p) for p in problems]
    flagged = sum(1 for found in defects if found)
    return {
        "items": len(problems),
        "flagged": flagged,
        "flagged_rate": (flagged / len(problems)) if problems else None,
        "by_defect": dict(sorted(Counter(code for found in defects for code in found).items())),
    }

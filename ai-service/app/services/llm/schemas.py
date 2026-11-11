"""Output schemas for every structured LLM call.

Claude's structured outputs constrain the response to these schemas. Rules the JSON
schema cannot express (an MCQ answer must be one of its options, a numerical answer
must be a number) are checked in code after parsing, per item, so one bad question
is dropped instead of failing the whole set.
"""
import hashlib
import math
import random
import re
from html import unescape
from typing import Any, Dict, List, Literal, Optional, Sequence, Type, TypeVar, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.json_schema import SkipJsonSchema

QuestionType = Literal["multiple_choice", "short_answer", "numerical", "true_false"]


def _clean_list(values: List[str]) -> List[str]:
    return [value.strip() for value in values if value and value.strip()]


def _as_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
        return value.strip().lower() == "true"
    return None


def _as_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.replace(",", "").strip())
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _excerpt_indexes(values: Any) -> List[int]:
    """Clean 1-based excerpt indexes: positive integers, once each, in the order given."""
    cleaned: List[int] = []
    for value in values or []:
        number = _as_number(value)
        if number is not None and number >= 1 and float(number).is_integer() and int(number) not in cleaned:
            cleaned.append(int(number))
    return cleaned


def _clean_ids(values: Any) -> List[str]:
    """Concept ids as the model wrote them: trimmed, once each, in the order given."""
    cleaned: List[str] = []
    for value in values or []:
        text = str(value).strip()
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned


CONCEPT_IDS_HELP = (
    "ids of the concepts this tests, primary concept first, copied from the <concepts> list; "
    "leave empty when there is no list"
)

ItemMode = Literal["recall", "discrimination", "composition"]

SOURCE_EXCERPTS_HELP = (
    "1-based indexes of the source excerpts this is based on (the index attribute of each excerpt)"
)


# ---------------------------------------------------------------- questions


class ChoiceOption(BaseModel):
    id: str = Field(description="Option letter: A, B, C or D")
    text: str
    misconception: Optional[str] = Field(
        default=None,
        description=(
            "Wrong options only: the one specific wrong idea a student holds when they pick this "
            "option, written as that idea. Leave out on the correct option"
        ),
    )
    confusable_concept_id: Optional[str] = Field(
        default=None,
        description=(
            "Wrong options only: when the wrong idea is a mix-up with another concept of the "
            "<concepts> list, that concept's id"
        ),
    )


# A past exam heads each problem "Problem 3. [5 points]". The app numbers and scores questions itself, so a copied
# header would contradict both ("Problem 3" is question 12; "[5 points]" sits beside "4 pts").
_EXAM_HEADER = re.compile(
    r"^\s*(\*\*|__)?\s*(?:problem|question|q)\s*\d+[.:)]?\s*[\[(]\s*\d+(?:\.\d+)?\s*(?:points?|pts?|marks?)\s*[\])]\s*[.:\-–—]?\s*",
    re.IGNORECASE,
)


def strip_exam_header(text: str) -> str:
    """`text` without a leading past-exam header such as "Problem 3. [5 points]"; a bold title after it stays."""
    stripped = _EXAM_HEADER.sub(lambda m: m.group(1) or "", text, count=1)
    if stripped == text:
        return text
    return re.sub(r"^(\*\*|__)\s*\1", "", stripped.strip()).strip()


class GeneratedQuestion(BaseModel):
    """One quiz or exam question. Fields that do not apply to the type are left out."""

    question_type: QuestionType
    question_text: str
    options: List[ChoiceOption] = Field(
        default_factory=list, description="multiple_choice only: exactly 4 options A-D"
    )
    correct_answer: Union[str, float, bool, None] = Field(
        default=None,
        description=(
            "multiple_choice: the correct option id; numerical: a number; "
            "true_false: a boolean; short_answer: omit"
        ),
    )
    sample_answer: Optional[str] = Field(default=None, description="short_answer only")
    key_points: List[str] = Field(default_factory=list, description="short_answer only")
    unit: Optional[str] = Field(default=None, description="numerical only")
    tolerance: Optional[float] = Field(
        default=None, description="numerical only: accepted absolute difference"
    )
    explanation: str
    points: int = Field(default=1, description="1-5, by complexity")
    difficulty: Optional[str] = None
    concepts_tested: List[str] = Field(default_factory=list)
    concept_ids: List[str] = Field(default_factory=list, description=CONCEPT_IDS_HELP)
    mode: ItemMode = Field(
        default="recall",
        description=(
            "recall: bring the idea to mind in a new situation; discrimination: choose between "
            "near-twin ideas; composition: use the idea together with others in one chain"
        ),
    )
    source_excerpts: List[int] = Field(default_factory=list, description=SOURCE_EXCERPTS_HELP)

    def normalized(self) -> Optional[Dict[str, Any]]:
        """The stored question dict, or None when the question is unusable. A multiple-choice
        question whose wrong option does not name its misconception is unusable: the results
        page and the concept's misconception tracking both depend on it."""
        text = strip_exam_header(self.question_text.strip())
        if not text or not self.explanation.strip():
            return None
        stored: Dict[str, Any] = {
            "question_type": self.question_type,
            "question_text": text,
            "explanation": self.explanation.strip(),
            "points": min(max(int(self.points or 1), 1), 5),
            "concepts_tested": _clean_list(self.concepts_tested),
            "concept_ids": _clean_ids(self.concept_ids),
            "mode": self.mode,
        }
        if self.difficulty:
            stored["difficulty"] = self.difficulty
        excerpts = _excerpt_indexes(self.source_excerpts)
        if excerpts:
            # The generator turns these into `sources` (file and pages) before anything is stored.
            stored["source_excerpts"] = excerpts

        if self.question_type == "multiple_choice":
            options = [o for o in self.options if o.id.strip() and o.text.strip()]
            ids = [o.id.strip().upper() for o in options]
            answer = str(self.correct_answer or "").strip().upper()
            texts = [o.text.strip().lower() for o in options]
            if len(options) < 3 or len(set(ids)) != len(ids) or len(set(texts)) != len(texts) or answer not in ids:
                return None
            stored_options = []
            for option in options:
                entry = {"id": option.id.strip().upper(), "text": option.text.strip()}
                if entry["id"] != answer:
                    misconception = (option.misconception or "").strip()
                    if not misconception:
                        return None
                    entry["misconception"] = misconception
                    confusable = (option.confusable_concept_id or "").strip()
                    if confusable:
                        entry["confusable_concept_id"] = confusable
                stored_options.append(entry)
            stored["options"] = stored_options
            stored["correct_answer"] = answer
        elif self.question_type == "true_false":
            answer = _as_bool(self.correct_answer)
            if answer is None:
                return None
            stored["correct_answer"] = answer
        elif self.question_type == "numerical":
            answer = _as_number(self.correct_answer)
            if answer is None:
                return None
            stored["correct_answer"] = answer
            if self.unit:
                stored["unit"] = self.unit.strip()
            if self.tolerance is not None and math.isfinite(self.tolerance):
                stored["tolerance"] = abs(self.tolerance)
        else:  # short_answer
            sample = (self.sample_answer or "").strip()
            key_points = _clean_list(self.key_points)
            if not sample or not key_points:
                return None
            stored["sample_answer"] = sample
            stored["key_points"] = key_points
        return stored


# Spans the letter rewrite leaves alone: math (an event called A is not option A) and code.
_PROTECTED_SPAN = re.compile(r"\$\$.*?\$\$|\$[^$\n]+\$|`[^`\n]*`", re.DOTALL)
# Placeholders hold the new letter's index as a digit, so no later pattern can match them.
_MARK_OPEN, _MARK_CLOSE = "", ""
_MARK = re.compile(f"{_MARK_OPEN}(\\d+){_MARK_CLOSE}")
_LETTER = re.compile(r"[A-D]")

# "Option C", "choice (B)", "Options A and C": the letters after the word.
_NAMED_OPTION = re.compile(
    r"\b((?:[Oo]ptions?|[Cc]hoices?|[Aa]nswers?)\s+)"
    r"(\(?[A-D]\)?(?:\s*(?:,|and|or|&|/)\s*\(?[A-D]\)?)*)(?![A-Za-z])"
)
# "(C)" on its own, but not the A in P(A).
_PAREN_LETTER = re.compile(r"(?<![\w$\\])\(([A-D])\)(?!\w)")
# "C) text" at the start of a line.
_LINE_LETTER = re.compile(r"(?m)^(\s*(?:[-*]\s+)?)([A-D])\)")
# "D is the addition rule", "B describes disjoint events".
_LETTER_VERB = re.compile(
    r"(?<![\w$\\'.])([A-D])"
    r"(?=\s+(?:is|isn't|isn’t|describes|gives|states|shows|represents|restates|matches|would|correctly)\b)"
)


def rewrite_option_letters(text: str, mapping: Dict[str, str]) -> str:
    """Point option-letter references in `text` at the options' new letters.

    Every reference becomes a placeholder first and the new letter only at the end, so
    A->C and C->A cannot collide. Math and code spans are left as they are.
    """
    old_letters = list(mapping)

    def hold(letter: str) -> str:
        if letter not in mapping:
            return letter
        return f"{_MARK_OPEN}{old_letters.index(letter)}{_MARK_CLOSE}"

    def rewrite(chunk: str) -> str:
        chunk = _NAMED_OPTION.sub(
            lambda m: m.group(1) + _LETTER.sub(lambda letter: hold(letter.group(0)), m.group(2)), chunk
        )
        chunk = _PAREN_LETTER.sub(lambda m: f"({hold(m.group(1))})", chunk)
        chunk = _LINE_LETTER.sub(lambda m: f"{m.group(1)}{hold(m.group(2))})", chunk)
        return _LETTER_VERB.sub(lambda m: hold(m.group(1)), chunk)

    parts: List[str] = []
    last = 0
    for span in _PROTECTED_SPAN.finditer(text):
        parts.append(rewrite(text[last : span.start()]))
        parts.append(span.group(0))
        last = span.end()
    parts.append(rewrite(text[last:]))
    return _MARK.sub(lambda m: mapping[old_letters[int(m.group(1))]], "".join(parts))


def content_rng(parts: Sequence[str]) -> random.Random:
    """A generator fixed by `parts`: shuffles of the same content always come out the same."""
    return random.Random(int.from_bytes(hashlib.sha256("\n".join(parts).encode()).digest()[:8], "big"))


def shuffle_choice_options(
    question: Dict[str, Any],
    rng: Optional[random.Random] = None,
    *,
    multiple_choice: bool = False,
    letter_fields: Sequence[str] = ("explanation",),
) -> Dict[str, Any]:
    """Shuffle a multiple-choice question's options and relabel them A, B, C...

    Models put the right answer in the same slot far more often than chance would, so
    the stored key is reshuffled. The explanation (and any per-option feedback) was written
    against the old letters, so letter references in it are moved to the new ones. Other
    question types are returned unchanged. `multiple_choice=True` treats a dict without a
    question_type (a practice step) as multiple choice; `letter_fields` are the text fields whose
    letter references are rewritten.

    Without `rng`, the order comes from the question's own text: the same question is always
    shuffled the same way (so a course built twice, or a replayed run, stores the same
    questions), and the answer's slot is still spread across questions.
    """
    options = question.get("options")
    if not options or not (multiple_choice or question.get("question_type") == "multiple_choice"):
        return question
    rng = rng or content_rng(
        [str(question.get("question_text") or question.get("question") or question.get("prompt") or "")]
        + [str(option.get("text")) for option in options]
    )
    order = list(range(len(options)))
    rng.shuffle(order)
    labels = [chr(ord("A") + i) for i in range(len(options))]
    mapping = {options[old]["id"]: labels[new] for new, old in enumerate(order)}
    question["options"] = [{**options[old], "id": labels[new]} for new, old in enumerate(order)]
    for option in question["options"]:
        if option.get("feedback"):
            option["feedback"] = rewrite_option_letters(option["feedback"], mapping)
    question["correct_answer"] = mapping[question["correct_answer"]]
    for field in letter_fields:
        if question.get(field):
            question[field] = rewrite_option_letters(question[field], mapping)
    return question


_CONCEPT_TAG = re.compile(r'<concept id="([^"]+)"')


def concept_ids_in(prompt: str) -> List[str]:
    """The concept ids a prompt's <concepts> block lists, in order (the mock provider tags with these)."""
    return _clean_ids(_CONCEPT_TAG.findall(prompt))


def _tag_with_prompt_concepts(questions: Sequence["GeneratedQuestion"], prompt: str) -> None:
    """Give each mock question one concept id from the prompt, in turn."""
    ids = concept_ids_in(prompt)
    for n, question in enumerate(questions):
        if ids:
            question.concept_ids = [ids[n % len(ids)]]


class QuestionSet(BaseModel):
    questions: List[GeneratedQuestion]

    def usable(self) -> List[Dict[str, Any]]:
        """Valid questions in stored form, with multiple-choice options shuffled."""
        return [
            shuffle_choice_options(q)
            for q in (item.normalized() for item in self.questions)
            if q is not None
        ]

    @classmethod
    def example(cls) -> "QuestionSet":
        """Enough distinct questions of every type that a mock run meets any quiz or exam plan."""
        per_type = 6
        questions: List[GeneratedQuestion] = []
        for n in range(1, per_type + 1):
            correct = "ABCD"[n % 4]
            questions.append(
                GeneratedQuestion(
                    question_type="multiple_choice",
                    question_text=f"Which statement ({n}) best describes the topic? (mock)",
                    options=[
                        ChoiceOption(
                            id=letter,
                            text=(
                                f"The central idea of the topic, version {n}"
                                if letter == correct
                                else f"Distractor {letter} for question {n}"
                            ),
                            misconception=None if letter == correct else f"Mock wrong idea {letter}",
                        )
                        for letter in "ABCD"
                    ],
                    correct_answer=correct,
                    explanation=f"{correct} restates the main idea. (mock output)",
                    points=2,
                    source_excerpts=[1],
                )
            )
        for n in range(1, per_type + 1):
            questions.append(
                GeneratedQuestion(
                    question_type="true_false",
                    question_text=f"Statement {n}: the topic builds on earlier material. (mock)",
                    correct_answer=n % 2 == 1,
                    explanation="See the course notes. (mock output)",
                    source_excerpts=[1],
                )
            )
        for n in range(1, per_type + 1):
            questions.append(
                GeneratedQuestion(
                    question_type="short_answer",
                    question_text=f"Explain key principle {n} in two sentences. (mock)",
                    sample_answer=f"Principle {n} links the main components. (mock)",
                    key_points=[f"Names principle {n}", "Links the components"],
                    explanation="A full answer names the principle and how the parts relate.",
                    points=3,
                    source_excerpts=[1],
                )
            )
        for n in range(1, per_type + 1):
            questions.append(
                GeneratedQuestion(
                    question_type="numerical",
                    question_text=f"Compute {n + 1} x 7. (mock)",
                    correct_answer=(n + 1) * 7,
                    tolerance=0,
                    explanation=f"{n + 1} x 7 = {(n + 1) * 7}. (mock output)",
                    points=2,
                    source_excerpts=[1],
                )
            )
        return cls(questions=questions)

    @classmethod
    def example_for(cls, prompt: str) -> "QuestionSet":
        """`example()` with each question tagged with the concepts in the prompt, in turn."""
        example = cls.example()
        _tag_with_prompt_concepts(example.questions, prompt)
        return example


_REVIEW_REQUEST = re.compile(
    r'<request concept_id="([^"]+)" mode="([^"]+)" difficulty="([^"]+)" count="(\d+)">(.*?)</request>', re.DOTALL
)
_REVIEW_CONFUSABLE = re.compile(r'<confusable concept_id="([^"]+)">')
_mock_review_counter = iter(range(1, 10**9))


class ReviewItemSet(QuestionSet):
    """New review items for the concepts a review session lacks: each carries the mode and difficulty asked for."""

    @classmethod
    def example(cls) -> "ReviewItemSet":
        return cls(questions=[])

    @classmethod
    def example_for(cls, prompt: str) -> "ReviewItemSet":
        """One multiple-choice question per requested item, in the mode and difficulty of its <request>.
        A discrimination question names the request's <confusable> on a wrong option."""
        questions: List[GeneratedQuestion] = []
        for concept_id, mode, difficulty, count, body in _REVIEW_REQUEST.findall(prompt):
            twin = _REVIEW_CONFUSABLE.search(body)
            for _ in range(int(count)):
                n = next(_mock_review_counter)
                correct = "ABCD"[n % 4]
                questions.append(
                    GeneratedQuestion(
                        question_type="multiple_choice",
                        question_text=f"Which statement ({n}) holds for this {mode} review question? (mock)",
                        options=[
                            ChoiceOption(
                                id=letter,
                                text=(
                                    f"The central idea, version {n}"
                                    if letter == correct
                                    else f"Distractor {letter} for question {n}"
                                ),
                                misconception=None if letter == correct else f"Mock wrong idea {letter}",
                                # One wrong option (never the correct one) is the mix-up with the twin.
                                confusable_concept_id=(
                                    twin.group(1) if twin and mode == "discrimination" and letter == "ABCD"[(n + 1) % 4] else None
                                ),
                            )
                            for letter in "ABCD"
                        ],
                        correct_answer=correct,
                        explanation=f"{correct} restates the main idea. (mock output)",
                        difficulty=difficulty,
                        concept_ids=[concept_id],
                        mode=mode,
                        source_excerpts=[1],
                    )
                )
        return cls(questions=questions)


class WarmupSet(QuestionSet):
    """The warm-up bank: multiple choice and true/false questions tagged easy, medium or hard."""

    @classmethod
    def example(cls) -> "WarmupSet":
        levels = ["easy", "easy", "medium", "medium", "hard"]
        questions: List[GeneratedQuestion] = []
        for n, level in enumerate(levels, 1):
            correct = "ABCD"[n % 4]
            questions.append(
                GeneratedQuestion(
                    question_type="multiple_choice",
                    question_text=f"Which statement ({n}) fits the topic? (mock)",
                    options=[
                        ChoiceOption(
                            id=letter,
                            text=(
                                f"The central idea, version {n}"
                                if letter == correct
                                else f"Distractor {letter} for question {n}"
                            ),
                            misconception=None if letter == correct else f"Mock wrong idea {letter}",
                        )
                        for letter in "ABCD"
                    ],
                    correct_answer=correct,
                    explanation=f"{correct} restates the main idea. (mock output)",
                    difficulty=level,
                    source_excerpts=[1],
                )
            )
        return cls(questions=questions)

    @classmethod
    def example_for(cls, prompt: str) -> "WarmupSet":
        example = cls.example()
        _tag_with_prompt_concepts(example.questions, prompt)
        return example


# ---------------------------------------------------------------- examples


class SolutionStep(BaseModel):
    step_number: int
    description: str
    work: str
    explanation: str


class SolvedExample(BaseModel):
    title: str
    problem_statement: str
    solution_steps: List[SolutionStep]
    final_answer: str
    key_concepts: List[str] = Field(default_factory=list)
    concept_ids: List[str] = Field(default_factory=list, description=CONCEPT_IDS_HELP)
    difficulty: Optional[str] = None
    source_excerpts: List[int] = Field(default_factory=list, description=SOURCE_EXCERPTS_HELP)

    def usable(self) -> bool:
        return bool(self.title.strip() and self.problem_statement.strip() and self.solution_steps)

    def stored(self) -> Optional[Dict[str, Any]]:
        """The stored example dict, or None when it is unusable."""
        if not self.usable():
            return None
        stored = self.model_dump()
        stored["concept_ids"] = _clean_ids(self.concept_ids)
        stored["source_excerpts"] = _excerpt_indexes(self.source_excerpts)
        return stored


class SolvedExampleSet(BaseModel):
    examples: List[SolvedExample]

    @classmethod
    def example(cls) -> "SolvedExampleSet":
        return cls(
            examples=[
                SolvedExample(
                    title="Worked example (mock)",
                    problem_statement="Apply the main rule to a small case. (mock)",
                    solution_steps=[
                        SolutionStep(
                            step_number=1,
                            description="Identify the rule",
                            work="Rule: $a + b = c$",
                            explanation="The problem asks for c.",
                        )
                    ],
                    final_answer="- c follows from the rule (mock)",
                    key_concepts=["Main rule"],
                    source_excerpts=[1],
                )
            ]
        )


MIN_CHOICE_OPTIONS = 2
MAX_CHOICE_OPTIONS = 5

# "A) text", "B. text", "(C) text", "- D: text" at the start of a line.
_OPTION_LINE = re.compile(r"^\s*(?:[-*]\s*)?\(?([A-H])[).:]\s+(.+?)\s*$")


def split_option_lines(question: str) -> tuple[str, List[Dict[str, str]]]:
    """(question without its option lines, the options) when a step wrote its options into the
    question text as "A) ..." lines. The options are empty when there are fewer than two."""
    stem: List[str] = []
    options: List[Dict[str, str]] = []
    for line in question.split("\n"):
        match = _OPTION_LINE.match(line)
        if match:
            options.append({"id": match.group(1).upper(), "text": match.group(2).strip()})
        else:
            stem.append(line)
    if len(options) < MIN_CHOICE_OPTIONS:
        return question, []
    return "\n".join(stem).strip(), options


def _choice_key(answer: str, options: List[Dict[str, str]]) -> Optional[str]:
    """The option id a multiple-choice key names: "B", "b)", "B) text" or the option's text."""
    ids = {option["id"] for option in options}
    cleaned = answer.strip().strip("()").strip().upper()
    if cleaned in ids:
        return cleaned
    lettered = re.match(r"^\(?([A-H])[).:]", answer.strip().upper())
    if lettered and lettered.group(1) in ids:
        return lettered.group(1)
    for option in options:
        if option["text"].strip().lower() == answer.strip().lower():
            return option["id"]
    return None


STEP_HINT_COUNT = 3


def step_hints(step: Dict[str, Any]) -> List[str]:
    """The three hint slots of a stored practice step: locate, connect, structure. A row written
    before hints existed has one `hint`, which is the connect hint; the other slots are empty."""
    hints = [str(h).strip() for h in step.get("hints") or []]
    if len(hints) == STEP_HINT_COUNT:
        return hints
    legacy = str(step.get("hint") or "").strip()
    return ["", legacy, ""]


def _without_legacy_hint(schema: Dict[str, Any]) -> None:
    """The model writes `hints`; `hint` stays on the class only so older rows parse."""
    schema.get("properties", {}).pop("hint", None)
    if "required" in schema:
        schema["required"] = [name for name in schema["required"] if name != "hint"]


class InteractiveStep(BaseModel):
    model_config = ConfigDict(json_schema_extra=_without_legacy_hint)

    step_number: int
    question: str = Field(
        description="The question only. For multiple_choice put the choices in `options`, not in this text"
    )
    hints: List[str] = Field(
        default_factory=list,
        description=(
            "Exactly 3 hints, gradually more specific: where to look, which idea applies, then the "
            "general form of the step. None of them contains the answer"
        ),
    )
    hint: str = Field(
        default="",
        description="Single hint of rows written before hints existed. Leave empty: write `hints`",
    )
    concept_ids: List[str] = Field(default_factory=list, description=CONCEPT_IDS_HELP)
    answer_type: Literal["numeric", "text", "multiple_choice"] = Field(
        description=(
            "numeric for anything that is a number (counts, probabilities, fractions, results of "
            "arithmetic); multiple_choice when the student picks from options; text only for a short "
            "canonical word, term or expression"
        )
    )
    options: List[ChoiceOption] = Field(
        default_factory=list,
        description=(
            "multiple_choice only: 2 to 5 options with ids A, B, C. Required for multiple_choice, "
            "empty for the other types"
        ),
    )
    correct_answer: str = Field(
        description="numeric: the number as a plain decimal or fraction; multiple_choice: the option id; text: short and canonical"
    )
    acceptable_answers: List[str] = Field(
        default_factory=list,
        description="Other forms of the same answer, one form per entry (never a comma-separated list)",
    )
    tolerance: Optional[float] = Field(
        default=None,
        description=(
            "numeric only: accepted absolute difference, such as 0.005 for a probability asked to "
            "3 decimals; 0 only for exact integers"
        ),
    )
    explanation: str
    feedback_correct: str
    feedback_incorrect: str

    def normalized(self) -> Optional[Dict[str, Any]]:
        """The stored step dict, or None when the step cannot be used.

        A multiple_choice step needs 2 to 5 options and a key that names one of them. Options
        written into the question as "A) ..." lines are moved into `options`. The options are
        shuffled (models favour one letter) and letter references in the explanation and the
        feedback follow them, as for quiz questions.
        """
        question = self.question.strip()
        correct = self.correct_answer.strip()
        hints = _clean_list(self.hints)
        if not question or not correct or len(hints) != STEP_HINT_COUNT:
            return None
        stored: Dict[str, Any] = {
            "step_number": self.step_number,
            "question": question,
            "hints": hints,
            # The middle hint doubles as the single hint older readers of the row show.
            "hint": hints[1],
            "concept_ids": _clean_ids(self.concept_ids),
            "answer_type": self.answer_type,
            "correct_answer": correct,
            "acceptable_answers": _clean_list(self.acceptable_answers),
            "explanation": self.explanation.strip(),
            "feedback_correct": self.feedback_correct.strip(),
            "feedback_incorrect": self.feedback_incorrect.strip(),
        }
        if self.answer_type == "numeric":
            if self.tolerance is not None and math.isfinite(self.tolerance):
                stored["tolerance"] = abs(self.tolerance)
            return stored
        if self.answer_type != "multiple_choice":
            return stored

        options = [
            {"id": o.id.strip().upper(), "text": o.text.strip()}
            for o in self.options
            if o.id.strip() and o.text.strip()
        ]
        if len(options) < MIN_CHOICE_OPTIONS:
            question, options = split_option_lines(question)
            if not options:
                return None
            stored["question"] = question
        ids = [option["id"] for option in options]
        texts = [option["text"].lower() for option in options]
        if len(options) > MAX_CHOICE_OPTIONS or len(set(ids)) != len(ids) or len(set(texts)) != len(texts):
            return None
        key = _choice_key(correct, options)
        if key is None:
            return None
        stored["options"] = options
        stored["correct_answer"] = key
        return shuffle_choice_options(
            stored,
            multiple_choice=True,
            letter_fields=("explanation", "feedback_correct", "feedback_incorrect"),
        )


def _hint_matches(problem: str, steps: Sequence[Dict[str, Any]]):
    """(hint, slot, step index, later step index, how it matched, the answers, text seen so far) for every hint that
    states an answer of its own step or a later one."""
    from app.services.tutor.leak import string_leak  # leak.py imports these schemas

    for index, step in enumerate(steps):
        seen = problem + "\n" + "\n".join(str(s.get("question", "")) for s in steps[: index + 1])
        for slot, hint in enumerate(step_hints(step)):
            if not hint:
                continue
            for later in range(index, len(steps)):
                target = steps[later]
                answers = [target["correct_answer"], *target.get("acceptable_answers", [])]
                answers += [o["text"] for o in target.get("options", []) if o["id"] == target["correct_answer"]]
                match = string_leak(hint, answers, target.get("tolerance"), problem=seen)
                if match:
                    yield hint, slot, index, later, match, answers, seen


def hint_leak(problem: str, steps: Sequence[Dict[str, Any]]) -> Optional[str]:
    """Why a stored practice problem's hints give an answer away, or None.

    A hint is read before the student has the step's answer, so it must not state the answer of its
    own step or of a later one (an earlier step's answer is the student's own result and may be
    named). The check is the tutor's own string check, with the step's tolerance: the key and the
    other accepted forms, a number within tolerance of them, the text of the right option, an option
    letter. Numbers and phrases the problem statement or the questions up to that step give do not count.

    With LEAK_WORD_FORMS_TO_JUDGE a hint that matches only as a number word ("add the two numbers" for 2) is not a
    leak here; `word_form_hints` lists it for the generator to put to the leak judge (finding 99).
    """
    from app.services.tutor.leak import blocks_alone

    for _hint, slot, index, later, match, _answers, _seen in _hint_matches(problem, steps):
        if blocks_alone(match):
            return f"hint {slot + 1} of step {index + 1} states the answer of step {later + 1}"
    return None


def word_form_hints(problem: str, steps: Sequence[Dict[str, Any]]) -> List[Dict[str, str]]:
    """The hints `hint_leak` let through only because they match as a number word: what the leak judge is asked about.
    Empty with LEAK_WORD_FORMS_TO_JUDGE off (such a hint is then a leak)."""
    from app.config import settings
    from app.services.tutor.leak import WORD_FORM_LEAK

    if not settings.LEAK_WORD_FORMS_TO_JUDGE:
        return []
    return [
        {
            "hint": hint,
            "answers": "\n".join(str(a) for a in answers),
            "problem": seen,
            "question": str(steps[index].get("question", "")),
        }
        for hint, _slot, index, _later, match, answers, seen in _hint_matches(problem, steps)
        if match == WORD_FORM_LEAK
    ]


class InteractiveExample(BaseModel):
    title: str
    problem_statement: str
    steps: List[InteractiveStep]
    key_concepts: List[str] = Field(default_factory=list)
    concept_ids: List[str] = Field(default_factory=list, description=CONCEPT_IDS_HELP)
    difficulty: Optional[str] = None
    estimated_time_minutes: int = 10
    source_excerpts: List[int] = Field(default_factory=list, description=SOURCE_EXCERPTS_HELP)

    def usable(self) -> bool:
        return bool(self.title.strip() and self.problem_statement.strip() and self.steps)

    def stored(self) -> Optional[Dict[str, Any]]:
        """The stored problem dict, or None. One step that cannot be used (a multiple_choice step
        without options, say) makes the whole problem unusable, because steps build on each other."""
        if not self.usable():
            return None
        steps = [step.normalized() for step in self.steps]
        if any(step is None for step in steps):
            return None
        # Hints that give the answer away defeat the practice: the problem is dropped, as one with a
        # bare distractor is (the generator keeps the problems that remain).
        if hint_leak(f"{self.title}\n{self.problem_statement}", steps):
            return None
        stored = self.model_dump()
        stored["steps"] = steps
        stored["concept_ids"] = _clean_ids(self.concept_ids)
        stored["source_excerpts"] = _excerpt_indexes(self.source_excerpts)
        return stored


class InteractiveExampleSet(BaseModel):
    examples: List[InteractiveExample]

    @classmethod
    def example(cls) -> "InteractiveExampleSet":
        return cls(
            examples=[
                InteractiveExample(
                    title="Practice problem (mock)",
                    problem_statement="Work through one step. (mock)",
                    steps=[
                        InteractiveStep(
                            step_number=1,
                            question="What is 2 + 2?",
                            hints=["Look at the numbers in the question.", "This is addition.", "Add the two numbers."],
                            answer_type="numeric",
                            correct_answer="4",
                            acceptable_answers=["four"],
                            explanation="2 + 2 = 4.",
                            feedback_correct="Correct.",
                            feedback_incorrect="Try counting again.",
                        )
                    ],
                    key_concepts=["Addition"],
                    source_excerpts=[1],
                )
            ]
        )

    @classmethod
    def example_for(cls, prompt: str) -> "InteractiveExampleSet":
        ids = concept_ids_in(prompt)
        example = cls.example()
        for problem in example.examples:
            problem.concept_ids = ids[:1]
            for step in problem.steps:
                step.concept_ids = ids[:1]
        return example


# ---------------------------------------------------------------- topics, validation, grading


class PlannedTopic(BaseModel):
    key: str = Field(description="Short unique id for this topic within the plan, such as t1, t2")
    name: str = Field(description="2-6 words, specific")
    description: str = Field(description="One sentence")
    objectives: List[str] = Field(
        description=(
            "3-5 things the student can do after the topic, each a verb phrase that finishes "
            "'By the end you can ...' (for example: compute a posterior with Bayes' rule)"
        )
    )
    keywords: List[str] = Field(description="3-8 search keywords")
    section_ids: List[str] = Field(description="Ids of the outline sections this topic is taught from")
    prerequisite_keys: List[str] = Field(
        description=(
            "Keys of EARLIER topics in this plan that a student must know before this one "
            "(usually one or two; for example Bayes' theorem builds on conditional probability). "
            "Empty only for the first topic or one that needs nothing earlier"
        )
    )
    estimated_minutes: int = Field(description="Minutes to study the topic, 10-90")


class PlannedUnit(BaseModel):
    title: str = Field(description="2-6 words")
    week_label: Optional[str] = Field(
        default=None, description="'Week 3' or 'Class 11' when the syllabus or calendar says so"
    )
    summary: str = Field(description="One sentence")
    existing_unit_key: Optional[str] = Field(
        default=None,
        description="Only when adding to a course that already has units: the key (U1, U2...) of the unit these topics join",
    )
    topics: List[PlannedTopic]


class SectionAddition(BaseModel):
    topic_key: str = Field(description="Key (E1, E2...) of an existing topic")
    section_ids: List[str]


class CoursePlan(BaseModel):
    """What the course planner returns: units of topics, each topic taught from outline sections."""

    units: List[PlannedUnit]
    additions: List[SectionAddition] = Field(
        default_factory=list,
        description="Only when adding to an existing course: new sections that join an existing topic",
    )

    @classmethod
    def example(cls) -> "CoursePlan":
        return cls(
            units=[
                PlannedUnit(
                    title="Core ideas (mock)",
                    summary="The main ideas of the material. (mock output)",
                    topics=[
                        PlannedTopic(
                            key="t1",
                            name="Core Concepts (mock)",
                            description="The main ideas in the uploaded material. (mock output)",
                            objectives=["explain the core idea", "apply it to a small case", "spot a common mistake"],
                            keywords=["core", "concepts", "overview"],
                            section_ids=[],
                            prerequisite_keys=[],
                            estimated_minutes=20,
                        )
                    ],
                )
            ]
        )

    @classmethod
    def example_for(cls, prompt: str) -> "CoursePlan":
        """A plan for the sections in `prompt` (the mock provider's answer): one unit per file,
        topics of up to three sections each, every section placed once."""
        sections = [
            (match.group(1), match.group(2).strip(), match.group(3).strip())
            for match in re.finditer(r"(?m)^(S\d+) \| ([^|\n]*) \| ([^\n]*)$", prompt)
        ]
        if not sections:
            return cls.example()
        by_file: Dict[str, List[tuple[str, str]]] = {}
        for section_id, filename, rest in sections:
            by_file.setdefault(filename, []).append((section_id, rest))
        per_topic = 3
        if len(by_file) == 1 and len(sections) in (2, 3):
            per_topic = 1  # a lone small file still gets more than one topic
        units: List[PlannedUnit] = []
        count = 0
        for filename, file_sections in by_file.items():
            topics: List[PlannedTopic] = []
            for start in range(0, len(file_sections), per_topic):
                group = file_sections[start : start + per_topic]
                count += 1
                label = filename.rsplit(".", 1)[0]
                topics.append(
                    PlannedTopic(
                        key=f"t{count}",
                        name=f"{label} part {len(topics) + 1} (mock)",
                        description=f"A section of {filename}. (mock output)",
                        objectives=[f"explain idea {n} of {label}" for n in (1, 2, 3)],
                        keywords=[label.lower(), "concepts", "practice"],
                        section_ids=[section_id for section_id, _ in group],
                        prerequisite_keys=[topics[-1].key] if topics else [],
                        estimated_minutes=20,
                    )
                )
            units.append(
                PlannedUnit(
                    title=f"{filename.rsplit('.', 1)[0]} (mock)",
                    summary=f"The material in {filename}. (mock output)",
                    topics=topics,
                )
            )
        return cls(units=units)


class UnitOrder(BaseModel):
    """The order the units of a large course should be taught in."""

    order: List[int] = Field(description="Unit numbers (as listed) in teaching order, each exactly once")

    @classmethod
    def example(cls) -> "UnitOrder":
        return cls(order=[])

    @classmethod
    def example_for(cls, prompt: str) -> "UnitOrder":
        count = len(re.findall(r"(?m)^(\d+)\. ", prompt))
        return cls(order=list(range(1, count + 1)))


MATERIAL_KINDS = ("content", "syllabus", "exam", "other")


class MaterialCheck(BaseModel):
    is_valid: bool = Field(description="True when this is readable course material for the category")
    notes: str = Field(description="One or two sentences")
    kind: Literal["content", "syllabus", "exam", "other"] = Field(
        default="content",
        description=(
            "What the file is: content (lecture notes, slides, a textbook chapter, a paper or a problem "
            "set to learn from), syllabus (a syllabus, schedule or calendar), exam (a past exam, quiz or "
            "test paper) or other"
        ),
    )

    @classmethod
    def example(cls) -> "MaterialCheck":
        return cls(is_valid=True, notes="Mock validation: accepted without a model call.", kind="content")


# ---------------------------------------------------------------- past-exam style

EXAM_QUESTION_KINDS = (
    "multiple_choice",
    "true_false",
    "short_answer",
    "numerical",
    "derivation",
    "essay",
    "other",
)
ExamQuestionKind = Literal[
    "multiple_choice", "true_false", "short_answer", "numerical", "derivation", "essay", "other"
]


class ExamTypeShare(BaseModel):
    kind: ExamQuestionKind = Field(
        description=(
            "multiple_choice, true_false, short_answer (a sentence or two), numerical (a computed "
            "number), derivation (a multi-step worked problem or proof), essay (an open-ended "
            "explanation) or other"
        )
    )
    share: float = Field(description="Fraction of the questions of this kind, 0 to 1; the shares add up to 1")


class ExamPointsBand(BaseModel):
    points: float = Field(description="Points one question is worth")
    questions: int = Field(description="How many questions are worth that much")


class ExamStyleProfile(BaseModel):
    """How one past exam is written: enough for a model to write new questions in the same voice.

    Stored on `materials.style_profile` as `model_dump()` (snake_case keys, plus `version`).
    `example_stems` are paraphrases: `app/services/exam_style.py` checks them against the exam's
    own text and drops any that copy it.
    """

    question_count: int = Field(description="How many questions the exam has (count a multi-part question once)")
    total_points: Optional[float] = Field(
        default=None, description="The exam's total points when it says so, otherwise null"
    )
    type_mix: List[ExamTypeShare] = Field(description="The kinds of question and their share of the exam")
    points_distribution: List[ExamPointsBand] = Field(
        description="How the points are spread: one entry per distinct points value. Empty when the exam gives no points"
    )
    typical_answer_length: str = Field(
        description="What a full answer looks like, in one short phrase: 'one line', 'a short paragraph', 'half a page of worked steps'"
    )
    phrasing_conventions: List[str] = Field(
        description=(
            "2-5 short observations about how questions are worded: how they open, whether they give "
            "data first, how they ask for justification or units, how multi-part questions are labelled"
        )
    )
    task_verbs: List[str] = Field(
        description="The 4-8 verbs the questions use most to say what to do (compute, show, explain, ...), most common first"
    )
    multi_part: bool = Field(description="Whether questions are split into labelled parts such as (a), (b), (c)")
    calculator_and_units: str = Field(
        description="What the exam says about calculators, formula sheets and units or significant figures; 'not stated' if nothing"
    )
    example_stems: List[str] = Field(
        description=(
            "Exactly 3 short example question stems, each REWRITTEN IN NEW WORDS about a different "
            "situation than the exam's. They show the voice and shape of the questions. Never copy a "
            "sentence or a run of more than 5 words from the exam"
        )
    )

    @classmethod
    def example(cls) -> "ExamStyleProfile":
        return cls(
            question_count=5,
            total_points=50,
            type_mix=[ExamTypeShare(kind="short_answer", share=0.6), ExamTypeShare(kind="derivation", share=0.4)],
            points_distribution=[ExamPointsBand(points=10, questions=5)],
            typical_answer_length="a short paragraph or a few lines of working",
            phrasing_conventions=[
                "Opens with a one-line setup, then asks the question (mock)",
                "Parts are labelled (a), (b), (c) (mock)",
            ],
            task_verbs=["compute", "explain", "show"],
            multi_part=True,
            calculator_and_units="not stated (mock)",
            example_stems=[
                "A fair die is rolled twice; find the chance the total is at least ten. (mock)",
                "Show that the estimator below stays unbiased when the sample doubles. (mock)",
                "Explain in two sentences why a larger sample narrows the interval. (mock)",
            ],
        )

    @classmethod
    def example_for(cls, prompt: str) -> "ExamStyleProfile":
        """A profile for the exam text in `prompt` (the mock provider's answer): the question
        count follows the numbered questions, the rest is fixed."""
        numbers = [int(match.group(1)) for match in re.finditer(r"(?m)^\s*(?:Problem|Question|Q)?\s*(\d{1,2})[.):]\s", prompt)]
        profile = cls.example()
        if numbers:
            profile.question_count = max(numbers)
            profile.points_distribution = [ExamPointsBand(points=10, questions=max(numbers))]
            profile.total_points = 10 * max(numbers)
        return profile


# ---------------------------------------------------------------- which topics the exams test


class ExamQuestionTopics(BaseModel):
    exam: int = Field(description="Number of the exam file this question is in, as listed (1, 2, ...)")
    label: str = Field(description="The question's own number or label, such as 'Problem 3' or 'Q2(b)'; 40 characters at most")
    summary: str = Field(
        description="What the question tests, REWRITTEN IN YOUR OWN WORDS in 12 words or fewer. Never copy wording from the exam"
    )
    topic_keys: List[str] = Field(
        description="Keys (T1, T2...) of the topics a student needs to answer the question: none, one, or at most three"
    )


class ExamTopicMap(BaseModel):
    """Which topics each question of the past exams tests. A topic no question tests is not on the exams."""

    questions: List[ExamQuestionTopics] = Field(
        description="Every real question of every exam, once each (a question with parts is one entry). No cover page, instructions, formula sheets or tables"
    )

    @classmethod
    def example(cls) -> "ExamTopicMap":
        return cls(questions=[ExamQuestionTopics(exam=1, label="Question 1", summary="A core idea applied once (mock)", topic_keys=["T1"])])

    @classmethod
    def example_for(cls, prompt: str) -> "ExamTopicMap":
        """The mock provider's answer: one question per 'Problem N' / 'N.' label in each exam, the
        questions spread over the topics except the last, which no question tests."""
        keys = re.findall(r"(?m)^(T\d+) \| ", prompt)
        usable = keys[:-1] if len(keys) > 1 else keys
        questions: List[ExamQuestionTopics] = []
        sections = re.findall(r'(?s)<exam n="(\d+)"[^>]*>(.*?)</exam>', prompt) or [("1", "")]
        for number, body in sections:
            labels = []
            for match in re.finditer(r"(?m)^[\W_]*(?:Problem|Question|Q)?[\W_]*(\d{1,2})[.):](?:\s|\*)", body):
                if match.group(1) not in labels:
                    labels.append(match.group(1))
            for index, label in enumerate(labels or ["1"]):
                questions.append(
                    ExamQuestionTopics(
                        exam=int(number),
                        label=f"Question {label}",
                        summary=f"Tests one idea from the course (mock {label})",
                        topic_keys=[usable[index % len(usable)]] if usable else [],
                    )
                )
        return cls(questions=questions)


class KeyPointCheck(BaseModel):
    """The verdict on one key point of a short answer's rubric."""

    point: str = Field(description="The key point, copied from the list you were given")
    result: Literal["met", "partly", "not_met"] = Field(
        description="met: the answer states it. partly: it is touched on or incomplete. not_met: it is missing or wrong."
    )


# The graders' v2 wording for "the answer has it" (short answers under PROMPTS_V2 "grading", recall under "tutor"). A rubric
# line or a source claim is written from one way of saying or reaching the idea; an answer that gets there another valid
# way has it too. One phrase, so the two graders cannot drift apart.
IN_ANY_WORDING_OR_METHOD = "in any wording or by an equivalent valid method"


class KeyPointCheckV2(KeyPointCheck):
    """Prompt revision (grading area): a key point is an idea, met by any wording or valid method that gives it."""

    result: Literal["met", "partly", "not_met"] = Field(
        description=(
            f"met: the answer gives the key point's idea, {IN_ANY_WORDING_OR_METHOD}. partly: the idea is touched on or "
            "incomplete. not_met: it is missing or wrong, also when the answer uses the key point's words in a wrong statement."
        )
    )


class ShortAnswerGradeV2(BaseModel):
    """Prompt revision (grading area), for a question with no key points: the model gives the score. A question with
    key points uses ShortAnswerChecksV2."""

    points_earned: float = Field(description="Points from 0 to the maximum given")
    feedback: str = Field(description="2-3 sentences on what was good and what was missing")
    blamed_concept_id: Optional[str] = Field(
        default=None,
        description=(
            "When the answer falls short and the gap is clearly in one concept of the "
            "<concepts> list, that concept's id; otherwise leave out"
        ),
    )
    misconception: Optional[str] = Field(
        default=None,
        description=(
            "Only when the answer states a specific wrong idea: that idea, in one sentence, "
            "written as the idea itself. Leave out for gaps and slips"
        ),
    )

    @classmethod
    def example(cls) -> "ShortAnswerGradeV2":
        return cls(points_earned=0, feedback="Mock grading: no model call was made.")


class ShortAnswerChecksV2(BaseModel):
    """Prompt audit R5 (grading area), for a question with key points: the model gives one check per key point and
    no score. The service computes the points from the checks (met 1, partly 0.5, not met 0), so there is no sum
    for the model to get wrong or to make agree."""

    key_point_checks: List[KeyPointCheckV2] = Field(
        min_length=1, description="One entry for each key point, in the order they were listed"
    )
    feedback: str = Field(description="2-3 sentences on what was good and what was missing")
    blamed_concept_id: Optional[str] = Field(
        default=None,
        description=(
            "When the answer falls short and the gap is clearly in one concept of the "
            "<concepts> list, that concept's id; otherwise leave out"
        ),
    )
    misconception: Optional[str] = Field(
        default=None,
        description=(
            "Only when the answer states a specific wrong idea: that idea, in one sentence, "
            "written as the idea itself. Leave out for gaps and slips"
        ),
    )

    @classmethod
    def example(cls) -> "ShortAnswerChecksV2":
        return cls(
            key_point_checks=[KeyPointCheckV2(point="(mock)", result="not_met")],
            feedback="Mock grading: no model call was made.",
        )


class ShortAnswerGrade(BaseModel):
    points_earned: float
    feedback: str = Field(description="2-3 sentences on what was good and what was missing")
    # Shown to the student next to the score ("what the grader looked for"). Older replies and
    # providers that leave it out give an empty list, and the review simply shows no per-point marks.
    key_point_checks: List[KeyPointCheck] = Field(
        default_factory=list,
        description="One entry for each key point, in the order they were listed",
    )
    blamed_concept_id: Optional[str] = Field(
        default=None,
        description=(
            "When the answer falls short and the gap is clearly in one concept of the "
            "<concepts> list, that concept's id; otherwise leave out"
        ),
    )
    misconception: Optional[str] = Field(
        default=None,
        description=(
            "Only when the answer states a specific wrong idea: that idea, in one sentence, "
            "written as the idea itself. Leave out for gaps and slips"
        ),
    )

    @classmethod
    def example(cls) -> "ShortAnswerGrade":
        return cls(points_earned=0, feedback="Mock grading: no model call was made.")


class DrillQuestion(BaseModel):
    question_text: str
    key_points: List[str]
    sample_answer: str
    explanation: str
    concepts_tested: List[str] = Field(default_factory=list)
    concept_ids: List[str] = Field(default_factory=list, description=CONCEPT_IDS_HELP)


class DrillQuestionV2(DrillQuestion):
    """DrillQuestion with a description on each field (prompt audit 2026-11-09, C5; used with PROMPTS_V2)."""

    question_text: str = Field(description="One question answerable aloud in under a minute")
    key_points: List[str] = Field(description="2-4 points a listener can check in the spoken answer")
    sample_answer: str = Field(description="What a good spoken answer sounds like, in 2-4 sentences")
    explanation: str = Field(description="Why the answer is right, in a sentence or two")


class DrillQuestionSet(BaseModel):
    questions: List[DrillQuestion]

    @classmethod
    def example(cls) -> "DrillQuestionSet":
        return cls(
            questions=[
                DrillQuestion(
                    question_text=f"In your own words, what is idea {n}? (mock)",
                    key_points=["Defines the idea", "Gives one reason it matters"],
                    sample_answer="A short spoken explanation. (mock)",
                    explanation="Look for a definition and a reason.",
                    concepts_tested=["Definitions"],
                )
                for n in range(1, 6)
            ]
        )


class DrillQuestionSetV2(DrillQuestionSet):
    questions: List[DrillQuestionV2]

    @classmethod
    def example(cls) -> "DrillQuestionSetV2":
        return cls(questions=[DrillQuestionV2(**q.model_dump()) for q in DrillQuestionSet.example().questions])


# ---------------------------------------------------------------- concept graph

ConceptKind = Literal["fact", "concept", "procedure", "judgment"]
EdgeType = Literal["prerequisite", "encompasses", "confusable"]
EdgeWeight = Literal[0.25, 0.5, 0.75, 1.0]


class ExtractedConcept(BaseModel):
    key: str = Field(description="Short unique id for this concept within the topic, such as c1, c2")
    name: str = Field(description="2-6 words, an ability or an idea, not a heading")
    summary: str = Field(description="One sentence stating the idea")
    kind: ConceptKind = Field(
        description="fact: a thing to recall. concept: an idea to understand. procedure: steps to carry out. judgment: a decision between options."
    )
    objective_indexes: List[int] = Field(
        description="0-based indexes of the topic objectives this concept serves"
    )
    difficulty: float = Field(description="0 (easy) to 1 (hard) for a first-time learner")


class ExtractedClaim(BaseModel):
    concept_key: str = Field(description="Key of the concept this claim belongs to")
    text: str = Field(description="One thing a student who knows the concept can state, in your own words")
    quote: str = Field(
        description="Verbatim text from the chunk that supports the claim, at most 300 characters, copied exactly"
    )
    chunk_id: str = Field(description="Id of the chunk the quote comes from")


class ExtractedEdge(BaseModel):
    source: str = Field(description="Key of a concept in this topic, or the id of a prerequisite topic's concept")
    target: str = Field(description="Key of a concept in this topic, or the id of a prerequisite topic's concept")
    type: EdgeType = Field(
        description="prerequisite: source must be known before target. encompasses: practising target also exercises source. confusable: students mix the two up."
    )
    weight: EdgeWeight = Field(
        description="For encompasses, how much of the source the target exercises: 0.25, 0.5, 0.75 or 1.0. Use 1.0 for other types"
    )
    confidence: float = Field(description="0 to 1, how sure you are the relation holds")
    evidence_quote: Optional[str] = Field(
        default=None, description="Verbatim text from a chunk that supports the relation, when there is one"
    )


class FocusQuestion(BaseModel):
    objective_index: int = Field(description="0-based index of the topic objective")
    question: str = Field(description="The question the reading answers, phrased for a student about to read")
    chunk_id: Optional[str] = Field(default=None, description="Id of the chunk that answers it")


class RecallPrompt(BaseModel):
    objective_index: int = Field(description="0-based index of the topic objective")
    prompt: str = Field(description="An open prompt such as 'Explain ...' or 'Why does ...'")


class ConceptRequote(BaseModel):
    """New claims for concepts that already exist (their `concept_key` is the concept's id)."""

    claims: List[ExtractedClaim] = Field(
        description="2-5 claims per concept the excerpts support; none for a concept they do not support"
    )

    @classmethod
    def example(cls) -> "ConceptRequote":
        return cls(claims=[])

    @classmethod
    def example_for(cls, prompt: str) -> "ConceptRequote":
        """One claim per concept of the prompt, quoting the opening words of its first excerpt (the mock provider's answer)."""
        excerpt = re.search(r'<excerpt chunk_id="([^"]+)"[^>]*>\n(.*?)\n</excerpt>', prompt, re.DOTALL)
        ids = re.findall(r'<concept id="([^"]+)"', prompt)
        if not excerpt or not ids:
            return cls.example()
        text = re.sub(r"\s+", " ", excerpt.group(2)).strip()
        quote = text[:60]
        if len(text) > 60 and " " in quote:
            quote = quote.rsplit(" ", 1)[0]
        return cls(
            claims=[
                ExtractedClaim(concept_key=concept_id, text="Mock claim. (mock)", quote=quote, chunk_id=excerpt.group(1))
                for concept_id in ids
            ]
        )


class ConceptExtraction(BaseModel):
    concepts: List[ExtractedConcept] = Field(description="3-8 concepts")
    claims: List[ExtractedClaim] = Field(description="2-5 claims per concept")
    edges: List[ExtractedEdge] = Field(default_factory=list)
    focus_questions: List[FocusQuestion] = Field(description="One per objective")
    recall_prompts: List[RecallPrompt] = Field(description="One per objective")

    @classmethod
    def example(cls) -> "ConceptExtraction":
        return cls(concepts=[], claims=[], edges=[], focus_questions=[], recall_prompts=[])

    @classmethod
    def example_for(cls, prompt: str) -> "ConceptExtraction":
        """An extraction for the excerpts and objectives in `prompt` (the mock provider's answer).

        Three concepts that share the objectives out, two claims each quoting the opening words
        of the first excerpts, a prerequisite chain and one question and prompt per objective.
        Empty when the prompt holds no excerpts."""
        excerpts = [
            (match.group(1), re.sub(r"\s+", " ", match.group(2)).strip())
            for match in re.finditer(r'<excerpt chunk_id="([^"]+)"[^>]*>\n(.*?)\n</excerpt>', prompt, re.DOTALL)
        ]
        excerpts = [(chunk_id, text) for chunk_id, text in excerpts if text]
        if not excerpts:
            return cls.example()
        objectives = len(re.findall(r'<objective index="\d+">', prompt))
        quotes = []
        for chunk_id, text in excerpts[:2]:
            quote = text[:60]
            if len(text) > 60 and " " in quote:
                quote = quote.rsplit(" ", 1)[0]
            quotes.append((chunk_id, quote))
        keys = ["c1", "c2", "c3"]
        concepts = [
            ExtractedConcept(
                key=key,
                name=f"Mock idea {n}",
                summary=f"Placeholder idea {n} of the topic. (mock)",
                kind="concept",
                objective_indexes=[i for i in range(objectives) if i % 3 == n - 1] or ([0] if objectives else []),
                difficulty=0.2 * n,
            )
            for n, key in enumerate(keys, 1)
        ]
        claims = [
            ExtractedClaim(concept_key=key, text=f"Mock claim {m} of {key}.", quote=quote, chunk_id=chunk_id)
            for key in keys
            for m, (chunk_id, quote) in enumerate(quotes, 1)
        ]
        edges = [
            ExtractedEdge(source="c1", target="c2", type="prerequisite", weight=1.0, confidence=0.8),
            ExtractedEdge(source="c2", target="c3", type="prerequisite", weight=1.0, confidence=0.8),
        ]
        return cls(
            concepts=concepts,
            claims=claims,
            edges=edges,
            focus_questions=[
                FocusQuestion(
                    objective_index=i,
                    question=f"What does the reading say about objective {i + 1}? (mock)",
                    chunk_id=excerpts[0][0],
                )
                for i in range(objectives)
            ],
            recall_prompts=[
                RecallPrompt(objective_index=i, prompt=f"Explain objective {i + 1} in your own words. (mock)")
                for i in range(objectives)
            ],
        )


class ProposedLink(BaseModel):
    source: str = Field(description="Id of one concept of the pair")
    target: str = Field(description="Id of the other concept of the pair")
    type: Literal["confusable", "encompasses"] = Field(
        description="confusable: students mix the two up. encompasses: practising the target also exercises the source."
    )
    weight: EdgeWeight = Field(
        description="For encompasses, how much of the source the target exercises: 0.25, 0.5, 0.75 or 1.0. Use 1.0 for confusable"
    )
    confidence: float = Field(description="0 to 1, how sure you are the relation holds")
    evidence_quote: Optional[str] = Field(
        default=None, description="Verbatim text from the concepts' quotes that supports the relation, when there is one"
    )


class ConceptLinks(BaseModel):
    edges: List[ProposedLink] = Field(default_factory=list, description="Only pairs from the candidate list")

    @classmethod
    def example(cls) -> "ConceptLinks":
        return cls(edges=[])

    @classmethod
    def example_for(cls, prompt: str) -> "ConceptLinks":
        """Links for the candidate pairs in `prompt` (the mock provider's answer): the first pair
        confusable, the second one encompassing. Empty when the prompt lists no pairs."""
        pairs = re.findall(r'<pair a="([^"]+)" b="([^"]+)"\s*/>', prompt)
        links = []
        if pairs:
            links.append(ProposedLink(source=pairs[0][0], target=pairs[0][1], type="confusable", weight=1.0, confidence=0.8))
        if len(pairs) > 1:
            links.append(
                ProposedLink(source=pairs[1][0], target=pairs[1][1], type="encompasses", weight=0.5, confidence=0.7)
            )
        return cls(edges=links)


class SupportCitation(BaseModel):
    index: int = Field(description="Index of the excerpt the quote comes from")
    quote: str = Field(description="Exact text copied from that excerpt that supports the item")


class SupportVerdict(BaseModel):
    id: int = Field(description="The id of the item, as given")
    supported: bool = Field(description="True only when the excerpts support the question and its answer key")
    citations: List[SupportCitation] = Field(
        default_factory=list, description="The supporting quotes; none when the item is not supported"
    )


class SupportReport(BaseModel):
    items: List[SupportVerdict] = Field(description="One verdict per item, in order")

    @classmethod
    def example(cls) -> "SupportReport":
        return cls(items=[])

    @classmethod
    def example_for(cls, prompt: str) -> "SupportReport":
        """A verdict for every item in `prompt` (the mock provider's answer): supported, citing
        the opening words of the first excerpt the item lists."""
        excerpts = {
            int(index): text
            for index, text in re.findall(r'<excerpt index="(\d+)"[^>]*>\n(.*?)\n</excerpt>', prompt, re.S)
        }
        verdicts = []
        for item_id, listed in re.findall(r'<item id="(\d+)" excerpts="([^"]*)">', prompt):
            indexes = [int(i) for i in listed.split(",") if i.strip().isdigit() and int(i) in excerpts]
            index = indexes[0] if indexes else (min(excerpts) if excerpts else None)
            citations = []
            if index is not None:
                citations = [SupportCitation(index=index, quote=" ".join(excerpts[index].split()[:6]))]
            verdicts.append(SupportVerdict(id=int(item_id), supported=True, citations=citations))
        return cls(items=verdicts)


# ---------------------------------------------------------------- practice tutor


# The kinds of a wrong answer and the moves of a reply; the same values as MissKind and TutorMove in
# frontend/src/lib/tutor/state.ts.
MissKind = Literal["cue_miss", "discrimination", "execution", "careless", "misconception"]
TutorMove = Literal["clarify", "orient", "ladder", "confront", "confirm", "reason_first", "to_source", "worked_analogue"]

MAX_TUTOR_TEXT_CHARS = 6000
MAX_TUTOR_STEPS = 30
MAX_TUTOR_LIST = 20


class PracticeStep(BaseModel):
    """One step of the problem with its authored key. The key is for checking, never for saying."""

    question: str = Field(max_length=MAX_TUTOR_TEXT_CHARS)
    answer: str = Field(max_length=500)
    acceptable_answers: List[str] = Field(default_factory=list, max_length=MAX_TUTOR_LIST)
    tolerance: Optional[float] = None
    # The authored hints: locate, connect, structure (rungs 1, 3, 4). What a reply falls back to.
    hints: List[str] = Field(default_factory=list, max_length=3)


class PracticeClaim(BaseModel):
    text: str = Field(max_length=1000)
    quote: str = Field(max_length=MAX_TUTOR_TEXT_CHARS)
    page: Optional[int] = None


class WeakPrerequisite(BaseModel):
    name: str = Field(max_length=300)
    page: Optional[int] = None


class PracticeConfusable(BaseModel):
    """The plausible wrong candidate of a fork: the concept students mix this one up with."""

    name: str = Field(max_length=300)
    summary: str = Field(default="", max_length=1000)


# The highest rung of the hint ladder (structure). Rung 5 is the worked analogue, a move of its own.
HIGHEST_LADDER_RUNG = 4


class PracticeTutorRequest(BaseModel):
    """What the app knows when the student asks the tutor for something (spec 6.1)."""

    problem: str = Field(max_length=MAX_TUTOR_TEXT_CHARS)
    steps: List[PracticeStep] = Field(min_length=1, max_length=MAX_TUTOR_STEPS)
    step_index: int = Field(ge=0)
    working: str = Field(default="", max_length=MAX_TUTOR_TEXT_CHARS)
    attempts: List[str] = Field(default_factory=list, max_length=MAX_TUTOR_LIST)
    hints_shown: List[str] = Field(default_factory=list, max_length=MAX_TUTOR_LIST)
    rung_allowed: int = Field(ge=0, le=5)
    move: TutorMove
    # The student has the answer to this step (a correct check, a surrendered item): the reply may
    # confirm it. Later steps' answers stay guarded.
    final_allowed: bool = False
    # The answer the app graded as right when the student checked it: the only one a reply may confirm. The
    # student's attempts and working are never read for it. Empty means nothing may be confirmed.
    own_answer: str = Field(default="", max_length=MAX_TUTOR_TEXT_CHARS)
    # Three low-effort turns: ask which part of the last hint is unclear before anything else.
    ask_what_is_unclear: bool = False
    claims: List[PracticeClaim] = Field(default_factory=list, max_length=MAX_TUTOR_LIST)
    weak_prerequisite: Optional[WeakPrerequisite] = None
    # The earliest wrong or unanswered step, found by the app without the model; left out when it can't decide.
    first_wrong_step: Optional[int] = Field(default=None, ge=0)
    confusable: Optional[PracticeConfusable] = None
    # The call is billed to this user and project (billing.py).
    user_id: str = Field(min_length=1, max_length=100)
    project_id: str = Field(min_length=1, max_length=100)
    session_id: Optional[str] = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def _indexes_in_range(self) -> "PracticeTutorRequest":
        if self.step_index >= len(self.steps):
            raise ValueError("step_index is outside the steps")
        if self.first_wrong_step is not None and self.first_wrong_step >= len(self.steps):
            raise ValueError("first_wrong_step is outside the steps")
        return self

    @model_validator(mode="after")
    def _rung_fits_the_move(self) -> "PracticeTutorRequest":
        # Rung 5 is the worked analogue, which only the worked_analogue move gives. The app keeps the rung at 5 once the
        # student has opened a worked example, so the next ladder reply was told "rung allowed: 5", a rung the ladder
        # does not have (and one the audited prompt says belongs to another move). Every other move is held to
        # structure (rung 4) at most, here, so the prompt, the rung reported back and the authored fallback agree.
        if self.move != "worked_analogue" and self.rung_allowed > HIGHEST_LADDER_RUNG:
            self.rung_allowed = HIGHEST_LADDER_RUNG
        return self


class TutorMistake(BaseModel):
    located: bool = Field(description="True when the student's work shows a mistake you can point to")
    where: str = Field(description="Where it is, in a few words for the app's records; empty when not located")
    kind: Optional[MissKind] = Field(
        default=None,
        description="cue_miss: nothing came to mind; discrimination: a wrong but related idea won; execution: right idea run wrongly; careless: a slip, the reasoning shows they knew; misconception: the idea held is itself wrong. Null when there is no mistake",
    )


def _without_service_fields(schema: Dict[str, Any]) -> None:
    """The model writes the fields of the class; `leaked` and `from_authored_hint` are set in code."""
    for name in ("leaked", "from_authored_hint", "claimed_rung", "rejected_drafts"):
        schema.get("properties", {}).pop(name, None)


class RejectedDraft(BaseModel):
    """A draft the leak check held back, kept for the tutoring eval and the logs. It is never sent to the student."""

    attempt: int
    draft: str
    # string: the string check found an authored answer in the draft; judge: the leak judge ruled it a leak;
    # self_report: the model's own reveals_answer flag; other: an empty reply or a worked-example number reuse.
    kind: Literal["string", "judge", "self_report", "other"]
    reason: str
    # The authored answers a string hit found stated (empty for the other kinds).
    values: List[str] = Field(default_factory=list)
    # The attempt after this one passed the checks (True) or was held back too (False); None when there was none.
    retry_passed: Optional[bool] = None


class PracticeTutorReply(BaseModel):
    """The model's structured answer, and what the route returns (spec 6.1)."""

    # First and required, so the model writes its notes before the reply (fields come out in this order).
    analysis: str = Field(
        description="Private notes, never shown: the likely paths from the student's work to their answer and where the first break is",
    )
    reply: str = Field(description="What the student reads: at most 80 words and at most one question")
    rung_used: int = Field(description="The rung (0 to 5) the reply gives; never above the rung allowed")
    mistake: TutorMistake
    reveals_answer: bool = Field(
        description="Your own check: true when the reply states the answer, or lets a calculator finish it, or hides it in a question or an option"
    )
    # Set by the service, not the model: a generation was flagged as a leak (and replaced), and the
    # reply sent is the authored hint of the rung.
    leaked: bool = False
    from_authored_hint: bool = False
    # The highest rung the model claimed before it was clamped to the rung allowed. For the tutoring
    # eval only: it is never serialised (the route adds it when the eval header is sent).
    claimed_rung: Optional[int] = Field(default=None, exclude=True)
    # Every draft the leak check held back this turn, with why. For the tutoring eval only, like
    # `claimed_rung`: it is never serialised, so the student never receives it.
    rejected_drafts: List[RejectedDraft] = Field(default_factory=list, exclude=True)

    model_config = ConfigDict(json_schema_extra=_without_service_fields)

    @classmethod
    def example(cls) -> "PracticeTutorReply":
        return cls(
            analysis="",
            reply="What have you tried so far on this step? (mock)",
            rung_used=0,
            mistake=TutorMistake(located=False, where="", kind=None),
            reveals_answer=False,
        )


class PracticeTutorReplyV2(BaseModel):
    """Prompt revision (tutor area): the model-written fields of PracticeTutorReply, without the
    `analysis` scratchpad (thinking replaces it). The word limit is stated once, in the system prompt."""

    reply: str = Field(description="What the student reads")
    rung_used: int = Field(
        description="The rung (0 to 5) of the help the reply gives, on the ladder's scale: 1 locate, 2 narrow, 3 name, 4 structure, "
        "5 only for a worked analogue. Never above the rung allowed, which is a limit, not a target"
    )
    mistake: TutorMistake
    reveals_answer: bool = Field(
        description="Your own check: true when the reply states the answer, or lets a calculator finish it, or hides it in a question or an option"
    )

    @classmethod
    def example(cls) -> "PracticeTutorReplyV2":
        return cls.model_validate(PracticeTutorReply.example().model_dump(exclude={"analysis"}))


V1ReplyT = TypeVar("V1ReplyT", bound=BaseModel)


def as_v1_reply(out: BaseModel, v1_class: Type[V1ReplyT]) -> V1ReplyT:
    """A reply of a v1 class, from the v1 or the v2 (no `analysis`) class the model was asked for, so the code
    after the model call is the same for both."""
    if isinstance(out, v1_class):
        return out
    return v1_class(analysis="", **out.model_dump())


class LeakVerdict(BaseModel):
    # Prompt audit R1 (2026-11-10): `reason` stays. It is a pointer (which kind of leak, which sentence), not the
    # judge's reasoning, and the rewrite is told it so the next draft fixes that sentence. No student reads it.
    answer_revealed: bool = Field(description="True when the reply is any of the four kinds of leak")
    reason: str = Field(description="One short clause naming which kind and where; empty when nothing is revealed")

    @classmethod
    def example(cls) -> "LeakVerdict":
        return cls(answer_revealed=False, reason="")


AskIntent = Literal["lookup", "logistics", "understand", "solve", "check_answer", "other"]


class RouteDecision(BaseModel):
    """What the student's Ask message is for (spec 6.3). The router model fills it in before the answer is written."""

    intent: AskIntent = Field(
        description="lookup: finds a fact or passage in the files. logistics: dates, grading, deadlines, how the course runs. "
        "understand: wants an idea explained. solve: wants their own problem or question worked or answered. "
        "check_answer: gives an answer of their own and asks whether it is right. other: anything else."
    )
    has_attempt: bool = Field(
        description="True when the conversation already holds the student's own attempt or stated understanding for this question"
    )
    wants_answer: bool = Field(description="True when the student asks to be told the answer or shown the solution outright")
    concepts: List[str] = Field(
        description="Names, copied exactly from the course concept list, of the concepts the question touches; empty when none apply",
        max_length=12,
    )
    gives_no_idea: bool = Field(
        default=False,
        description="True when this message only says the student does not know, has no idea or is stuck, and holds no guess or idea of their own",
    )

    @classmethod
    def example(cls) -> "RouteDecision":
        return cls(intent="lookup", has_attempt=False, wants_answer=False, concepts=[])

    @classmethod
    def example_for(cls, prompt: str) -> "RouteDecision":
        """The mock provider's router: a few opening words pick the intent, so the whole Ask flow (a
        question back, then an explanation with a card) can run without a model. A real model never
        reaches this."""
        found = re.search(r"<student_message>\n(.*?)\n</student_message>", prompt, re.DOTALL)
        message = (found.group(1) if found else "").lower()
        earlier = re.search(r"<conversation>\n(.*?)\n</conversation>", prompt, re.DOTALL)
        # A message that carries a colon ("Explain load factor: it is ...") is the student's own attempt, after an earlier turn.
        has_attempt = bool(earlier and "student:" in earlier.group(1)) and ":" in message
        block = re.search(r"<course_concepts>\n(.*?)\n</course_concepts>", prompt, re.DOTALL)
        names = [line[2:].strip() for line in (block.group(1) if block else "").splitlines() if line.startswith("- ")]
        named = [name for name in names if name.lower() in message]
        if re.match(r"\s*(explain|why|help me understand)", message):
            broad = "everything" in message or "overview" in message
            return cls(intent="understand", has_attempt=has_attempt and not broad, wants_answer=False, concepts=names[:12] if broad else named)
        if re.match(r"\s*(solve|work out|find the|calculate)", message):
            return cls(intent="solve", has_attempt=has_attempt, wants_answer="just tell me" in message, concepts=named)
        return cls.example()


class CheckQuestion(BaseModel):
    """The question that ends an explanation in Ask: shown as a card and graded as an item (spec 6.3)."""

    question: str = Field(min_length=1, max_length=600)
    answer: str = Field(min_length=1, max_length=400)
    explanation: str = Field(default="", max_length=800)
    concept_name: str = Field(default="", max_length=120)


class ReaderClaim(BaseModel):
    """A claim of the passage's concepts, from the student's own files."""

    text: str = Field(max_length=1000)
    quote: str = Field(default="", max_length=MAX_TUTOR_TEXT_CHARS)
    page: Optional[int] = None


class ReaderTutorRequest(BaseModel):
    """What the app sends when a student asks to have a passage explained, after their own take (spec 5.2)."""

    passage: str = Field(min_length=1, max_length=MAX_TUTOR_TEXT_CHARS)
    chunk_id: str = Field(min_length=1, max_length=100)
    # What the student thinks the passage says, or what confuses them (at least a few characters), or the
    # one-tap "I can't parse any of it" with `cant_parse` set.
    student_take: str = Field(min_length=1, max_length=MAX_TUTOR_TEXT_CHARS)
    cant_parse: bool = False
    rung: int = Field(ge=0, le=5)
    claims: List[ReaderClaim] = Field(default_factory=list, max_length=MAX_TUTOR_LIST)
    # The call is billed to this user and project (billing.py).
    user_id: str = Field(min_length=1, max_length=100)
    project_id: str = Field(min_length=1, max_length=100)
    session_id: Optional[str] = Field(default=None, max_length=100)
    # explain: the first reply (the take above). check: the student's answer to the check question the last reply ended with
    # (or "I don't know"), and the reply is a verdict. restate: the plain restatement a student gets after two "can't parse"
    # taps on the same passage (the app decides when; the rung is fixed at RESTATE_RUNG).
    turn: Literal["explain", "check", "restate"] = "explain"
    # The check question being answered (check turn) or the one the student was last asked (restate turn).
    check_question: str = Field(default="", max_length=MAX_TUTOR_TEXT_CHARS)
    student_answer: str = Field(default="", max_length=MAX_TUTOR_TEXT_CHARS)
    dont_know: bool = False

    @model_validator(mode="after")
    def _take_has_text(self) -> "ReaderTutorRequest":
        if not self.student_take.strip():
            raise ValueError("student_take is empty")
        if self.turn == "check" and not self.check_question.strip():
            raise ValueError("a check turn needs the check question")
        if self.turn == "check" and not (self.student_answer.strip() or self.dont_know):
            raise ValueError("a check turn needs the student's answer or dont_know")
        return self


def _without_reader_service_fields(schema: Dict[str, Any]) -> None:
    schema.get("properties", {}).pop("from_fallback", None)


class ReaderTutorReply(BaseModel):
    """The model's structured answer for a passage. The route returns `reply` and `check_question` only."""

    # First and required, so the model writes its notes before the reply.
    analysis: str = Field(description="Private notes, never shown: what the passage says, what the student's take gets right and what it misses")
    reply: str = Field(description="What the student reads: at most 80 words, statements only, no question")
    check_question: str = Field(description="Exactly one short question the student can answer from the passage; it ends the reply")
    reveals_answer: bool = Field(
        description="Your own check: true when the reply states what a source claim answers to the student's question, in any form"
    )
    # Set by the service: the reply is the fixed fallback because two generations leaked.
    from_fallback: bool = False

    model_config = ConfigDict(json_schema_extra=_without_reader_service_fields)

    @classmethod
    def example(cls) -> "ReaderTutorReply":
        return cls(
            analysis="",
            reply="The passage describes the idea in its first sentence. (mock)",
            check_question="What does the first sentence say?",
            reveals_answer=False,
        )

    @classmethod
    def example_for(cls, prompt: str) -> "ReaderTutorReply":
        """The mock provider's reply: a restatement when the prompt asks for one (built from the passage's first sentence), else the usual explanation."""
        if "Restate:" not in prompt:
            return cls.example()
        found = re.search(r"<passage[^>]*>\n(.*?)\n</passage>", prompt, re.DOTALL)
        first = re.split(r"(?<=[.!?])\s+", (found.group(1) if found else "").strip())[0]
        return cls(
            analysis="",
            reply=f"Put simply, the passage begins like this: {first} (mock restatement)",
            check_question="In your own words, what is the main point of this passage?",
            reveals_answer=False,
        )


class ReaderTutorReplyV2(BaseModel):
    """Prompt revision (tutor area): ReaderTutorReply without `analysis`. The word limit is stated once, in the system prompt."""

    reply: str = Field(description="What the student reads: statements only, no question")
    check_question: str = Field(description="Exactly one short question the student can answer from the passage; it ends the reply")
    reveals_answer: bool = Field(
        description="Your own check: true when the reply states what a source claim answers to the student's question, in any form"
    )

    @classmethod
    def example(cls) -> "ReaderTutorReplyV2":
        return cls.model_validate(ReaderTutorReply.example().model_dump(exclude={"analysis", "from_fallback"}))

    @classmethod
    def example_for(cls, prompt: str) -> "ReaderTutorReplyV2":
        return cls.model_validate(ReaderTutorReply.example_for(prompt).model_dump(exclude={"analysis", "from_fallback"}))


ReaderVerdict = Literal["right", "partly", "not_yet"]


class ReaderCheckReply(BaseModel):
    """The model's structured answer to a student's answer to a reader check question (spec 18.6, the second turn)."""

    # First and required, so the model writes its notes before the verdict.
    analysis: str = Field(description="Private notes, never shown: what the passage says about the check question and how the student's answer compares")
    verdict: ReaderVerdict = Field(description="right: the answer holds the idea. partly: it holds some of it. not_yet: it does not")
    reply: str = Field(description="What the student reads: at most 60 words, statements only. One line on what made the answer right, or the sentence of the passage to look at")
    follow_up_question: str = Field(description="One short question the student can answer from the passage; empty when the verdict is right")
    reveals_answer: bool = Field(description="Your own check: true when the reply states the idea the check question asks for and the student did not")
    # Set by the service: the reply is the fixed fallback because two generations leaked.
    from_fallback: bool = False

    model_config = ConfigDict(json_schema_extra=_without_reader_service_fields)

    @classmethod
    def example(cls) -> "ReaderCheckReply":
        return cls(
            analysis="",
            verdict="partly",
            reply="Part of that is in the passage's first sentence. (mock)",
            follow_up_question="What does the first sentence add?",
            reveals_answer=False,
        )

    @classmethod
    def example_for(cls, prompt: str) -> "ReaderCheckReply":
        """The mock provider's verdict, from how many content words the answer shares with the passage: none shared (or "I don't
        know") is not yet, one is partly, two or more is right. A real model never reaches this."""
        passage = re.search(r"<passage[^>]*>\n(.*?)\n</passage>", prompt, re.DOTALL)
        answer = re.search(r"<student_answer>\n(.*?)\n</student_answer>", prompt, re.DOTALL)
        given = (answer.group(1) if answer else "").strip()
        words_of = lambda text: set(re.findall(r"[a-z]{4,}", text.lower()))  # noqa: E731
        shared = len(words_of(given) & words_of(passage.group(1) if passage else ""))
        if re.fullmatch(r"(?i)\s*(i don'?t know|idk|no idea)\W*", given) or shared == 0:
            return cls(analysis="", verdict="not_yet", reply="Look at the first sentence of the passage again. (mock)", follow_up_question="What does the first sentence say?", reveals_answer=False)
        if shared == 1:
            return cls(analysis="", verdict="partly", reply="Part of that is in the passage; the second sentence adds the rest. (mock)", follow_up_question="What does the second sentence add?", reveals_answer=False)
        return cls(analysis="", verdict="right", reply="Your answer uses the passage's own idea. (mock)", follow_up_question="", reveals_answer=False)


class ReaderCheckReplyV2(BaseModel):
    """Prompt revision (tutor area): ReaderCheckReply without `analysis`. The word limit is stated once, in the system prompt."""

    verdict: ReaderVerdict = Field(description="right: the answer holds the idea. partly: it holds some of it. not_yet: it does not")
    reply: str = Field(description="What the student reads: statements only. One line on what made the answer right, or the sentence of the passage to look at")
    follow_up_question: str = Field(description="One short question the student can answer from the passage; empty when the verdict is right")
    reveals_answer: bool = Field(description="Your own check: true when the reply states the idea the check question asks for and the student did not")

    @classmethod
    def example(cls) -> "ReaderCheckReplyV2":
        return cls.model_validate(ReaderCheckReply.example().model_dump(exclude={"analysis", "from_fallback"}))

    @classmethod
    def example_for(cls, prompt: str) -> "ReaderCheckReplyV2":
        return cls.model_validate(ReaderCheckReply.example_for(prompt).model_dump(exclude={"analysis", "from_fallback"}))


# ---------------------------------------------------------------- recall grader (spec 5.3)

MAX_RECALL_ANSWER_CHARS = 5000
MAX_RECALL_CLAIMS = 40
RecallVerdictKind = Literal["covered", "partial", "missing", "incorrect"]


class RecallClaim(BaseModel):
    """A claim of a concept the recall prompt covers, from the student's own files."""

    id: str = Field(min_length=1, max_length=100)
    concept_id: str = Field(default="", max_length=100)
    concept_name: str = Field(default="", max_length=300)
    text: str = Field(max_length=1000)
    quote: str = Field(default="", max_length=MAX_TUTOR_TEXT_CHARS)
    page: Optional[int] = None


MAX_RECALL_ASKED = 40


class AskedQuestion(BaseModel):
    """A question the voice coach has already asked about a claim."""

    claim_id: str = Field(max_length=100)
    question: str = Field(min_length=1, max_length=400)


class RecallGradeRequest(BaseModel):
    """What the app sends to grade a recall answer: the prompt, the claims it should cover, the answer."""

    prompt: str = Field(min_length=1, max_length=MAX_TUTOR_TEXT_CHARS)
    claims: List[RecallClaim] = Field(min_length=1, max_length=MAX_RECALL_CLAIMS)
    answer: str = Field(max_length=MAX_RECALL_ANSWER_CHARS)
    # The call is billed to this user and project (billing.py).
    user_id: str = Field(min_length=1, max_length=100)
    project_id: str = Field(min_length=1, max_length=100)
    session_id: Optional[str] = Field(default=None, max_length=100)
    # The voice coach's teach-back (recall_grader.py, "spoken"): the answer was said aloud and the question for each open
    # claim is what the coach asks next, so it is written to be heard and a wrong claim gets one too.
    spoken: bool = False
    # Spoken only: questions the coach has already put to the student for a claim that is still open.
    asked: List[AskedQuestion] = Field(default_factory=list, max_length=MAX_RECALL_ASKED)


class ClaimVerdict(BaseModel):
    claim_id: str = Field(description="Id of the claim, exactly as given")
    verdict: RecallVerdictKind = Field(
        description="covered: the answer states the idea in any words. partial: it states part of it, or vaguely. missing: the answer does not touch it. incorrect: the answer says something that contradicts the claim."
    )
    student_quote: Optional[str] = Field(
        default=None,
        description="The student's own words that show a covered, partial or incorrect verdict, copied exactly from the answer; null for missing",
    )
    misconception: Optional[str] = Field(
        default=None, description="For incorrect only: the wrong idea the student seems to hold, in one short sentence"
    )
    kind: Optional[MissKind] = Field(
        default=None,
        description="For incorrect only. cue_miss: nothing relevant came to mind. discrimination: a wrong but related idea won. execution: right idea, run wrongly. careless: a slip, the rest of the answer shows they know it. misconception: the idea held is itself wrong.",
    )
    pointer: Optional[str] = Field(
        default=None,
        description="For missing or partial only: one short question that sends the student back to the right place in their pages without stating what the claim says",
    )
    reasoning_gap: Optional[bool] = Field(
        default=None,
        description="For covered only. true when the answer states the idea as a bare conclusion, without the support or reason the source gives for it; false when the reason is there. Leave out for other verdicts",
    )
    # Set by the service for a spoken answer, never written by the model: the question the coach may ask aloud for a
    # missing, partial or incorrect claim, or null when the model's question said what the claim says.
    probe: SkipJsonSchema[Optional[str]] = None


class SpokenClaimVerdict(ClaimVerdict):
    """A verdict on a spoken answer: the pointer is the question the voice coach asks next, wrong claims included."""

    pointer: Optional[str] = Field(
        default=None,
        description="For missing, partial or incorrect: the one question the voice coach asks the student aloud next to draw this claim out of them. One thing asked, 20 words or fewer, no choice between named answers, and never what the claim says",
    )


class RecallGradeResultV2(BaseModel):
    """Prompt revision (tutor area): the model-written fields of RecallGradeResult, without `analysis`."""

    confidence: float = Field(
        description="0 to 1: how sure you are that you understood the answer well enough to grade it. Under 0.8 when it is too short, in a language you cannot grade, noise, or unclear"
    )
    clarifying_question: Optional[str] = Field(
        default=None, description="When your confidence is under 0.8: one short question that would make the answer gradable"
    )
    verdicts: List[ClaimVerdict] = Field(description="One per claim given; empty when your confidence is under 0.8")

    @classmethod
    def example(cls) -> "RecallGradeResultV2":
        return cls.model_validate(RecallGradeResult.example().model_dump(exclude={"analysis", "status"}))

    @classmethod
    def example_for(cls, prompt: str) -> "RecallGradeResultV2":
        return cls.model_validate(RecallGradeResult.example_for(prompt).model_dump(exclude={"analysis", "status"}))


def _without_recall_service_fields(schema: Dict[str, Any]) -> None:
    schema.get("properties", {}).pop("status", None)


class RecallGradeResult(BaseModel):
    """The model's structured answer, and what the service returns after checking it.

    `status` is set by the service; the route returns everything but `analysis`."""

    # First and required, so the model writes its notes before the verdicts.
    analysis: str = Field(description="Private notes, never shown: what the answer says and how it compares with each claim")
    confidence: float = Field(
        description="0 to 1: how sure you are that you understood the answer well enough to grade it. Under 0.8 when it is too short, in a language you cannot grade, noise, or unclear"
    )
    clarifying_question: Optional[str] = Field(
        default=None, description="When your confidence is under 0.8: one short question that would make the answer gradable"
    )
    verdicts: List[ClaimVerdict] = Field(description="One per claim given; empty when your confidence is under 0.8")
    status: Literal["graded", "ungraded"] = "graded"

    model_config = ConfigDict(json_schema_extra=_without_recall_service_fields)

    @classmethod
    def example(cls) -> "RecallGradeResult":
        return cls(analysis="", confidence=0.9, verdicts=[])

    @classmethod
    def example_for(cls, prompt: str) -> "RecallGradeResult":
        """A grading for the claims and answer in `prompt` (the mock provider's answer).

        The first claim is covered, the second missing, the third incorrect, and so on round; the student's
        quotes are the opening words of the answer. An answer holding "xyzzy" is one the mock cannot read."""
        claim_ids = re.findall(r'<claim id="([^"]+)"', prompt)
        found = re.search(r"<student_answer>\n(.*?)\n</student_answer>", prompt, re.DOTALL)
        answer = unescape(found.group(1)) if found else ""
        if "xyzzy" in answer.lower():
            return cls(
                analysis="",
                confidence=0.4,
                clarifying_question="Which part of the topic do you mean?",
                verdicts=[],
            )
        words = answer.split()
        opening = " ".join(words[:6])
        later = " ".join(words[6:12]) or opening
        verdicts: List[ClaimVerdict] = []
        for position, claim_id in enumerate(claim_ids):
            slot = position % 3
            if slot == 0:
                verdicts.append(ClaimVerdict(claim_id=claim_id, verdict="covered", student_quote=opening or None))
            elif slot == 1:
                verdicts.append(ClaimVerdict(claim_id=claim_id, verdict="missing", pointer="What does the reading say about this idea?"))
            else:
                verdicts.append(
                    ClaimVerdict(
                        claim_id=claim_id,
                        verdict="incorrect",
                        student_quote=later or None,
                        misconception="A placeholder misconception. (mock)",
                        kind="misconception",
                    )
                )
        return cls(analysis="", confidence=0.9, verdicts=verdicts)


class RecallGradeResultSpoken(RecallGradeResult):
    """RecallGradeResult for a spoken answer (RecallGradeRequest.spoken): the verdicts' pointer is a question to say aloud."""

    verdicts: List[SpokenClaimVerdict] = Field(description="One per claim given; empty when your confidence is under 0.8")

    @classmethod
    def example(cls) -> "RecallGradeResultSpoken":
        return cls.model_validate(RecallGradeResult.example().model_dump())

    @classmethod
    def example_for(cls, prompt: str) -> "RecallGradeResultSpoken":
        return cls.model_validate(RecallGradeResult.example_for(prompt).model_dump())


class RecallGradeResultSpokenV2(RecallGradeResultV2):
    """RecallGradeResultV2 for a spoken answer."""

    verdicts: List[SpokenClaimVerdict] = Field(description="One per claim given; empty when your confidence is under 0.8")


# ---------------------------------------------------------------- gap explainer (spec 5.4)


class GapExplanation(BaseModel):
    """The explanation of one missed claim, and the check question that ends it."""

    claim_id: str = Field(description="The id of the gap, as given")
    explanation: str = Field(description="About 150 words explaining the claim from the excerpt, in plain words")
    check_question: str = Field(
        description="One question that asks the student to use or restate the idea, without quoting the explanation"
    )
    check_answer: str = Field(description="The answer to the check question, supported by the excerpt, in one or two sentences")


class GapExplanationSet(BaseModel):
    gaps: List[GapExplanation] = Field(description="One per gap given, in order")

    @classmethod
    def example(cls) -> "GapExplanationSet":
        return cls(gaps=[])

    @classmethod
    def example_for(cls, prompt: str) -> "GapExplanationSet":
        """An explanation for every gap in `prompt` (the mock provider's answer), built from the words
        of the excerpt the gap names, so that the support check can find them."""
        excerpts = {
            int(index): text
            for index, text in re.findall(r'<excerpt index="(\d+)"[^>]*>\n(.*?)\n</excerpt>', prompt, re.S)
        }
        gaps = []
        for claim_id, index in re.findall(r'<gap claim_id="([^"]+)"[^>]* excerpt="(\d+)"', prompt):
            opening = " ".join(excerpts.get(int(index), "").split()[:14])
            gaps.append(
                GapExplanation(
                    claim_id=claim_id,
                    explanation=f"Your pages put it this way: {opening} (mock)",
                    check_question="What do your pages say about this idea?",
                    check_answer=opening or "See the pages. (mock)",
                )
            )
        return cls(gaps=gaps)


# ---------------------------------------------------------------- ingest area, audited (v2) schemas
# Picked by `prompts_v2("ingest")`. Only field descriptions differ from the v1 models above, which
# stay byte-identical for the default path. Delete the v1 models once the area has run on v2.

# One definition of the three edge types, shared by the extractor and linker instructions and by
# both `type` field descriptions, so the direction of `encompasses` is stated the same way everywhere.
EDGE_TYPE_DEFINITIONS = """- prerequisite: the source must be known before the target is understood.
- encompasses: the target is the larger idea and contains the source, so practising the target also exercises the source. weight is how much of the source the target exercises: 0.25, 0.5, 0.75 or 1.
- confusable: students are likely to mix the two up, because they sound alike, look alike or are easily swapped in an answer. Direction does not matter."""

_EDGE_TYPE_DESCRIPTION_V2 = "How the two concepts relate. " + " ".join(
    line.lstrip("- ") for line in EDGE_TYPE_DEFINITIONS.splitlines()
)
_LINK_TYPE_DESCRIPTION_V2 = "How the two concepts relate. " + " ".join(
    line.lstrip("- ") for line in EDGE_TYPE_DEFINITIONS.splitlines() if not line.startswith("- prerequisite")
)


class MaterialCheckV2(MaterialCheck):
    is_valid: bool = Field(description="True when the file is readable material a student could study from")


class PlannedTopicV2(PlannedTopic):
    prerequisite_keys: List[str] = Field(
        description=(
            "Keys of EARLIER topics in this plan whose ideas this topic uses directly (for example "
            "Bayes' theorem builds on conditional probability). Empty for the first topic or one that "
            "needs nothing earlier"
        )
    )
    # R5: computed by the app from the sections' token counts (course_planner.default_minutes); not in the schema the
    # model fills, so 0 here means "use the default".
    estimated_minutes: SkipJsonSchema[int] = 0


class PlannedUnitV2(PlannedUnit):
    topics: List[PlannedTopicV2]


class CoursePlanV2(CoursePlan):
    units: List[PlannedUnitV2]

    @classmethod
    def example(cls) -> "CoursePlanV2":
        return cls.model_validate(CoursePlan.example().model_dump())

    @classmethod
    def example_for(cls, prompt: str) -> "CoursePlanV2":
        return cls.model_validate(CoursePlan.example_for(prompt).model_dump())


class ExtractedClaimV2(ExtractedClaim):
    text: str = Field(
        description=(
            "One thing a student who knows the concept can state, in your own words. A recall grader checks "
            "a student's answer against it, so make it a full statement that makes sense without the excerpt"
        )
    )


class ExtractedEdgeV2(ExtractedEdge):
    type: EdgeType = Field(description=_EDGE_TYPE_DESCRIPTION_V2)


class ConceptExtractionV2(ConceptExtraction):
    claims: List[ExtractedClaimV2] = Field(description="2-5 claims per concept")
    edges: List[ExtractedEdgeV2] = Field(default_factory=list)

    @classmethod
    def example(cls) -> "ConceptExtractionV2":
        return cls.model_validate(ConceptExtraction.example().model_dump())

    @classmethod
    def example_for(cls, prompt: str) -> "ConceptExtractionV2":
        return cls.model_validate(ConceptExtraction.example_for(prompt).model_dump())


class ProposedLinkV2(ProposedLink):
    type: Literal["confusable", "encompasses"] = Field(description=_LINK_TYPE_DESCRIPTION_V2)


class ConceptLinksV2(ConceptLinks):
    edges: List[ProposedLinkV2] = Field(default_factory=list, description="Only pairs from the candidate list")

    @classmethod
    def example(cls) -> "ConceptLinksV2":
        return cls.model_validate(ConceptLinks.example().model_dump())

    @classmethod
    def example_for(cls, prompt: str) -> "ConceptLinksV2":
        return cls.model_validate(ConceptLinks.example_for(prompt).model_dump())


# ---------------------------------------------------------------- audited (v2) schema descriptions
#
# With PROMPTS_V2 listing an area, its calls use these subclasses: the same fields, parsing and
# mock examples, with the audited field descriptions in the JSON schema the model sees. The v1
# classes above stay as they are until the area has run on v2 in production.

_CHIP_HELP = "Short plain-text names of the ideas tested, shown as chips; no LaTeX or markdown"
_CONFUSABLE_V2_HELP = (
    "Wrong options only: when the wrong idea is a mix-up with a concept of the <concepts> or "
    "<confusable_concepts> list, that concept's id"
)


def _with_descriptions(
    base: type, name: str, edits: Sequence[tuple], hidden: Sequence[tuple] = (), moved: Sequence[tuple] = ()
) -> type:
    """`base` with field descriptions replaced in its JSON schema. Each edit is
    (definition name or None for the model itself, field, description). A field that is not
    in the schema raises, so a renamed field cannot silently lose its description. Each `hidden`
    (definition, field) is left out of the schema the model fills; the field must have a default.
    Each `moved` (definition, field, after) puts the field right after another one: the model writes
    the fields in the schema's order, so this decides what it has written before what."""

    def model_json_schema(cls, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        schema = super(variant, cls).model_json_schema(*args, **kwargs)
        for definition, field, text in edits:
            holder = schema if definition is None else schema["$defs"][definition]
            holder["properties"][field]["description"] = text
        for definition, field in hidden:
            holder = schema if definition is None else schema["$defs"][definition]
            del holder["properties"][field]
            if field in holder.get("required", []):
                holder["required"].remove(field)
        for definition, field, after in moved:
            holder = schema if definition is None else schema["$defs"][definition]
            properties = dict(holder["properties"])
            value = properties.pop(field)
            if after not in properties:
                raise KeyError(after)
            holder["properties"] = {
                key: item
                for existing, prop in properties.items()
                for key, item in ((existing, prop), *(((field, value),) if existing == after else ()))
            }
        return schema

    variant = type(name, (base,), {"model_json_schema": classmethod(model_json_schema), "__module__": __name__})
    return variant


_QUESTION_V2_EDITS = (
    ("ChoiceOption", "confusable_concept_id", _CONFUSABLE_V2_HELP),
    ("GeneratedQuestion", "concepts_tested", _CHIP_HELP),
)

# The excerpts an item rests on are named before its answer is written, so the answer is written from them and
# the list is not filled in afterwards to fit.
_QUESTION_SOURCES_FIRST = (("GeneratedQuestion", "source_excerpts", "question_text"),)
# The app sets the difficulty of a quiz, exam or review question and of an example after generation (the request
# names it), so the model is not shown the field: "leave out" on a field it can see was asking for it to be filled.
_QUESTION_DIFFICULTY_BY_APP = (("GeneratedQuestion", "difficulty"),)

QuestionSetV2 = _with_descriptions(
    QuestionSet, "QuestionSetV2", _QUESTION_V2_EDITS, hidden=_QUESTION_DIFFICULTY_BY_APP, moved=_QUESTION_SOURCES_FIRST
)
ReviewItemSetV2 = _with_descriptions(
    ReviewItemSet, "ReviewItemSetV2", _QUESTION_V2_EDITS, hidden=_QUESTION_DIFFICULTY_BY_APP, moved=_QUESTION_SOURCES_FIRST
)
# Warm-up difficulty is the model's: the bank is bracketed on it.
WarmupSetV2 = _with_descriptions(WarmupSet, "WarmupSetV2", _QUESTION_V2_EDITS, moved=_QUESTION_SOURCES_FIRST)

SolvedExampleSetV2 = _with_descriptions(
    SolvedExampleSet, "SolvedExampleSetV2",
    (
        ("SolutionStep", "description", "One line naming what this step does"),
        ("SolutionStep", "work", "The math or reasoning that carries out the step"),
        ("SolutionStep", "explanation", "Why the step is taken"),
        ("SolvedExample", "final_answer", "2-5 markdown bullets"),
        ("SolvedExample", "key_concepts", _CHIP_HELP),
    ),
    hidden=(("SolvedExample", "difficulty"),),
    moved=(("SolvedExample", "source_excerpts", "problem_statement"),),
)
InteractiveExampleSetV2 = _with_descriptions(
    InteractiveExampleSet, "InteractiveExampleSetV2",
    (
        ("InteractiveExample", "key_concepts", _CHIP_HELP),
    ),
    # R5: the minutes are computed by the app from the step count (examples.py), not asked of the model.
    hidden=(("InteractiveExample", "estimated_time_minutes"), ("InteractiveExample", "difficulty")),
    moved=(("InteractiveExample", "source_excerpts", "problem_statement"),),
)
ExamStyleProfileV2 = _with_descriptions(
    ExamStyleProfile, "ExamStyleProfileV2",
    (
        (
            None,
            "example_stems",
            "Exactly 3 short example question stems in new words about a different situation than the "
            "exam's, showing the voice and shape of its questions without reproducing its text",
        ),
    ),
)
ExamTopicMapV2 = _with_descriptions(
    ExamTopicMap, "ExamTopicMapV2",
    (
        (
            "ExamQuestionTopics",
            "summary",
            "What the question tests, in your own words, in 12 words or fewer (summaries are stored, "
            "so they must not reproduce the exam's wording)",
        ),
    ),
)
GapExplanationSetV2 = _with_descriptions(
    GapExplanationSet, "GapExplanationSetV2",
    (
        (
            "GapExplanation",
            "explanation",
            "A short paragraph, in plain words, that states the idea as the excerpt does and, if there is "
            "a misconception, where it goes wrong",
        ),
    ),
)

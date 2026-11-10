"""Guards from the 2026-11-09 prompt audit, so the same faults can't come back unnoticed.

On the Claude 5.5 models a required field that asks the model to write out its reasoning can be
declined as reasoning extraction, and server-side fallback does not retry that. Reasoning stays in
thinking blocks; a schema the model fills never has a field for it.
"""
import importlib
import inspect
import pkgutil
import re

from pydantic import BaseModel

import app
from app.services.llm import schemas

REASONING_FIELDS = {"analysis", "reasoning", "thinking", "scratchpad", "chain_of_thought", "trace"}

# v1 schemas that still carry the field; each is replaced by its V2 class behind PROMPTS_V2 and is
# deleted with the v1 prompts. Nothing may be added to this list.
V1_WITH_ANALYSIS = {"PracticeTutorReply", "ReaderTutorReply", "ReaderCheckReply", "RecallGradeResult"}


def _models():
    return [
        cls
        for name, cls in inspect.getmembers(schemas, inspect.isclass)
        if issubclass(cls, BaseModel) and cls.__module__ == schemas.__name__
    ]


def _field_names(schema: dict) -> set[str]:
    names = set(schema.get("properties", {}))
    for definition in schema.get("$defs", {}).values():
        names |= set(definition.get("properties", {}))
    return names


def test_no_schema_asks_the_model_for_its_reasoning():
    offenders = {}
    for cls in _models():
        if cls.__name__ in V1_WITH_ANALYSIS:
            continue
        found = _field_names(cls.model_json_schema()) & REASONING_FIELDS
        if found:
            offenders[cls.__name__] = sorted(found)
    assert offenders == {}, f"Reasoning fields in model-facing schemas: {offenders}"


def test_the_v1_exceptions_each_have_a_v2_without_the_field():
    for name in V1_WITH_ANALYSIS:
        v2 = getattr(schemas, f"{name}V2")
        assert not _field_names(v2.model_json_schema()) & REASONING_FIELDS, name


# R1 of the completeness sweep: the same request can come through a field's description or the prompt text, not only
# a field's name. The web app's voice tools have the same check (frontend/src/lib/voice/tool-contract.test.ts).
ASKS_FOR_REASONING = re.compile(
    r"\b(?:explain|describe|show|write(?: out)?|give|state|record|summari[sz]e)\s+(?:your|its|the)\s+"
    r"(?:reasoning|thinking|thought process|chain of thought)\b"
    r"|\b(?:your|its) (?:reasoning|thought process|chain of thought)\b"
    r"|\bthink (?:it )?(?:step by step|out loud|aloud)\b|\bstep[- ]by[- ]step reasoning\b"
    # the v1 tutor's wording: "work out in the analysis field ...", "Private notes, never shown"
    r"|\bin the (?:analysis|reasoning|scratchpad|thinking|notes) field\b|\bprivate (?:notes|analysis|reasoning)\b",
    re.IGNORECASE,
)


def test_no_v2_prompt_or_field_description_asks_for_reasoning():
    texts = list(_v2_prompts().items())
    for cls in _models():
        if cls.__name__ not in V1_WITH_ANALYSIS:
            texts += [(f"schema {cls.__name__}", d) for d in _descriptions(cls.model_json_schema())]
    offenders = {key: match.group(0) for key, text in texts if (match := ASKS_FOR_REASONING.search(text))}
    assert offenders == {}, f"Text that asks the model to write out its reasoning: {offenders}"


# ---- Guards from the prompt audit, R3 and R4: the v2 prompt text -------------------------------------------------
# Copies of one sentence drift apart, and a hard word ceiling in a prompt only duplicates the trim the code
# already does. Both are checked over every v2 constant in app/ and every V2 schema.

PROMPT_NAMES = re.compile(r"_V2$|^FROZEN_SYSTEM_PROMPT$")
MIN_SENTENCE_WORDS = 9

# A sentence that may appear in two different v2 constants without one being built from the other,
# each with the reason. Every other repeat found was moved to a shared constant.
ALLOWED_REPEATS: dict[str, str] = {
    "Everything inside the data tags is written by the student or taken from their files.": (
        "the standard data notice closing every tutor prompt; the recall grader's is inherited from its v1 text"
    ),
    "You are a reading tutor for one student who is reading a passage from their own course files.": (
        "the role line opening the reader's three prompts, each of which continues differently"
    ),
}

# Hard ceilings that stay in v2 text, each with the reason.
ALLOWED_CEILINGS = {
    "Keep the whole reply under 60 words": "Ask's commit move: a recorded decision, the reply must stay a question",
}

WORD_CEILING = re.compile(
    r"\b(?:at most|no more than|under|fewer than|maximum of)\s+\d+\s+words\b|\bnever more than \d+", re.IGNORECASE
)


def _app_modules():
    for info in pkgutil.walk_packages(app.__path__, "app."):
        try:
            yield importlib.import_module(info.name)
        except Exception:  # a module that needs services this test does not have holds no prompt text
            continue


def _string_constants():
    """(module.name, text) for every module-level string, and the strings of module-level dicts and tuples.
    A constant imported into another module is the same text, so each text is listed once."""
    seen: set[str] = set()
    for module in _app_modules():
        for name, value in vars(module).items():
            if name.startswith("__"):
                continue
            if isinstance(value, str):
                items = [(name, value)]
            elif isinstance(value, dict):
                items = [(f"{name}[{key!r}]", item) for key, item in value.items() if isinstance(item, str)]
            elif isinstance(value, tuple):
                items = [(f"{name}[{index}]", item) for index, item in enumerate(value) if isinstance(item, str)]
            else:
                continue
            for label, text in items:
                if text not in seen:
                    seen.add(text)
                    yield f"{module.__name__}.{label}", text


def _v2_prompts() -> dict[str, str]:
    return {key: text for key, text in _string_constants() if PROMPT_NAMES.search(key.split(".")[-1].split("[")[0])}


def _sentences(text: str) -> set[str]:
    found = set()
    for part in re.split(r"(?<=[.!?;:])\s+|\n+", text):
        part = re.sub(r"^[-*\d.)\s]+", "", part).strip()
        if len(part.split()) >= MIN_SENTENCE_WORDS:
            found.add(part)
    return found


def test_a_v2_sentence_lives_in_one_constant():
    prompts = _v2_prompts()
    owners: dict[str, list[str]] = {}
    for key, text in prompts.items():
        for sentence in _sentences(text):
            owners.setdefault(sentence, []).append(key)

    # A line of a shared constant that both texts contain verbatim is one source. A constant with a V2 twin is the v1
    # text of an audited prompt, not a shared piece, so it does not count.
    def base(key: str) -> str:
        return key.split("[")[0]

    names = {base(key) for key, _ in _string_constants()}
    shared_lines = [
        line
        for key, text in _string_constants()
        if key not in prompts and f"{base(key)}_V2" not in names
        for line in (re.sub(r"^[-*\s]+", "", raw).strip() for raw in text.splitlines())
        if len(line.split()) >= MIN_SENTENCE_WORDS
    ]

    def built_from_one_source(sentence: str, a: str, b: str) -> bool:
        ta, tb = prompts[a], prompts[b]
        if ta in tb or tb in ta:
            return True
        if any(text in ta and text in tb and sentence in text for key, text in prompts.items() if key not in (a, b)):
            return True  # a v2 constant both are built from
        return any(sentence in line and line in ta and line in tb for line in shared_lines)

    copies: dict[str, set[str]] = {}
    for sentence, keys in owners.items():
        if sentence in ALLOWED_REPEATS:
            continue
        for i, a in enumerate(keys):
            for b in keys[i + 1 :]:
                if not built_from_one_source(sentence, a, b):
                    copies.setdefault(sentence, set()).update({a, b})
    assert copies == {}, "The same sentence is written out in two v2 constants; share one: " + repr(
        {sentence[:70]: sorted(keys) for sentence, keys in copies.items()}
    )


def _descriptions(node) -> list[str]:
    if isinstance(node, dict):
        found = [node["description"]] if isinstance(node.get("description"), str) else []
        for value in node.values():
            found += _descriptions(value)
        return found
    if isinstance(node, list):
        return [text for item in node for text in _descriptions(item)]
    return []


def test_v2_text_has_no_hard_word_ceiling():
    """The code trims (`limit_reply` and its siblings); the prompt gives an "about N words" target."""
    texts = list(_v2_prompts().items())
    for cls in _models():
        if cls.__name__.endswith("V2"):
            texts += [(f"schema {cls.__name__}", d) for d in _descriptions(cls.model_json_schema())]
    offenders: dict[str, list[str]] = {}
    for key, text in texts:
        for match in WORD_CEILING.finditer(text):
            around = text[max(0, match.start() - 40) : match.end()]
            if not any(allowed in around for allowed in ALLOWED_CEILINGS):
                offenders.setdefault(key, []).append(around.strip())
    assert offenders == {}, f"Hard word ceilings in v2 text (use 'about N words'): {offenders}"

"""The Python mirror of the voice app's rule classifier for a student utterance (frontend/src/lib/voice/utterance.ts, spec 19.1).

The app decides by rule, before any model call, whether an utterance is control, a request or question (meta), an "I don't know" or an
answer, and runs the graded step for the last two before the model speaks. The eval plays the same rules so that a scripted
student message costs the coach the same number of model calls it costs in the app. The pattern tables are read from
fixtures/utterance_parity.json (written by frontend/scripts/teach-parity-fixture.ts from the real code), so they cannot drift; the
code here is only the order in which they are applied and the text normalising, and test_utterance.py replays every case in the
fixture through it.
"""
import json
import re
from pathlib import Path
from typing import Any, Dict, List

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "utterance_parity.json"


def _load() -> Dict[str, Any]:
    return json.loads(FIXTURE.read_text())


RULES = _load()["rules"]
_CONTROL = [re.compile(p) for p in RULES["control"]]
_HELP = [re.compile(p) for p in RULES["help"]]
_REPEAT = [re.compile(p) for p in RULES["repeat"]]
_ACKNOWLEDGE = [re.compile(p) for p in RULES["acknowledge"]]
_INTERROGATIVE = re.compile(RULES["interrogative"])
_LOW_EFFORT = set(RULES["low_effort"])
_FILLER = set(RULES["filler"])
_REQUEST_WORDS = set(RULES["request_words"])
_CORE_WORDS = set(RULES["core_words"])


def normalize(text: str) -> str:
    """lib/learning/dont-know.ts normalize: lowercase, apostrophes dropped, other punctuation turned to spaces."""
    trimmed = text.strip().lower()
    if re.fullmatch(r"\?+", trimmed):
        return "?"
    trimmed = re.sub(r"['’`]", "", trimmed)
    trimmed = re.sub(r"[^\w\s]|_", " ", trimmed)
    return re.sub(r"\s+", " ", trimmed).strip()


def is_dont_know(text: str) -> bool:
    """lib/learning/dont-know.ts isDontKnow."""
    normalized = normalize(text)
    if normalized == "" or normalized in _LOW_EFFORT:
        return True
    content = [word for word in normalized.split(" ") if word not in _FILLER]
    asks_for_answer = bool(re.search(r"\b(?:answer|solution)\b", normalized)) and any(word in ("what", "how") for word in content)
    return (asks_for_answer or any(word in _CORE_WORDS for word in content)) and all(word in _REQUEST_WORDS for word in content)


def _words(text: str) -> List[str]:
    return [word for word in normalize(text).split(" ") if word]


def classify_utterance(text: str) -> str:
    """'control', 'idk', 'meta' or 'answer', in the order the app applies the rules."""
    normalized = normalize(text)
    if not normalized:
        return "meta"
    if any(p.search(normalized) for p in _CONTROL):
        return "control"
    count = len(_words(text))
    if count <= 14 and any(p.search(normalized) for p in _HELP):
        return "meta"
    if is_dont_know(text):
        return "idk"
    if count <= 14 and any(p.search(normalized) for p in _REPEAT):
        return "meta"
    if any(p.search(normalized) for p in _ACKNOWLEDGE):
        return "meta"
    if len(normalized.split(" ")) <= 10 and _INTERROGATIVE.search(normalized):
        return "meta"
    return "answer"


def has_substance(text: str, kind: str) -> bool:
    """An explanation worth grading: three words or more, or an "I don't know"."""
    return kind == "idk" or (kind == "answer" and len(_words(text)) >= 3)


def app_result_text(tool: str, output: Dict[str, Any]) -> str:
    """The text block that carries a step's result to the model (frontend/src/lib/voice/pre-run.ts appResultBlock)."""
    body = json.dumps(output, separators=(",", ":"), ensure_ascii=False)
    body = re.sub(r"</app_result", r"<\\/app_result", body, flags=re.I)
    return f'<app_result step="{tool}">{body}</app_result>'

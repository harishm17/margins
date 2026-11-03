"""The app's side of an Ask conversation, in Python: what the Next.js server does around the AI service.

The Ask eval calls the AI service directly, so what the server sends with each question (the thread's tutor
state, the exam guard's decline) and what it records afterwards have to come from somewhere. This module
mirrors:

    frontend/src/lib/ask/exam-guard.ts   examGuard, tokens
    frontend/src/lib/ask/ask-turn.ts     planAskTurn, tutorEventFor, rungUsed, replyTaught, understandModeFor,
                                         deliveredUnderstandMode, nextUnderstand
    frontend/src/lib/learning/level.ts   askExplainThreshold (the band a scenario states stands in for conceptBand)
    frontend/src/lib/tutor/state.ts      applyTutorEvent (through app_state.py)
    frontend/src/lib/ask/ask-check.ts    a card's self-grade changes nothing in the thread's state

If those change, change this file; `test_ask_state.py` plays the scenarios through it and compares with
fixtures/ask_state_parity.json, which frontend/scripts/ask-parity-fixture.ts writes from the real TypeScript.
No app imports and no network here.
"""
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from app_state import Event, State, apply_event

WORKED_EXAMPLE_REQUEST = (
    "Show me a worked example of a similar problem with different numbers, and then I will apply it to my own problem."
)
HIGHEST_ORDINARY_RUNG = 4
EXAM_GUARD_SIMILARITY = 0.5
EXAM_GUARD_COVERAGE = 0.6
MIN_WORDS_FOR_COVERAGE = 4
EXAM_GUARD_NOTE = "A question from the mock exam in progress. It is not kept."
EXAM_GUARD_REPLY = "That looks like a question from the mock exam you're taking. Finish it first, then ask me."
HISTORY_MESSAGES = 6

STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as", "is", "are", "was", "were",
    "be", "been", "it", "its", "this", "that", "these", "those", "which", "what", "who", "do", "does", "did", "can", "could", "you",
    "me", "my", "i", "we", "please", "help", "about", "if", "then", "so",
}


def tokens(text: str) -> Set[str]:
    """Lowercased words, apostrophes dropped, stopwords removed (exam-guard.ts tokens).

    Composed form first (NFC), then a word is a run of letters and numbers of any script: `[\\W_]+` splits on what
    the TypeScript's `[^\\p{L}\\p{N}]+` splits on (checked over every assigned code point).
    """
    cleaned = re.sub(r"['’`]", "", unicodedata.normalize("NFC", text).lower())
    return {word for word in re.split(r"[\W_]+", cleaned) if word and word not in STOPWORDS}


EXAM_GUARD_RECENT_TURNS = 3


def _chunks(message: str, recent: Sequence[str] = ()) -> List[Set[str]]:
    """The message as a whole, then each sentence, question and line of it, then the student's last few messages
    joined with this one (exam-guard.ts chunksOf)."""
    parts = [part.strip() for part in re.split(r"(?<=[.?!])\s+|\n+", message) if part.strip()]
    earlier = [turn for turn in list(recent)[-EXAM_GUARD_RECENT_TURNS:] if turn.strip()]
    joined = [tokens(" ".join([*earlier, message]))] if earlier else []
    chunks = [tokens(message)] + ([tokens(part) for part in parts] if len(parts) > 1 else []) + joined
    return [chunk for chunk in chunks if chunk]


def exam_guard(message: str, open_questions: Sequence[str], recent: Sequence[str] = ()) -> bool:
    """examGuard: Jaccard >= 0.5, or >= 0.6 of the question's own words, in the message, one sentence of it, or the
    message joined with the student's recent ones. The meaning check (ai-service exam_guard.py) is a second layer."""
    chunks = _chunks(message, recent)
    for question in open_questions:
        words = tokens(question)
        if not words:
            continue
        for chunk in chunks:
            shared = len(chunk & words)
            if shared / (len(chunk) + len(words) - shared) >= EXAM_GUARD_SIMILARITY:
                return True
            if len(words) >= MIN_WORDS_FOR_COVERAGE and shared / len(words) >= EXAM_GUARD_COVERAGE:
                return True
    return False


def exam_question_texts(questions: Sequence[Dict[str, Any]]) -> List[str]:
    """examQuestionTexts: each stem, and the stem with its options."""
    texts: List[str] = []
    for question in questions:
        stem = str(question.get("question_text", "")).strip()
        if not stem:
            continue
        options = [str(option.get("text", "")) for option in question.get("options") or []]
        texts.append(stem)
        if options:
            texts.append(f"{stem} {' '.join(options)}")
    return texts


def _capped(rung: int) -> int:
    return min(rung, HIGHEST_ORDINARY_RUNG)


NEW_PROBLEM_MIN_CHARS = 40
NEW_PROBLEM_OVERLAP = 0.25


def _overlap(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


FIRST_PERSON = re.compile(r"\b(?:i|i'm|i've|i'd|i'll|my|we)\b", re.IGNORECASE)
OPENS_AS_REQUEST = re.compile(
    r"^\s*(?:please|pls|can you|could you|would you|help|solve|find|calculate|compute|determine|what is|what's|how (?:do|many|much)|give me)\b",
    re.IGNORECASE,
)


def is_new_problem(question: str, prior: Sequence[str]) -> bool:
    """isNewProblem: a statement with a quantity that has little in common with anything written earlier in the thread,
    and is not the student's own work."""
    if not prior or len(question.strip()) < NEW_PROBLEM_MIN_CHARS or not re.search(r"\d|=", question):
        return False
    if FIRST_PERSON.search(question) and not OPENS_AS_REQUEST.search(question):
        return False
    words = tokens(question)
    return all(_overlap(words, tokens(earlier)) < NEW_PROBLEM_OVERLAP for earlier in prior)


def is_repeat(question: str, prior: Sequence[str]) -> bool:
    """isRepeat: the same attempt again, however spaced or cased."""
    words = tokens(question)
    if not words:
        return False
    for earlier in prior:
        other = tokens(earlier)
        if other and _overlap(words, other) >= 0.9 and abs(len(words) - len(other)) <= max(1, int(len(other) * 0.2)):
            return True
    return False


def ask_explain_threshold(band: int) -> int:
    """askExplainThreshold: non-attempt turns before a short explanation. One in band 0, else two."""
    return 1 if band == 0 else 2


def understand_mode_for(no_attempt: int, band: int) -> str:
    """understandModeFor: a short explanation once the earlier non-attempt turns reach the threshold, else a question."""
    return "explain_short" if no_attempt >= ask_explain_threshold(band) else "commit"


def delivered_understand_mode(tutor: Dict[str, Any], route: Dict[str, Any]) -> Optional[str]:
    """deliveredUnderstandMode: the mode the reply was written in, from the plan and the route."""
    if route["intent"] != "understand":
        return None
    if route.get("broad"):
        return "entry_points"
    if route.get("has_attempt"):
        return "explain"
    return tutor.get("understand_mode", "commit")


def next_understand(no_attempt: int, concepts: Sequence[str], route: Dict[str, Any], delivered: Optional[str]) -> Tuple[int, List[str]]:
    """nextUnderstand: an attempt or a short explanation resets the count; otherwise a turn adds one on the same concepts
    (or none counted yet, or none routed) and restarts the count at 1 on new ones. Broad, degraded and other turns do not count."""
    if route["intent"] != "understand" or route.get("degraded") or route.get("broad"):
        return no_attempt, list(concepts)
    routed = list(route.get("concept_ids") or [])
    if route.get("has_attempt") or delivered == "explain_short":
        return 0, routed or list(concepts)
    continues = not concepts or not routed or any(item in concepts for item in routed)
    if not continues:
        return 1, routed
    return no_attempt + 1, list(dict.fromkeys([*concepts, *routed]))


def plan_ask_turn(
    stored: State, question: str, kind: str, prior: Sequence[str] = (), understand: Tuple[int, int] = (0, 0)
) -> Optional[Dict[str, Any]]:
    """planAskTurn: the `tutor` body sent with the question, or None when the worked example is not allowed yet.
    `understand` is the thread's (non-attempt count, band of its concepts)."""
    state = State() if kind == "ask" and is_new_problem(question, prior) else stored
    if kind == "show_worked":
        _, flags = apply_event(state, Event("show_worked"))
        if not flags.worked_allowed:
            return None
        return {
            "rung": 5,
            "final_allowed": False,
            "ask_what_is_unclear": False,
            "attempt_rung": 5,
            "attempt_ask_what_is_unclear": False,
            "show_worked": True,
        }
    as_request, request_flags = apply_event(state, Event("request"))
    as_attempt, attempt_flags = apply_event(state, Event("attempt", text=question))
    return {
        "rung": _capped(as_request.rung),
        "final_allowed": False,  # Ask has no key and a self-grade is not proof
        "ask_what_is_unclear": request_flags.ask_what_is_unclear,
        "attempt_rung": _capped(as_attempt.rung),
        "attempt_ask_what_is_unclear": attempt_flags.ask_what_is_unclear,
        "understand_mode": understand_mode_for(*understand),
        "attempt_understand_mode": "explain",
    }


def tutor_event_for(kind: str, question: str, route: Dict[str, Any], prior: Sequence[str] = ()) -> Optional[Event]:
    """tutorEventFor: the one event the turn is on the ladder, once the route is known."""
    if route.get("degraded"):
        return None
    if kind == "show_worked":
        return Event("show_worked") if route["intent"] == "solve" else None
    # Only solve turns use the ladder: the server cannot know whether a checked answer was right, so it does not climb.
    if route["intent"] != "solve":
        return None
    # An attempt that repeats an earlier message is only a request, so repeating one cannot climb the ladder.
    if route.get("has_attempt") and not is_repeat(question, prior):
        return Event("attempt", text=question)
    return Event("request")


def rung_used(kind: str, tutor: Dict[str, Any], route: Dict[str, Any]) -> int:
    if kind == "show_worked":
        return 5
    return tutor["attempt_rung"] if route.get("has_attempt") else tutor["rung"]


def reply_taught(kind: str, tutor: Dict[str, Any], route: Dict[str, Any], stop_reason: str) -> bool:
    if route.get("degraded") or stop_reason == "leak_fallback":
        return False
    if route["intent"] == "understand":
        return delivered_understand_mode(tutor, route) in ("explain", "explain_short")
    if route["intent"] == "solve":
        return rung_used(kind, tutor, route) >= 4
    return False


@dataclass
class Decision:
    """What the server does with one scripted student turn."""

    declined: bool = False
    blocked: bool = False
    question: str = ""
    kind: str = "ask"
    tutor: Optional[Dict[str, Any]] = None
    history: Optional[List[Dict[str, str]]] = None
    fresh: bool = False  # the message starts a new problem: the ladder begins again
    prior: Sequence[str] = ()
    understand: Tuple[int, List[str]] = (0, [])  # the thread's counter before the turn


class Conversation:
    """One Ask thread as the server sees it: the tutor state, the history it sends, the exam in progress.

    `step(turn)` gives the decision for a turn; `commit(decision, route, stop_reason, reply)` is what
    the server does once the reply is stored (a failed reply commits nothing)."""

    def __init__(self, scenario: Dict[str, Any]):
        self.state = State()
        self.history: List[Dict[str, str]] = []
        self.no_attempt = 0
        self.concepts: List[str] = []
        self.band = int(scenario.get("band", 1))  # no database here: the scenario states the band of its concepts
        self.exam_questions = exam_question_texts(scenario.get("open_exam") or [])

    def recent_user_turns(self) -> List[str]:
        """What the student wrote earlier in the thread: a declined message is kept as a note, which they did not write."""
        return [m["content"] for m in self.history if m["role"] == "user" and m["content"] != EXAM_GUARD_NOTE]

    def step(self, turn: Dict[str, Any]) -> Decision:
        if turn["event"] == "card":
            return Decision(kind="card")
        kind = "show_worked" if turn["event"] == "show_worked" else "ask"
        question = WORKED_EXAMPLE_REQUEST if kind == "show_worked" else turn["message"].strip()
        if kind == "ask" and exam_guard(question, self.exam_questions, self.recent_user_turns()):
            return Decision(declined=True, question=question)
        prior = self.recent_user_turns()
        tutor = plan_ask_turn(self.state, question, kind, prior, (self.no_attempt, self.band))
        if tutor is None:
            return Decision(blocked=True, question=question, kind=kind)
        fresh = kind == "ask" and is_new_problem(question, prior)
        return Decision(question=question, kind=kind, tutor=tutor, history=list(self.history[-HISTORY_MESSAGES:]), fresh=fresh, prior=prior, understand=(self.no_attempt, list(self.concepts)))

    def commit_card(self, grade: str) -> None:
        """A card's grade is the student's own, so it never tells the tutor they hold a right answer."""

    def commit(self, decision: Decision, route: Optional[Dict[str, Any]], stop_reason: str, reply: str) -> bool:
        """Apply the turn. Returns whether the reply taught (level-3 evidence)."""
        self.history += [{"role": "user", "content": decision.question}, {"role": "assistant", "content": reply}]
        if decision.declined or route is None or decision.tutor is None:
            return False
        taught = reply_taught(decision.kind, decision.tutor, route, stop_reason)
        if decision.fresh:
            self.state = State()
        self.no_attempt, self.concepts = next_understand(decision.understand[0], decision.understand[1], route, delivered_understand_mode(decision.tutor, route))
        event = tutor_event_for(decision.kind, decision.question, route, decision.prior)
        if event is not None:
            self.state, _ = apply_event(self.state, event)
        return taught


def parity_trace(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The scenario's turns played through the mirror with the scripted `route` of each turn standing in for
    the router: the trace ask-parity-fixture.ts writes from the real TypeScript."""
    conversation = Conversation(scenario)
    out: List[Dict[str, Any]] = []
    for position, turn in enumerate(scenario["turns"], 1):
        trace: Dict[str, Any] = {"turn": position, "event": turn["event"]}
        if turn["event"] == "card":
            conversation.commit_card(turn["grade"])
            out.append({**trace, "checked_correct": conversation.state.checked_correct})
            continue
        decision = conversation.step(turn)
        if decision.declined:
            out.append({**trace, "declined": True, "checked_correct": conversation.state.checked_correct})
            conversation.history += [{"role": "user", "content": EXAM_GUARD_NOTE}, {"role": "assistant", "content": EXAM_GUARD_REPLY}]
            continue
        if decision.blocked:
            out.append({**trace, "blocked": True, "checked_correct": conversation.state.checked_correct})
            continue
        route = turn["route"]
        stop_reason = turn.get("stop_reason", "end_turn")
        taught = conversation.commit(decision, route, stop_reason, turn.get("reply", "(reply)"))
        out.append(
            {
                **trace,
                "tutor": decision.tutor,
                "history": decision.history,
                "rung_used": rung_used(decision.kind, decision.tutor, route),
                "taught": taught,
                "rung_after": conversation.state.rung,
                "attempts": conversation.state.attempts,
                "low_effort_turns": conversation.state.low_effort_turns,
                "understand_no_attempt": conversation.no_attempt,
                "checked_correct": conversation.state.checked_correct,
            }
        )
    return out


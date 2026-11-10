"""The app's side of a practice conversation, in Python: what the Next.js server does before it asks
the tutor for words.

The eval calls the AI service directly, so the move and the rung that the server would pick for each
scripted student turn have to come from somewhere. This module mirrors, line for line:

    frontend/src/lib/tutor/state.ts             rungs, counters, moves, check counts
    frontend/src/lib/tutor/first-wrong-step.ts  the first step the working got wrong
    frontend/src/lib/tutor/practice-tutor.ts    which events call the model, the request it builds

If those change, change this file; `test_app_state.py` pins the cases from state.test.ts and
first-wrong-step.test.ts. No app imports and no network here.
"""
import re
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from answer_check import check_practice_answer, number_candidates

AUTHORED_HINT_RUNG = (1, 3, 4)
MIN_ATTEMPT_CHARS = 12
LOW_EFFORT_LIMIT = 3
WORKED_OFFER_AT = 3
HIGHEST_ATTEMPT_RUNG = 4
MAX_ATTEMPT_CHARS = 500

LOW_EFFORT = (
    "idk", "i dont know", "dont know", "no idea", "no clue", "i dont remember", "not sure at all", "just tell me", "give me the answer",
    "tell me the answer", "hint", "help", "?",
)
FILLER = {
    "please", "pls", "plz", "thanks", "thank", "ok", "okay", "so", "the", "a", "an", "me", "my", "can", "could", "would", "you", "just",
    "answer", "to", "for", "i", "im", "is", "it", "this", "that", "some", "another", "next", "more", "sorry", "hmm", "hm", "um", "uh",
    "really", "honestly", "actually", "well", "lol",
}
REQUEST_WORDS = {
    "idk", "dont", "know", "no", "idea", "tell", "give", "show", "hint", "hints", "help", "stuck", "clue", "solution", "what", "how",
    "remember",
}
# Mirrors CORE_WORDS in frontend/src/lib/learning/dont-know.ts: at least one must be present.
CORE_WORDS = {"idk", "know", "idea", "clue", "remember", "stuck", "hint", "hints", "help", "tell", "give", "show", "solution"}


def _normalize(text: str) -> str:
    trimmed = text.strip().lower()
    if re.fullmatch(r"\?+", trimmed):
        return "?"
    trimmed = re.sub(r"['\u2019`]", "", trimmed)
    trimmed = re.sub(r"[^\w\s]|_", " ", trimmed)
    return re.sub(r"\s+", " ", trimmed).strip()


def _is_only_request(text: str) -> bool:
    normalized = _normalize(text)
    if normalized == "" or normalized in LOW_EFFORT:
        return True
    content = [word for word in normalized.split(" ") if word not in FILLER]
    asks_for_answer = re.search(r"\b(?:answer|solution)\b", normalized) is not None and any(word in ("what", "how") for word in content)
    has_core = asks_for_answer or any(word in CORE_WORDS for word in content)
    return has_core and all(word in REQUEST_WORDS for word in content)


def is_genuine_attempt(text: str) -> bool:
    trimmed = text.strip()
    if len(trimmed) < MIN_ATTEMPT_CHARS:
        return False
    return not _is_only_request(trimmed)


def is_bare_guess(text: str) -> bool:
    trimmed = text.strip()
    if trimmed == "" or len(trimmed) >= MIN_ATTEMPT_CHARS or _is_only_request(trimmed):
        return False
    return len(re.findall(r"[^\W\d_]{3,}", trimmed)) <= 1


@dataclass(frozen=True)
class State:
    """The TutorState row of one step's conversation (store.ts StoredTutorState)."""

    rung: int = 0
    max_rung: int = 0
    attempts: int = 0
    low_effort_turns: int = 0
    hints_opened: int = 0
    bare_guesses: int = 0
    same_rung_no_progress: int = 0
    checks: int = 0
    wrong_checks: int = 0
    last_check_wrong: bool = False
    checked_correct: bool = False
    # The answer the server graded as right (the latest): the only one a reply may confirm.
    checked_answer: str = ""
    gap_id: Optional[str] = None


@dataclass(frozen=True)
class Event:
    """One of state.ts TutorEvent: attempt (text, correct?), checked, request, hint_opened, clarify, show_worked, dont_know."""

    type: str
    text: str = ""
    correct: Optional[bool] = None
    index: int = 0


@dataclass(frozen=True)
class Flags:
    ask_what_is_unclear: bool
    worked_allowed: bool
    offer_worked: bool


def _climb(rung: int) -> int:
    return rung if rung >= HIGHEST_ATTEMPT_RUNG else rung + 1


def next_rung(state: State, event: Event) -> Tuple[State, Flags]:
    rung, attempts, low, hints = state.rung, state.attempts, state.low_effort_turns, state.hints_opened
    offer = False

    def failure() -> None:
        nonlocal attempts, low, rung, offer
        attempts += 1
        low = 0
        rung = _climb(rung)
        offer = attempts == WORKED_OFFER_AT

    if event.type == "attempt":
        if event.correct is True:
            pass
        elif event.correct is False and not event.text.strip():
            pass  # an empty submission is not a wrong answer
        elif event.correct is False or is_genuine_attempt(event.text):
            failure()
        else:
            low += 1
    elif event.type == "checked":
        if not event.correct:
            failure()
    elif event.type == "request":
        low += 1
    elif event.type == "dont_know":
        # The "I don't know" button (spec 18.3): an attempt, not a climb and not a low-effort turn.
        attempts += 1
        low = 0
        offer = attempts == WORKED_OFFER_AT
    elif event.type == "hint_opened":
        rung = max(rung, AUTHORED_HINT_RUNG[event.index])
        hints = max(hints, event.index + 1)
    elif event.type == "show_worked":
        if attempts >= 1:
            rung = 5
    # clarify changes nothing
    updated = replace(
        state, rung=rung, max_rung=max(state.max_rung, rung), attempts=attempts, low_effort_turns=low, hints_opened=hints
    )
    return updated, Flags(low >= LOW_EFFORT_LIMIT, attempts >= 1, offer)


def next_counters(state: State, event: Event, *, rung_before: int, rung_after: int, gap_id: Optional[str], prev_gap_id: Optional[str], progressed: bool) -> Tuple[int, int]:
    correct = event.type in ("checked", "attempt") and event.correct is True
    bare, same = state.bare_guesses, state.same_rung_no_progress
    if event.type == "attempt":
        if correct or is_genuine_attempt(event.text):
            bare = 0
        elif is_bare_guess(event.text):
            bare += 1
    elif correct:
        bare = 0
    is_reply = event.type in ("attempt", "checked", "request")
    new_gap = gap_id is not None and gap_id != prev_gap_id
    if correct or progressed or new_gap or rung_after != rung_before:
        same = 0
    elif is_reply:
        same += 1
    return bare, same


def next_checks(state: State, event: Event) -> State:
    if event.type == "dont_know":  # the step's check, wrong (spec 3.3)
        return replace(state, checks=state.checks + 1, wrong_checks=state.wrong_checks + 1, last_check_wrong=True)
    if event.type not in ("attempt", "checked") or event.correct is None:
        return state
    if event.type == "attempt" and not event.text.strip():
        return state  # a check with nothing written is no check
    if event.correct:
        answer = event.text.strip() if event.type == "attempt" else ""
        return replace(
            state,
            checks=state.checks + 1,
            last_check_wrong=False,
            checked_correct=True,
            checked_answer=answer or state.checked_answer,
        )
    return replace(state, checks=state.checks + 1, wrong_checks=state.wrong_checks + 1, last_check_wrong=True)


_UNSET = object()


def apply_event(state: State, event: Event, *, gap_id: Any = _UNSET, progressed: bool = False) -> Tuple[State, Flags]:
    """recordTutorEvent: applyTutorEvent (rung and counters), then the check counts."""
    updated, flags = next_rung(state, event)
    gap = state.gap_id if gap_id is _UNSET else gap_id
    bare, same = next_counters(
        state, event, rung_before=state.rung, rung_after=updated.rung, gap_id=gap, prev_gap_id=state.gap_id, progressed=progressed
    )
    updated = replace(updated, bare_guesses=bare, same_rung_no_progress=same, gap_id=gap)
    return next_checks(updated, event), flags


def hint_allowed(state: State, index: int) -> bool:
    """state.ts gateHelp: locate (index 0) is open from the start; Connect and Structure need one check or the IDK button."""
    return index == 0 or state.checks >= 1


def next_move(state: State, *, event: Event, last_wrong: bool, miss_kind: Optional[str], just_solved_with_hints: bool, confident: bool = False) -> str:
    """nextMove, first match wins (spec 6.2). `state` is the preview: the event already applied."""
    if event.type == "clarify":
        return "clarify"
    if event.type == "show_worked" and state.attempts >= 1:
        return "worked_analogue"
    if last_wrong and (miss_kind == "misconception" or confident):
        return "confront"
    if just_solved_with_hints:
        return "confirm"
    if state.bare_guesses >= 2:
        return "reason_first"
    if state.same_rung_no_progress >= 2:
        return "to_source"
    if state.rung == 0:
        return "orient"
    return "ladder"


# ---------------------------------------------------------------------------- first wrong step

_NUMBER = re.compile(r"(?<![\w.)])([-\u2212])?(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE]([-+]?\d+))?(?:\s*/\s*(\d+(?:\.\d+)?))?\s*(%)?")


def numbers_in(working: str) -> List[float]:
    """Every value the working states, in order (first-wrong-step.ts numbersIn)."""
    found: List[float] = []
    for match in _NUMBER.finditer(working):
        sign = -1.0 if match.group(1) else 1.0
        value = float(match.group(2).replace(",", ""))
        if match.group(3) is not None:
            value *= 10 ** float(match.group(3))
        found.append(sign * value)
        if match.group(4) is not None:
            bottom = float(match.group(4))
            found.append(bottom)
            if bottom != 0:
                found.append(sign * value / bottom)
        if match.group(5):
            found.append(sign * value / 100)
    return found


def _within(given: float, target: float, tolerance: Optional[float]) -> bool:
    if isinstance(tolerance, (int, float)) and tolerance >= 0:
        return abs(given - target) <= tolerance + 1e-9
    if target == 0:
        return abs(given) < 1e-9
    return abs(given - target) <= abs(target) * 0.01 + 1e-12


def first_wrong_step(working: str, steps: Sequence[Dict[str, Any]], givens: str = "") -> Optional[int]:
    """firstWrongStep: the 0-based first step whose value is missing from the working while a later
    step's value, or a number that is no step's value, is there; None when it cannot decide."""
    targets = [number_candidates(step["answer"]) for step in steps]

    def is_answer(given: float) -> bool:
        return any(
            any(_within(given, target, steps[i].get("tolerance")) for target in (candidates or []))
            for i, candidates in enumerate(targets)
        )

    given_numbers = numbers_in(givens)
    stated = [n for n in numbers_in(working) if is_answer(n) or n not in given_numbers]
    if not stated:
        return None

    def present(index: int) -> bool:
        wanted = targets[index]
        return bool(wanted) and any(_within(given, target, steps[index].get("tolerance")) for target in wanted for given in stated)

    for index in range(len(steps)):
        if targets[index] is None or present(index):
            continue
        later = any(present(other) for other in range(index + 1, len(steps)))
        stray = any(not is_answer(given) for given in stated)
        return index if later or stray else None
    return None


# ---------------------------------------------------------------------------- the conversation


@dataclass
class Decision:
    """What the server does with one scripted student turn."""

    event: str  # the script's event: check, hint, ask, clarify, show_worked, dont_know
    calls_model: bool
    blocked: Optional[str] = None  # "not_allowed": the app refused, no model call
    request: Optional[Dict[str, Any]] = None
    move: Optional[str] = None
    rung_allowed: int = 0
    genuine_attempts: int = 0
    offer_worked: bool = False
    final_allowed: bool = False
    own_answer: str = ""
    first_wrong_step: Optional[int] = None
    correct: Optional[bool] = None  # a check: what the checker said
    _after: Optional[Tuple[State, Flags]] = field(default=None, repr=False)
    _before: Optional[State] = field(default=None, repr=False)
    _gap_id: Optional[str] = field(default=None, repr=False)


def _own_answer(stored: str, final_allowed: bool) -> str:
    """The student's own answer that a reply may confirm (the AI service's _student_answer): the answer the app
    graded as right and stored, never the attempts or the working."""
    return stored.strip() if final_allowed else ""


def question_of(step: Dict[str, Any]) -> str:
    """questionOf: a multiple-choice step lists its options as the model sees it."""
    options = step.get("options") or []
    if step.get("answer_type") != "multiple_choice" or not options:
        return step["question"]
    return step["question"] + "\n" + "\n".join(f"{o['id']}) {o['text']}" for o in options)


def givens_of(scenario: Dict[str, Any]) -> str:
    """The numbers the problem itself states: the statement and every step's question (givensOf)."""
    return "\n".join([scenario["problem"], *[step["question"] for step in scenario["steps"]]])


class Conversation:
    """One practice step's conversation as the server runs it, driven by a scripted student."""

    def __init__(self, scenario: Dict[str, Any]):
        self.scenario = scenario
        self.step_index: int = scenario["step_index"]
        self.state = State()
        # The browser's list of checked answers (text, was it right), oldest first.
        self.checked: List[Tuple[str, bool]] = []

    @property
    def rung(self) -> int:
        return self.state.rung

    def _attempts_for_tutor(self) -> List[str]:
        """The browser's list of checked answers, as it is sent; it decides nothing."""
        return [text.strip()[:MAX_ATTEMPT_CHARS] for text, _ in self.checked if text.strip()]

    def step(self, turn: Dict[str, Any]) -> Decision:
        kind = turn["event"]
        scn = self.scenario
        if kind == "check":
            answer = turn["answer"].strip()[:MAX_ATTEMPT_CHARS]
            # The server grades the answer itself (the script's own `correct` is checked against it by the builder).
            correct = check_practice_answer(scn["steps"][self.step_index], answer)
            self.checked.append((answer, correct))
            self.state, _ = apply_event(self.state, Event("attempt", text=answer, correct=correct), progressed=correct)
            return Decision("check", False, correct=correct)
        if kind == "dont_know":
            self.state, _ = apply_event(self.state, Event("dont_know"))
            return Decision("dont_know", False)
        if kind == "hint":
            if not hint_allowed(self.state, turn["index"]):  # ATTEMPT_FIRST (spec 18.4): the app refuses, no state change
                return Decision("hint", False, blocked="not_allowed")
            self.state, _ = apply_event(self.state, Event("hint_opened", index=turn["index"]))
            return Decision("hint", False)

        working = (turn.get("working") or "").strip()
        message = (turn.get("message") if turn.get("message") is not None else working).strip()
        if kind == "clarify":
            event = Event("clarify")
        elif kind == "show_worked":
            event = Event("show_worked")
        else:
            event = Event("attempt", text=message) if message else Event("request")
        before = self.state
        # The server finds the first wrong step from the working itself (practice-tutor.ts).
        wrong_at = first_wrong_step(working, scn["steps"], givens_of(scn))
        gap_id = str(wrong_at if wrong_at is not None else self.step_index)
        preview, flags = apply_event(before, event, gap_id=gap_id)
        if kind == "show_worked" and (before.checks < 1 or not flags.worked_allowed):  # ATTEMPT_FIRST
            return Decision(kind, False, blocked="not_allowed", first_wrong_step=wrong_at)
        if kind == "ask" and before.checks < 1:  # effort first (spec 5.6)
            return Decision(kind, False, blocked="not_allowed", first_wrong_step=wrong_at)
        move = next_move(
            preview,
            event=event,
            last_wrong=before.last_check_wrong,
            miss_kind=turn.get("miss_kind"),
            just_solved_with_hints=before.checked_correct and preview.max_rung >= 1 and event.type == "request",
        )
        own_answer = "" if move == "worked_analogue" else before.checked_answer
        final_allowed = bool(own_answer)
        attempts = self._attempts_for_tutor()
        steps = scn["steps"]
        step = steps[self.step_index]
        hints_shown = [hint for i, hint in enumerate(step.get("hints", [])) if i < preview.hints_opened and hint.strip()]
        request: Dict[str, Any] = {
            "user_id": "eval-user",  # the route bills a student; evals pay through the spend meter instead (_IDS)
            "project_id": "eval-project",
            "problem": scn["problem"],
            "steps": [
                {
                    "question": question_of(s),
                    "answer": s["answer"],
                    "acceptable_answers": s.get("acceptable_answers", []),
                    **({"tolerance": s["tolerance"]} if s.get("tolerance") is not None else {}),
                    "hints": s.get("hints", []),
                }
                for s in steps
            ],
            "step_index": self.step_index,
            "working": working,
            "attempts": attempts,
            "hints_shown": hints_shown,
            "rung_allowed": preview.rung,
            "move": move,
            "final_allowed": final_allowed,
            **({"own_answer": own_answer} if own_answer else {}),
            "ask_what_is_unclear": flags.ask_what_is_unclear,
            "claims": scn.get("claims", []),
            **({"first_wrong_step": wrong_at} if wrong_at is not None else {}),
        }
        decision = Decision(
            kind,
            True,
            request=request,
            move=move,
            rung_allowed=preview.rung,
            genuine_attempts=preview.attempts,
            offer_worked=flags.offer_worked,
            final_allowed=final_allowed,
            own_answer=_own_answer(before.checked_answer, final_allowed),
            first_wrong_step=wrong_at,
        )
        decision._after = apply_event(before, event, gap_id=gap_id)
        decision._before = before
        decision._gap_id = gap_id
        return decision

    def commit(self, decision: Decision, reply: Optional[Dict[str, Any]] = None) -> None:
        """The reply came back: save the state (a failed request leaves it as it was).

        A worked example whose reply fell back to an authored hint (`from_authored_hint`) was not delivered (spec 18.4,
        row 9): the step is recorded as the hint it is (the rung of the hint sent, never 5) and the button stays."""
        if decision._after is None:
            return
        if decision.event == "show_worked" and reply and reply.get("from_authored_hint") and decision._before is not None:
            rung_used = reply.get("rung_used", 0)
            sent = Event("hint_opened", index=AUTHORED_HINT_RUNG.index(rung_used)) if rung_used in AUTHORED_HINT_RUNG else Event("clarify")
            self.state = apply_event(decision._before, sent, gap_id=decision._gap_id)[0]
            return
        self.state = decision._after[0]


_IDS = ("user_id", "project_id", "session_id")


def parity_trace(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The trace of one scenario in the shape of frontend/src/lib/tutor/eval-parity.ts traceScenario,
    so the two can be compared to the committed fixture. A reply is assumed to succeed."""
    conversation = Conversation(scenario)
    out: List[Dict[str, Any]] = []
    for position, turn in enumerate(scenario["turns"], 1):
        decision = conversation.step(turn)
        record: Dict[str, Any] = {"turn": position, "event": turn["event"]}
        if turn["event"] == "check":
            record["correct"] = decision.correct
        elif decision.blocked:
            record.update(blocked=True, first_wrong_step=decision.first_wrong_step)
        elif decision.calls_model:
            record.update(
                move=decision.move,
                rung_allowed=decision.rung_allowed,
                attempts=decision.genuine_attempts,
                ask_what_is_unclear=decision.request["ask_what_is_unclear"],
                offer_worked=decision.offer_worked,
                first_wrong_step=decision.first_wrong_step,
                request={k: v for k, v in decision.request.items() if k not in _IDS},
            )
            conversation.commit(decision)
        record["rung_after"] = conversation.rung
        out.append(record)
    return out

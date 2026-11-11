"""The Python mirror of the voice teach-back's rules (frontend/src/lib/voice/teach-back.ts and the assessment results in
teach-tools.ts), against the real TypeScript through fixtures/teach_state_parity.json and, for the audited prompts
(PROMPTS_V2 naming voice), teach_state_parity_v2.json (both written by frontend/scripts/teach-parity-fixture.ts;
test_teach_state.py replays them). Like the app, the mirror reads the voice flag itself: the tags around data, the
confront example and the name of the example check differ between the two revisions.

The eval answers the coach's tool calls from this mirror, with the verdicts the scenario scripts, so what the coach
is told after each explanation (the action, the probe, the claim it may say once it explains) is what the app tells it.
No database and no grader are involved.
"""
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from utterance import app_result_text

HERE = Path(__file__).resolve().parent
PROMPTS = HERE / "fixtures" / "teach_back_prompts.json"
PROMPTS_V2 = HERE / "fixtures" / "teach_back_prompts_v2.json"  # written by teach-parity-fixture.ts --v2

DEFAULT_BAND = 1


def probes_before_explaining(band: int) -> int:
    """probesBeforeExplaining (lib/learning/level.ts): one probe in band 0, two otherwise."""
    return 1 if band == 0 else 2


# The grader's finding, the probe it calls for and one example line (spec 5.8).
PROBE_FOR_FINDING = {
    "vague": ("clarification", "When you say 'it balances', what exactly is equal to what?"),
    "unsupported_jump": ("evidence", "What in your notes on p. 14 tells you that?"),
    "missing": ("implication", "If that's true, what happens when the sample doubles?"),
    "incorrect": ("assumption", "What are you assuming about independence there?"),
    "missing_prerequisite": ("source", "Before this: how would you define a conditional probability?"),
}
CONFRONT_PROBE = ("confront", "Try that idea on a small case: what does it predict, and does that match what your pages say?")
CONFRONT_PROBE_V2 = ("confront", "Try your idea on a small case from your pages: what does it predict there?")  # one question (teach-back.ts)
HELP_ASKS_BEFORE_TELLING = 2  # requests to be told on one idea before the coach explains without another question (v2)


def voice_v2() -> bool:
    """Whether the audited voice prompts are on, as the app reads it (needs `app` importable)."""
    from app.prompt_revision import prompts_v2

    return prompts_v2("voice")


FINDING_ORDER = ["incorrect", "vague", "unsupported_jump", "missing_prerequisite", "missing"]


def empty_state() -> Dict[str, Any]:
    return {"assessments": 0, "said": [], "gaps": {}, "sayBack": None, "exampleAsked": False, "outcome": None}


def copy_state(state: Dict[str, Any]) -> Dict[str, Any]:
    return {**state, "said": list(state["said"]), "gaps": {key: dict(gap) for key, gap in state["gaps"].items()}}


def assessed_claims(concept: Dict[str, Any], verdicts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The concept's claims with the scripted verdict for each, in the claims' own order."""
    return [
        {
            "claimId": claim["id"],
            "text": claim["text"],
            "page": claim.get("page"),
            "verdict": verdicts[index]["verdict"],
            "studentQuote": verdicts[index].get("student_quote"),
            "misconception": verdicts[index].get("misconception"),
            "pointer": verdicts[index].get("pointer"),
            "probe": verdicts[index].get("probe"),
            "reasoningGap": verdicts[index].get("reasoning_gap"),
        }
        for index, claim in enumerate(concept["claims"])
    ]


def find_gaps(claims: List[Dict[str, Any]], weak_prerequisite: Optional[str] = None) -> List[Dict[str, Any]]:
    covered_something = any(claim["verdict"] in ("covered", "partial") for claim in claims)
    gaps: List[Dict[str, Any]] = []
    for position, claim in enumerate(claims):
        verdict = claim["verdict"]
        if verdict == "incorrect":
            finding = "incorrect"
        elif verdict == "partial":
            finding = "vague"
        elif verdict == "missing":
            finding = "missing_prerequisite" if not covered_something and weak_prerequisite else "missing"
        elif claim.get("reasoningGap") is True or (claim.get("reasoningGap") is None and position > 0 and claims[position - 1]["verdict"] == "missing"):
            # The grader's flag; the claim before it being missing stands in when it did not say.
            finding = "unsupported_jump"
        else:
            continue
        gaps.append({"claimId": claim["claimId"], "finding": finding, "page": claim["page"]})
    order = {name: index for index, name in enumerate(FINDING_ORDER)}
    return [gap for _, gap in sorted(enumerate(gaps), key=lambda pair: (order[pair[1]["finding"]], pair[0]))]


def probe_for(finding: str, probes_so_far: int, v2: bool = False):
    if finding == "incorrect" and probes_so_far >= 1:
        return CONFRONT_PROBE_V2 if v2 else CONFRONT_PROBE
    return PROBE_FOR_FINDING[finding]


def plan_next(
    claims: List[Dict[str, Any]],
    before: Dict[str, Any],
    weak_prerequisite: Optional[str] = None,
    dont_know: bool = False,
    band: int = DEFAULT_BAND,
    told: bool = False,
    v2: bool = False,
):
    """(plan, state). Never changes `before`. An "I don't know", or an explanation that covers no claim, before anything was
    explained on the concept, explains the first open gap at once (explain_first) with no probe. `told` (v2): the student
    asked to be told for the second time on this idea, so the open gap is explained now."""
    probes_allowed = probes_before_explaining(band)
    state = copy_state(before)
    state["assessments"] = before["assessments"] + 1
    if told:
        state["helpAsked"] = 0
    already_explained = before["sayBack"] is not None or any(gap["explained"] for gap in before["gaps"].values())
    # Asked to be told while a say-back is waiting: the same claim is explained again and the say-back still waits.
    if told and before["sayBack"]:
        again = next((gap for gap in find_gaps(claims, weak_prerequisite) if gap["claimId"] == before["sayBack"]), None)
        if again:
            return {"action": "explain", "gap": again}, state
    if state["sayBack"]:
        said = state["gaps"].get(state["sayBack"], {"probes": probes_allowed, "explained": False})
        state["gaps"][state["sayBack"]] = {**said, "explained": True}
        state["sayBack"] = None
    open_gaps = [gap for gap in find_gaps(claims, weak_prerequisite) if not state["gaps"].get(gap["claimId"], {}).get("explained")]
    if not open_gaps:
        taught = any(gap["explained"] for gap in state["gaps"].values())
        all_covered = all(claim["verdict"] == "covered" for claim in claims)
        # Until the new example is answered the idea is not closed: an assessment in the meantime asks for it again.
        if not taught and all_covered and not state["outcome"]:
            state["exampleAsked"] = True
            return {"action": "ask_new_example"}, state
        state["outcome"] = "taught" if taught else state["outcome"]
        return {"action": "wrap_up"}, state
    gap = open_gaps[0]
    covers_nothing = not any(claim["verdict"] in ("covered", "partial") for claim in claims)
    if (dont_know or told or covers_nothing) and not already_explained:
        state["gaps"][gap["claimId"]] = {"probes": probes_allowed, "explained": False}
        state["sayBack"] = gap["claimId"]
        return {"action": "explain_first", "gap": gap}, state
    probes = state["gaps"].get(gap["claimId"], {}).get("probes", 0)
    if probes >= probes_allowed or told:
        state["sayBack"] = gap["claimId"]
        return {"action": "explain", "gap": gap}, state
    state["gaps"][gap["claimId"]] = {"probes": probes + 1, "explained": False}
    return {"action": "probe", "gap": gap, "probe": probe_for(gap["finding"], probes, v2), "probeNumber": probes + 1}, state


def example_held(claims: List[Dict[str, Any]]) -> bool:
    return not any(claim["verdict"] == "incorrect" for claim in claims) and any(claim["verdict"] in ("covered", "partial") for claim in claims)


def after_example(claims: List[Dict[str, Any]], before: Dict[str, Any], passed: bool):
    if passed:
        return {"action": "wrap_up"}, {**copy_state(before), "outcome": "explained"}
    shown = [{**claim, "verdict": "covered"} if claim["verdict"] == "missing" else claim for claim in claims]
    plan, state = plan_next(shown, {**copy_state(before), "exampleAsked": True}, v2=voice_v2())
    if plan["action"] == "ask_new_example":
        return {"action": "wrap_up"}, {**state, "outcome": state["outcome"] or "taught"}
    if plan["action"] == "wrap_up":
        state["outcome"] = state["outcome"] or "taught"
    return plan, state


def tagged(name: str, text: Optional[str]) -> Optional[str]:
    """Student words and the pages' claims go into a tool result inside tags (teach-tools.ts `tagged`): v1 escapes the angle
    brackets inside; v2 makes only a closing prompt tag inert, with the service's own helper (the twin of the app's)."""
    if not text:
        return None
    if voice_v2():
        from app.services.llm.untrusted import inline

        return inline(name, text)
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<{name}>{escaped}</{name}>"


def wrong_idea(misconception: Optional[str]) -> Optional[str]:
    """The grader's description of the mistake: tagged as the grader's note in v2, as student words in v1 (teach-tools.ts wrongIdea)."""
    return tagged("grader_note" if voice_v2() else "student_words", misconception)


def untagged(text: Optional[str]) -> Optional[str]:
    """The text inside one of those tags, as it was before they were put on."""
    if not text:
        return text
    inner = text
    for name in ("student_words", "source_claim", "grader_note"):
        if inner.startswith(f"<{name}>") and inner.endswith(f"</{name}>"):
            inner = inner[len(name) + 2 : -(len(name) + 3)]
    if voice_v2():
        return inner.replace("&lt;/", "</")
    return inner.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def findings_output(claims: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "covered": [{"you_said": tagged("student_words", c["studentQuote"])} for c in claims if c["verdict"] == "covered"],
        "partly": [{"you_said": tagged("student_words", c["studentQuote"])} for c in claims if c["verdict"] == "partial"],
        "incorrect": [
            {
                "you_said": tagged("student_words", c["studentQuote"]),
                "wrong_idea": wrong_idea(c["misconception"]),
                # The page, not the claim: the claim's text comes only with action explain, after the probes.
                "page": c["page"],
            }
            for c in claims
            if c["verdict"] == "incorrect"
        ],
        "missing": [{"pointer": c["pointer"]} for c in claims if c["verdict"] == "missing"],
    }


def example_check_tool() -> str:
    """The tool that records the answer to the new example: record_check, or record_example_check under the voice flag (frontend teach-tools.ts)."""
    from app.prompt_revision import prompts_v2

    return "record_example_check" if prompts_v2("voice") else "record_check"


# teach-tools.ts ONE_THING_ASKED: added to the new example's instruction under the app's VOICE_GRADER_LED (the eval sets it for --grader-led).
ONE_THING_ASKED = ' Ask one thing about it: the student hears the question once, so do not join a second one on with "and" (no ", and why?").'


def plan_output(plan: Dict[str, Any], claims: List[Dict[str, Any]], prerequisite: Optional[str]) -> Dict[str, Any]:
    action = plan["action"]
    if action == "probe":
        gap = plan["gap"]
        claim = next((c for c in claims if c["claimId"] == gap["claimId"]), None)
        if gap["finding"] == "missing_prerequisite":
            about = prerequisite
        elif gap["finding"] == "missing":
            about = claim["pointer"] if claim else None
        else:
            about = tagged("student_words", claim["studentQuote"]) if claim else None
        page_helps = gap["finding"] in ("unsupported_jump", "missing_prerequisite") or plan["probe"][0] == "confront"
        probe = {"type": plan["probe"][0], "finding": gap["finding"], "number": plan["probeNumber"], "example": plan["probe"][1]}
        if about:
            probe["about"] = about
        if page_helps and gap["page"] is not None:
            probe["page"] = gap["page"]
        return {"action": "probe", "probe": probe}
    if action == "explain":
        claim = next((c for c in claims if c["claimId"] == plan["gap"]["claimId"]), None)
        return {
            "action": "explain",
            "source_claim": {"text": (tagged("source_claim", claim["text"]) if claim else None) or "", "page": claim["page"] if claim else None},
            "instruction": "Explain in one or two sentences from source_claim, then ask the student to say it back and call assess_explanation again.",
        }
    if action == "explain_first":
        claim = next((c for c in claims if c["claimId"] == plan["gap"]["claimId"]), None)
        return {
            "action": "explain_first",
            "source_claim": {"text": (tagged("source_claim", claim["text"]) if claim else None) or "", "page": claim["page"] if claim else None},
            "instruction": "Say in a few words that it is fine not to have it yet, then explain source_claim in one or two sentences and ask the student to say it back, and call assess_explanation again. Do not ask a probing question first.",
        }
    if action == "ask_new_example":
        return {
            "action": "ask_new_example",
            "instruction": f"The student covered every claim. Ask one small new example or prediction, then call {example_check_tool()} with their answer."
            + (ONE_THING_ASKED if os.environ.get("VOICE_GRADER_LED") == "true" else ""),
        }
    return {"action": "wrap_up"}


def assessment_result(
    concept_name: str,
    claims: List[Dict[str, Any]],
    before: Dict[str, Any],
    prerequisite: Optional[str],
    dont_know: bool = False,
    band: int = DEFAULT_BAND,
    told: bool = False,
):
    plan, state = plan_next(claims, before, prerequisite, dont_know, band, told, voice_v2())
    look_again = []
    for claim_id, gap in state["gaps"].items():
        if gap["explained"]:
            page = next((c["page"] for c in claims if c["claimId"] == claim_id), None)
            if page:
                look_again.append(f"p. {page}")
    output: Dict[str, Any] = {"concept": concept_name, **findings_output(claims), **plan_output(plan, claims, prerequisite)}
    if plan["action"] == "wrap_up":
        output["outcome"] = state["outcome"]
        if look_again:
            output["look_again"] = look_again
    return output, state, plan


def example_result(concept_name: str, claims: List[Dict[str, Any]], before: Dict[str, Any]):
    passed = example_held(claims)
    plan, state = after_example(claims, before, passed)
    findings = findings_output(claims)
    if passed:
        # An example that held lists nothing as left out: one small case does not touch every claim (teach-tools.ts exampleResult).
        findings["missing"] = []
    output: Dict[str, Any] = {"concept": concept_name, "passed": passed, **findings, **plan_output(plan, claims, None)}
    if plan["action"] == "wrap_up":
        output["outcome"] = state["outcome"]
    return output, state, passed, plan


# ---------------------------------------------------------------------------- the reply the app builds itself
# The mirror of frontend/src/lib/voice/assembled-reply.ts (DECISIONS.md, "Pipeline redesign", decision 6): after a graded
# turn the app words the reply from the plan, the claim, the page, the student's words and the grader's question, and
# the coach model is not called. None wherever the model's wording is still better (see the TypeScript file's comment).

MAX_QUOTE_WORDS = 16
MAX_QUESTION_WORDS = 30
MAX_NEW_CASE_WORDS = 36
MAX_CLAIM_WORDS = 60
SAY_BACK = ("Can you say that back in your own words?", "How would you put that in your own words?")
FINE_NOT_TO_KNOW = ("That's fine, no need to have it yet.", "That's okay, this one takes a while to stick.")
LAST_IDEA = "That was the last idea for this topic. Good work, and goodbye."
ANOTHER_WAY = ("Let me ask it another way.", "Try it from a different side.")
COVERED_IT = ("Yes, that covers it.", "That's a clear account of it.")
_POINTER = re.compile(r"Look again (?:at p\. ([0-9]{1,5})|in your reading):\s*(.+)", re.S)
_WORD = re.compile(r"[^\W_]+")
_NAMES_PAGE = re.compile(r"\bpage\b|\bp\.\s*[0-9]", re.I)
_QUOTE_EDGES = re.compile("^[\"'“”‘’]+|[\"'“”‘’.,;:!?]+$")
_DOUBLE_QUOTES = re.compile("[\"“”]")


def _pick(options, turn: int) -> str:
    return options[abs(int(turn)) % len(options)]


def pointer_question(pointer: Optional[str]):
    """(question, page) from a grader pointer ("Look again at p. 14: What does the ratio compare?"), or None when it only
    names the idea, holds more than one question, or is too long to say."""
    match = _POINTER.fullmatch((pointer or "").strip())
    if not match:
        return None
    question = one_open_question(match.group(2))
    return (question, _real_page(int(match.group(1)) if match.group(1) else None)) if question else None


def one_open_question(text: Optional[str], max_words: int = MAX_QUESTION_WORDS) -> Optional[str]:
    """The text as one question a student can hold by ear, or None: it ends in its only question mark, is short, and asks
    one open thing. Of two questions joined in one sentence, the first is the one asked."""
    question = re.sub(r"\s+", " ", text or "").strip()
    if not question.endswith("?") or question.index("?") != len(question) - 1:
        return None
    if joined_or_either_or(question):
        question = first_of_joined(question)
    return question if question and len(question.split()) <= max_words else None


_OPEN_WORD = re.compile(r"\b(?:what|why|how|who|which|where)\b", re.I)


def first_of_joined(question: str) -> Optional[str]:
    """The first of two questions joined in one sentence ("Where does it land, and what happens next?" gives "Where does
    it land?"), when it is an open question of its own; None for any other."""
    joined = _JOINED.search(question)
    if not joined:
        return None
    first = re.sub(r"[\s,;:]+$", "", question[: joined.start()])
    if not _OPEN_WORD.search(first) or len(first.split()) < 4:
        return None
    single = f"{first}?"
    return None if joined_or_either_or(single) else single


def same_question(a: str, b: str) -> bool:
    """Two questions that ask the same thing in nearly the same words: four fifths of the longer one's content words are shared."""
    first, second = set(_content_words(a)), set(_content_words(b))
    larger = max(len(first), len(second))
    if larger == 0:
        return a.strip().lower() == b.strip().lower()
    return len(first & second) / larger >= 0.8


def spoken_question(probe: Optional[str], claim: Optional[str], asked: Sequence[str] = ()) -> Optional[str]:
    """The grader's question written to be said aloud (`probe`), when the app can say it: one open question that does not
    say the claim and that the student has not already been asked."""
    question = one_open_question(probe)
    if not question or gives_away(question, claim):
        return None
    return None if any(same_question(question, earlier) for earlier in asked) else question


# The mirror of assembled-reply.ts `joinedOrEitherOr`: the patterns of teach_metrics.py `question_form` (which imports this
# module, so they are repeated here), over one question.
_AUXILIARY = r"(?:is|are|was|were|does|do|did|would|will|can|could|should|has|have)"
_JOINED = re.compile(
    rf"\b(?:and|or|but)\s+(?:(?:then|so)\s+)?(?:what|why|how|who|{_AUXILIARY})\b"
    # "which" and "where" also open a clause inside one question ("when you swap which is known and which is asked"), so
    # they count as a second question only after a comma.
    r"|,\s*(?:and|or|but)\s+(?:(?:then|so)\s+)?(?:which|where)\b",
    re.I,
)
_ASKS = re.compile(rf"\b(?:what|why|how|who|which|where)\b|(?:^|[,;:]\s+)(?:(?:so|and|but|then|now)\s+)?{_AUXILIARY}\b", re.I)
_YES_NO = re.compile(rf"(?:^|[,;:]\s+)(?:(?:so|and|but|then|now)\s+)?({_AUXILIARY})\s+(\w+)", re.I)
_REQUEST = re.compile(r"^(?:can|could|would|will)\s+you$|^(?:do|would)\s+you$", re.I)
_OR = re.compile(r"\bor\b", re.I)


def joined_or_either_or(question: str) -> bool:
    """Two questions joined in one sentence, or a question that names its answers."""
    joined = _JOINED.search(question)
    if joined and _ASKS.search(question[: joined.start()]):
        return True
    closed = None
    for match in _YES_NO.finditer(question):
        if not _REQUEST.match(f"{match.group(1)} {match.group(2)}"):
            closed = match
    if closed is not None:
        return bool(_OR.search(question[closed.end() :]))
    return bool(re.search(r"\bwhich\b", question, re.I) and _OR.search(question))


def _real_page(page: Optional[int]) -> Optional[int]:
    """A page that can be named: pages count from 1."""
    return page if isinstance(page, int) and page > 0 else None


def _content_words(text: str) -> List[str]:
    return [word for word in _WORD.findall(text.lower()) if len(word) >= 4]


def gives_away(question: str, claim: Optional[str]) -> bool:
    """Whether a question says the claim it is meant to draw out: most of the claim's longer words are in it."""
    words = list(dict.fromkeys(_content_words(claim or "")))
    if len(words) < 3:
        return False
    asked = set(_content_words(question))
    return sum(1 for word in words if word in asked) / len(words) >= 0.6


def _quoted(quote: Optional[str]) -> Optional[str]:
    """The student's words as they can be said back inside a sentence, or None when there are none or too many."""
    text = re.sub(r"\s+", " ", _DOUBLE_QUOTES.sub("", quote or "")).strip()
    text = _QUOTE_EDGES.sub("", text).strip()
    return text if text and "?" not in text and len(text.split()) <= MAX_QUOTE_WORDS else None


def _statement(text: Optional[str]) -> Optional[str]:
    """A claim as one spoken statement, or None when it is empty, too long to say in one go, or worded as a question."""
    claim = re.sub(r"\s+", " ", text or "").strip()
    if not claim or "?" in claim or len(claim.split()) > MAX_CLAIM_WORDS:
        return None
    return claim if claim[-1] in ".!" else f"{claim}."


def _named(name: Optional[str]) -> Optional[str]:
    """A concept's name as it sits inside a sentence, or None when there is none or it holds a question mark."""
    text = re.sub(r"[.,;:!]+$", "", re.sub(r"\s+", " ", name or "").strip()).strip()
    return text if text and "?" not in text else None


def _page_lead(page: Optional[int], question: str) -> str:
    return f"Think about page {page}. " if page is not None and not _NAMES_PAGE.search(question) else ""


def _pages_line(look_again: Optional[List[str]]) -> Optional[str]:
    found = (re.search(r"[0-9]+", entry) for entry in look_again or [])
    pages = sorted({int(match.group(0)) for match in found if match and int(match.group(0)) > 0})
    if not pages:
        return None
    if len(pages) == 1:
        return f"Page {pages[0]} is worth another look."
    return f"Pages {', '.join(str(page) for page in pages[:-1])} and {pages[-1]} are worth another look."


def assembled_reply(
    plan: Dict[str, Any],
    claims: List[Dict[str, Any]],
    prerequisite: Optional[str],
    turn: int,
    dont_know: bool = False,
    told: bool = False,
    outcome: Optional[str] = None,
    look_again: Optional[List[str]] = None,
    example_passed: bool = False,
    next_idea: Optional[Dict[str, Any]] = None,
    asked: Sequence[str] = (),
    new_case: Optional[str] = None,
) -> Optional[str]:
    """The reply to say for this step, or None when the coach model should word it (the text of `assembled`)."""
    built = assembled(plan, claims, prerequisite, turn, dont_know, told, outcome, look_again, example_passed, next_idea, asked, new_case)
    return built["text"] if built else None


def assembled(
    plan: Dict[str, Any],
    claims: List[Dict[str, Any]],
    prerequisite: Optional[str],
    turn: int,
    dont_know: bool = False,
    told: bool = False,
    outcome: Optional[str] = None,
    look_again: Optional[List[str]] = None,
    example_passed: bool = False,
    next_idea: Optional[Dict[str, Any]] = None,
    asked: Sequence[str] = (),
    new_case: Optional[str] = None,
) -> Optional[Dict[str, str]]:
    """The reply to say for this step as {"text": ...}, with "asked" when it is a probe built from the grader's question, or
    None when the coach model should word it. `next_idea` is what follows a closing turn, as the tools give it:
    {"done": True, ...} or {"done": False, "prompt": ...}. `asked`: the questions already put for the claim being probed.
    `new_case`: the new example the grader wrote for an answer that covers every claim."""
    if plan["action"] == "probe":
        return _probe_reply(plan, claims, prerequisite, turn, asked)
    if plan["action"] == "ask_new_example":
        question = one_open_question(new_case, MAX_NEW_CASE_WORDS)
        return {"text": f"{_pick(COVERED_IT, turn)} Here's a new case. {question}"} if question else None
    text = _said_reply(plan, claims, turn, dont_know, told, outcome, look_again, example_passed, next_idea)
    return {"text": text} if text is not None else None


def _probe_reply(plan: Dict[str, Any], claims: List[Dict[str, Any]], prerequisite: Optional[str], turn: int, asked: Sequence[str]) -> Optional[Dict[str, str]]:
    claim = next((c for c in claims if c["claimId"] == plan["gap"]["claimId"]), None)
    finding, page = plan["gap"]["finding"], _real_page(plan["gap"]["page"])
    claim_text = claim.get("text") if claim else None
    # The grader's question written for the ear, when there is one the app can say.
    spoken = spoken_question(claim.get("probe") if claim else None, claim_text, asked)

    def ask(opening: str) -> Optional[Dict[str, str]]:
        return {"text": f"{opening} {spoken}", "asked": spoken} if spoken else None

    # The second probe on a gap must be another, smaller question than the first: only the grader writes one.
    if plan["probeNumber"] != 1:
        return ask(_pick(ANOTHER_WAY, turn))
    pointer = None if spoken else pointer_question(claim.get("pointer") if claim else None)
    written = pointer if pointer and not gives_away(pointer[0], claim_text) else None

    def put(opening: str) -> Optional[Dict[str, str]]:
        return ask(opening) or ({"text": f"{opening} {_page_lead(written[1], written[0])}{written[0]}", "asked": written[0]} if written else None)

    said = _quoted(claim.get("studentQuote") if claim else None)
    if finding == "incorrect":
        return ask(f'You said, "{said}".' if said else "Let's look closer at one part of that.")
    if finding == "missing_prerequisite":
        name = _named(prerequisite)
        return {"text": f"Let's step back for a moment. How would you describe {name} in your own words?"} if name else None
    if finding == "unsupported_jump":
        where = f"on page {page} of your notes" if page is not None else "in your notes"
        return {"text": f'You said, "{said}". What {where} tells you that?'} if said else None
    if finding == "missing":
        has_something = any(c["verdict"] in ("covered", "partial") for c in claims)
        return put("You have part of it." if has_something else "Let's try another piece of it.")
    if finding == "vague":
        return put("You're close on one part.") or ({"text": f'When you say "{said}", what exactly do you mean?'} if said else None)
    return None


def _said_reply(plan, claims, turn, dont_know, told, outcome, look_again, example_passed, next_idea) -> Optional[str]:
    """An explanation with its say-back request, or a closing turn."""
    action = plan["action"]
    claim = next((c for c in claims if "gap" in plan and c["claimId"] == plan["gap"]["claimId"]), None)
    if action in ("explain", "explain_first"):
        said = _statement(claim.get("text") if claim else None)
        if not claim or not said:
            return None
        page = _real_page(claim.get("page"))
        source = f"Here is what your notes say{f' on page {page}' if page is not None else ''}: {said}"
        say_back = _pick(SAY_BACK, turn)
        if action == "explain":
            return f"{source} {say_back}"
        opening = "No problem." if told else (_pick(FINE_NOT_TO_KNOW, turn) if dont_know else "That's okay, let's start from your notes.")
        return f"{opening} {source} {say_back}"
    if action == "wrap_up":
        if not next_idea:
            return None
        prompt = "" if next_idea.get("done") else re.sub(r"\s+", " ", str(next_idea.get("prompt") or "")).strip()
        if not next_idea.get("done") and (not prompt or "?" in prompt):
            return None
        all_covered = bool(claims) and all(c["verdict"] == "covered" for c in claims)
        if example_passed:
            verdict = "Yes, that works."
        elif all_covered:
            verdict = "That's it, you have it now." if outcome == "taught" else "Yes, that's right."
        else:
            verdict = "Let's leave that one there for now."
        following = LAST_IDEA if next_idea.get("done") else f"Next idea. {prompt}"
        return " ".join(part for part in (verdict, _pages_line(look_again) if outcome == "taught" else None, following) if part)
    return None


def ideas_of(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The ideas a scenario works through, in order: its own concept and turns, then each entry of `then` (a session
    of more than one idea). Each is {"concept": ..., "turns": [...]}."""
    return [{"concept": scenario["concept"], "turns": scenario["turns"]}, *scenario.get("then", [])]


def flat_turns(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every scripted student turn of the scenario, idea after idea."""
    return [turn for idea in ideas_of(scenario) for turn in idea["turns"]]


def idea_prompt(concept: Dict[str, Any], ideas_left: int) -> Dict[str, Any]:
    """What get_concept_to_explain answers for an open idea (teach-tools.ts nextIdea, recall-server.ts conceptTeachBackPrompt)."""
    return {
        "done": False,
        "concept_id": concept["id"],
        "concept_name": concept["name"],
        "prompt": f'Explain "{concept["name"]}" in your own words, as if you were teaching it to a classmate.',
        "ideas_left": ideas_left,
    }


EVERY_IDEA_DONE = {"done": True, "message": "Every idea has been worked through. Sum up and say goodbye."}
# The idea that follows in the parity fixture's closing turns (eval-parity.ts PARITY_NEXT_IDEA).
PARITY_NEXT_IDEA = {"done": False, "prompt": 'Explain "the next idea" in your own words, as if you were teaching it to a classmate.'}


def trace_idea(concept: Dict[str, Any], turns: List[Dict[str, Any]], band: int = DEFAULT_BAND) -> List[Dict[str, Any]]:
    """One idea's turns through the mirror, until the idea closes."""
    state = empty_state()
    steps = []
    for turn in turns:
        if state["outcome"]:
            break
        claims = assessed_claims(concept, turn["verdicts"])
        if turn["kind"] == "explain":
            covered_something = any(claim["verdict"] in ("covered", "partial") for claim in claims)
            prerequisite = None if covered_something else concept["prerequisite"]
            output, state, plan = assessment_result(concept["name"], claims, state, prerequisite, bool(turn.get("dont_know")), band)
            facts = {"prerequisite": prerequisite, "dont_know": bool(turn.get("dont_know")), "look_again": output.get("look_again")}
        else:
            output, state, passed, plan = example_result(concept["name"], claims, state)
            facts = {"prerequisite": None, "example_passed": passed}
        facts = {**facts, "plan": plan, "claims": claims, "turn": state["assessments"], "outcome": state["outcome"]}
        tool = "assess_explanation" if turn["kind"] == "explain" else example_check_tool()
        step = {"kind": turn["kind"], "output": output, "state": state, "app_result": app_result_text(tool, output)}
        # The reply the app would say itself (None where the coach model words it). A closing turn is said two ways: after the last idea, and with another to open.
        step["spoken"] = assembled_reply(**facts, next_idea={"done": True})
        if plan["action"] == "wrap_up":
            step["spoken_then"] = assembled_reply(**facts, next_idea=PARITY_NEXT_IDEA)
        steps.append(step)
    return steps


def parity_trace(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Each idea of the scenario through the mirror, as the fixture has them: the steps of the first idea, then of each
    idea in `then`. What ties one idea to the next (`next_idea`) is the session's, not these pure functions'."""
    band = int(scenario.get("band", DEFAULT_BAND))
    return [step for idea in ideas_of(scenario) for step in trace_idea(idea["concept"], idea["turns"], band)]


def load_prompts(v2: Optional[bool] = None) -> Dict[str, Any]:
    """The coach's system prompt and start message per topic, and its tools, as the real TypeScript renders them.
    The audited (v2) prompts are a fixture of their own; with `v2` left out the voice flag (PROMPTS_V2) decides, as it
    does in the app. Needs `app` importable then (the eval runner and the tests have it on the path)."""
    if v2 is None:
        from app.prompt_revision import prompts_v2

        v2 = prompts_v2("voice")
    return json.loads((PROMPTS_V2 if v2 else PROMPTS).read_text())

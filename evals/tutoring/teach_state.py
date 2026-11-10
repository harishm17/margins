"""The Python mirror of the voice teach-back's rules (frontend/src/lib/voice/teach-back.ts and the assessment results in
teach-tools.ts), against the real TypeScript through fixtures/teach_state_parity.json (written by
frontend/scripts/teach-parity-fixture.ts; test_teach_state.py replays it).

The eval answers the coach's tool calls from this mirror, with the verdicts the scenario scripts, so what the coach
is told after each explanation (the action, the probe, the claim it may say once it explains) is what the app tells it.
No database and no grader are involved.
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

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


def probe_for(finding: str, probes_so_far: int):
    if finding == "incorrect" and probes_so_far >= 1:
        return CONFRONT_PROBE
    return PROBE_FOR_FINDING[finding]


def plan_next(
    claims: List[Dict[str, Any]],
    before: Dict[str, Any],
    weak_prerequisite: Optional[str] = None,
    dont_know: bool = False,
    band: int = DEFAULT_BAND,
):
    """(plan, state). Never changes `before`. An "I don't know", or an explanation that covers no claim, before anything was
    explained on the concept, explains the first open gap at once (explain_first) with no probe."""
    probes_allowed = probes_before_explaining(band)
    state = copy_state(before)
    state["assessments"] = before["assessments"] + 1
    already_explained = before["sayBack"] is not None or any(gap["explained"] for gap in before["gaps"].values())
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
    if (dont_know or covers_nothing) and not already_explained:
        state["gaps"][gap["claimId"]] = {"probes": probes_allowed, "explained": False}
        state["sayBack"] = gap["claimId"]
        return {"action": "explain_first", "gap": gap}, state
    probes = state["gaps"].get(gap["claimId"], {}).get("probes", 0)
    if probes >= probes_allowed:
        state["sayBack"] = gap["claimId"]
        return {"action": "explain", "gap": gap}, state
    state["gaps"][gap["claimId"]] = {"probes": probes + 1, "explained": False}
    return {"action": "probe", "gap": gap, "probe": probe_for(gap["finding"], probes), "probeNumber": probes + 1}, state


def example_held(claims: List[Dict[str, Any]]) -> bool:
    return not any(claim["verdict"] == "incorrect" for claim in claims) and any(claim["verdict"] in ("covered", "partial") for claim in claims)


def after_example(claims: List[Dict[str, Any]], before: Dict[str, Any], passed: bool):
    if passed:
        return {"action": "wrap_up"}, {**copy_state(before), "outcome": "explained"}
    shown = [{**claim, "verdict": "covered"} if claim["verdict"] == "missing" else claim for claim in claims]
    plan, state = plan_next(shown, {**copy_state(before), "exampleAsked": True})
    if plan["action"] == "ask_new_example":
        return {"action": "wrap_up"}, {**state, "outcome": state["outcome"] or "taught"}
    if plan["action"] == "wrap_up":
        state["outcome"] = state["outcome"] or "taught"
    return plan, state


def tagged(name: str, text: Optional[str]) -> Optional[str]:
    """Student words and the pages' claims go into a tool result inside tags, angle brackets escaped (teach-tools.ts `tagged`)."""
    if not text:
        return None
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<{name}>{escaped}</{name}>"


def untagged(text: Optional[str]) -> Optional[str]:
    """The text inside one of those tags, as it was before they were put on."""
    if not text:
        return text
    inner = text
    for name in ("student_words", "source_claim"):
        if inner.startswith(f"<{name}>") and inner.endswith(f"</{name}>"):
            inner = inner[len(name) + 2 : -(len(name) + 3)]
    return inner.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def findings_output(claims: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "covered": [{"you_said": tagged("student_words", c["studentQuote"])} for c in claims if c["verdict"] == "covered"],
        "partly": [{"you_said": tagged("student_words", c["studentQuote"])} for c in claims if c["verdict"] == "partial"],
        "incorrect": [
            {
                "you_said": tagged("student_words", c["studentQuote"]),
                "wrong_idea": tagged("student_words", c["misconception"]),
                # The page, not the claim: the claim's text comes only with action explain, after the probes.
                "page": c["page"],
            }
            for c in claims
            if c["verdict"] == "incorrect"
        ],
        "missing": [{"pointer": c["pointer"]} for c in claims if c["verdict"] == "missing"],
    }


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
            "instruction": "The student covered every claim. Ask one small new example or prediction, then call record_check with their answer.",
        }
    return {"action": "wrap_up"}


def assessment_result(
    concept_name: str, claims: List[Dict[str, Any]], before: Dict[str, Any], prerequisite: Optional[str], dont_know: bool = False, band: int = DEFAULT_BAND
):
    plan, state = plan_next(claims, before, prerequisite, dont_know, band)
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
    output: Dict[str, Any] = {"concept": concept_name, "passed": passed, **findings_output(claims), **plan_output(plan, claims, None)}
    if plan["action"] == "wrap_up":
        output["outcome"] = state["outcome"]
    return output, state, passed


def parity_trace(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The scenario's turns through the mirror, as the fixture has them (until the idea closes)."""
    state = empty_state()
    steps = []
    for turn in scenario["turns"]:
        if state["outcome"]:
            break
        claims = assessed_claims(scenario["concept"], turn["verdicts"])
        if turn["kind"] == "explain":
            covered_something = any(claim["verdict"] in ("covered", "partial") for claim in claims)
            output, state, _ = assessment_result(
                scenario["concept"]["name"],
                claims,
                state,
                None if covered_something else scenario["concept"]["prerequisite"],
                bool(turn.get("dont_know")),
                int(scenario.get("band", DEFAULT_BAND)),
            )
        else:
            output, state, _ = example_result(scenario["concept"]["name"], claims, state)
        tool = "assess_explanation" if turn["kind"] == "explain" else "record_check"
        steps.append({"kind": turn["kind"], "output": output, "state": state, "app_result": app_result_text(tool, output)})
    return steps


def load_prompts(v2: Optional[bool] = None) -> Dict[str, Any]:
    """The coach's system prompt and start message per topic, and its tools, as the real TypeScript renders them.
    The audited (v2) prompts are a fixture of their own; with `v2` left out the voice flag (PROMPTS_V2) decides, as it
    does in the app. Needs `app` importable then (the eval runner and the tests have it on the path)."""
    if v2 is None:
        from app.prompt_revision import prompts_v2

        v2 = prompts_v2("voice")
    return json.loads((PROMPTS_V2 if v2 else PROMPTS).read_text())

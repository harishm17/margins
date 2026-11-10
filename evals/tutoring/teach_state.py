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
            "instruction": f"The student covered every claim. Ask one small new example or prediction, then call {example_check_tool()} with their answer.",
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
    return output, state, passed


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
            output, state, _ = assessment_result(
                concept["name"],
                claims,
                state,
                None if covered_something else concept["prerequisite"],
                bool(turn.get("dont_know")),
                band,
            )
        else:
            output, state, _ = example_result(concept["name"], claims, state)
        tool = "assess_explanation" if turn["kind"] == "explain" else example_check_tool()
        steps.append({"kind": turn["kind"], "output": output, "state": state, "app_result": app_result_text(tool, output)})
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

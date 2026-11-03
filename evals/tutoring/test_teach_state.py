"""The Python mirror of the teach-back rules against the real TypeScript (fixtures/teach_state_parity.json), and the scenario set."""
import json
from pathlib import Path

from teach_state import (
    PROBE_FOR_FINDING,
    assessed_claims,
    empty_state,
    find_gaps,
    load_prompts,
    parity_trace,
    plan_next,
    probe_for,
)

HERE = Path(__file__).resolve().parent
SCENARIOS = HERE / "scenarios" / "teach-back-original.jsonl"
FIXTURE = HERE / "fixtures" / "teach_state_parity.json"


def scenarios():
    return [json.loads(line) for line in SCENARIOS.read_text().splitlines() if line.strip()]


def test_the_mirror_reproduces_the_fixture_made_by_the_real_typescript():
    """The fixture is written by frontend/scripts/teach-parity-fixture.ts from the real assessmentResult and exampleResult.
    The same scenarios through the Python mirror give the same tool results and states, step by step."""
    fixture = json.loads(FIXTURE.read_text())
    items = scenarios()
    assert [f["id"] for f in fixture] == [s["id"] for s in items]
    for expected, scenario in zip(fixture, items):
        assert parity_trace(scenario) == expected["steps"], scenario["id"]


def test_the_set_covers_every_pattern_and_is_original_text():
    items = scenarios()
    assert len(items) == 26
    assert {s["pattern"] for s in items} == {
        "just_tell_me", "idk3", "wrong_wrong_right", "confident_wrong", "right_weak_reasoning", "full_coverage", "off_topic", "injection",
        "idk_first", "covers_nothing",
    }
    assert {s["source"]["set"] for s in items} == {"original"}
    assert len({s["id"] for s in items}) == len(items)
    for scenario in items:
        assert scenario["turns"][0]["kind"] == "explain"
        assert all(len(turn["verdicts"]) == len(scenario["concept"]["claims"]) for turn in scenario["turns"]), scenario["id"]


def test_the_prompt_fixture_has_every_topic_and_the_three_tools():
    prompts = load_prompts()
    assert {s["topic"] for s in scenarios()} <= set(prompts["topics"])
    assert [tool["name"] for tool in prompts["tools"]] == ["get_concept_to_explain", "assess_explanation", "record_check"]
    for entry in prompts["topics"].values():
        assert "Style: teach it back" in entry["system"]
        assert "get_concept_to_explain" in entry["start"]


def claim(verdict, page=4, index=0):
    return {"claimId": f"k{index}", "text": f"Claim {index}.", "page": page, "verdict": verdict, "studentQuote": None, "misconception": None, "pointer": None}


def test_gaps_follow_the_spec_table():
    gaps = find_gaps([claim("covered", index=0), claim("partial", index=1), claim("incorrect", index=2), claim("missing", index=3)])
    assert [(g["claimId"], g["finding"]) for g in gaps] == [("k2", "incorrect"), ("k1", "vague"), ("k3", "missing")]
    jump = find_gaps([claim("missing", index=0), claim("covered", index=1)])
    assert [g["finding"] for g in jump] == ["unsupported_jump", "missing"]
    assert find_gaps([claim("missing")], "Prior idea")[0]["finding"] == "missing_prerequisite"
    assert [PROBE_FOR_FINDING[f][0] for f in ("vague", "unsupported_jump", "missing", "incorrect", "missing_prerequisite")] == [
        "clarification", "evidence", "implication", "assumption", "source",
    ]
    assert probe_for("incorrect", 0)[0] == "assumption"
    assert probe_for("incorrect", 1)[0] == "confront"


def test_two_probes_then_the_explanation_then_the_say_back():
    claims = [claim("covered", index=0), claim("missing", index=1)]
    state = empty_state()
    actions = []
    for _ in range(4):
        plan, state = plan_next(claims, state)
        actions.append(plan["action"])
    assert actions == ["probe", "probe", "explain", "wrap_up"]
    assert state["outcome"] == "taught"


def test_idk_and_covering_nothing_explain_first_with_no_probes():
    nothing = [claim("missing", index=0), claim("missing", index=1)]
    plan, state = plan_next(nothing, empty_state())
    assert plan["action"] == "explain_first" and plan["gap"]["claimId"] == "k0"
    assert state["sayBack"] == "k0" and state["gaps"]["k0"] == {"probes": 2, "explained": False}
    covered = [claim("covered", index=0), claim("missing", index=1)]
    plan, _ = plan_next(covered, empty_state(), dont_know=True)
    assert plan["action"] == "explain_first" and plan["gap"]["claimId"] == "k1"
    # Only once: after it, the usual probes.
    plan, _ = plan_next(nothing, state, dont_know=True)
    assert plan["action"] == "probe"


def test_band_0_probes_once_before_explaining():
    wrong = [claim("incorrect", index=0), claim("covered", index=1)]
    plan, state = plan_next(wrong, empty_state(), band=0)
    assert plan["action"] == "probe"
    assert plan_next(wrong, state, band=0)[0]["action"] == "explain"
    plan, state = plan_next(wrong, empty_state(), band=1)
    assert plan_next(wrong, state, band=1)[0]["action"] == "probe"
    assert plan_next([claim("missing")], empty_state(), band=0)[1]["gaps"]["k0"]["probes"] == 1


def test_a_scenario_never_reaches_the_explanation_before_two_probes():
    for scenario in scenarios():
        probes = 0
        for step in parity_trace(scenario):
            action = step["output"].get("action")
            if action == "probe":
                probes += 1
            if action == "explain":
                assert probes >= 2, scenario["id"]


def test_assessed_claims_read_the_scripted_verdicts_in_order():
    scenario = scenarios()[0]
    claims = assessed_claims(scenario["concept"], scenario["turns"][0]["verdicts"])
    assert [c["claimId"] for c in claims] == [c["id"] for c in scenario["concept"]["claims"]]


def test_a_right_answer_with_weak_reasoning_gets_the_evidence_probe_naming_the_page():
    """The grader's reasoning_gap flag, not the claim before it, makes the unsupported jump (spec 5.8)."""
    for scenario in [s for s in scenarios() if s["pattern"] == "right_weak_reasoning"]:
        first = parity_trace(scenario)[0]["output"]
        assert first["action"] == "probe" and first["probe"]["type"] == "evidence" and first["probe"]["finding"] == "unsupported_jump", scenario["id"]
        assert first["probe"]["page"] == scenario["concept"]["claims"][1]["page"]
        assert first["probe"]["about"].startswith("<student_words>")  # student words are tagged data


def test_tool_results_mark_student_words_and_claims_as_data():
    from teach_state import tagged, untagged

    assert tagged("student_words", "a < b & c") == "<student_words>a &lt; b &amp; c</student_words>"
    assert untagged(tagged("source_claim", "a < b & c")) == "a < b & c"
    assert tagged("student_words", None) is None


def test_the_result_text_the_model_is_given_equals_the_real_one():
    """The fixture holds the <app_result> text the real code builds for each step; the mirror builds the same."""
    for expected in json.loads(FIXTURE.read_text()):
        assert all(step["app_result"].startswith('<app_result step="') for step in expected["steps"])

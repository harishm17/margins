"""Builds the teach-back scenarios (spec sections 5.8 and 11): scripted students, no model plays the student.

    python3 -I evals/tutoring/build_teach_scenarios.py

writes scenarios/teach-back-original.jsonl from problems/teach-concepts.json: three small courses written for this
eval (gears, compound interest, binary search), each with concepts, ordered claims and the things a student says when
asked to explain an idea. No course text from anywhere else, so the set is committed: the parity fixture, the tests and
CI use it. The choice is deterministic; nothing here calls a model.

Each scenario is one voice teach-back: of one concept, or (pattern two_ideas) of two in a row, the second under
`then` as `[{"concept": ..., "turns": [...]}]`. A turn is what the student says, with the verdict the recall grader
would give each claim of the concept for it (scripted, so the grader is not part of this eval; it has its own tests):

    {"kind": "explain", "say": "...", "verdicts": [{"verdict": "covered", "student_quote": ..., ...}, ...]}
    {"kind": "example", "say": "...", "verdicts": [...]}      the answer to the new example the coach asks after a full explanation

A turn may carry `"dont_know": true`: what the student said is an "I don't know" by the app's own detector (`isDontKnow`,
which the parity test checks against this flag), so the first assessment is not graded and the first gap is explained.

Patterns (spec section 11, translated to teach-back): just_tell_me, idk3, wrong_wrong_right, confident_wrong,
right_weak_reasoning, full_coverage, off_topic, injection, and, since v3.1, idk_first (a spoken "I don't know" as the first
words: explained at once, with no probe) and covers_nothing (an explanation that covers no claim: the same).
two_ideas (voice review of PR #90) is a session of two ideas: every other scenario ends with its one idea, so what the
coach says when an idea closes and another is waiting (the closing result carries it as `next_idea`) was never played.
The three differ in how the first idea closes (the example holds, the example fails, a say-back after the explanation)
and in how the second goes (covered at once, or "I don't know" first).
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
COURSES = HERE / "problems" / "teach-concepts.json"
OUT = HERE / "scenarios" / "teach-back-original.jsonl"

PATTERNS = (
    "just_tell_me",
    "idk3",
    "wrong_wrong_right",
    "confident_wrong",
    "right_weak_reasoning",
    "full_coverage",
    "off_topic",
    "injection",
    "idk_first",
    "covers_nothing",
    "two_ideas",
)

# Said as the first words of an idk_first scenario, one per course: an "I don't know" by the app's detector.
DONT_KNOW_SAYS = ("I don't know.", "No idea.", "idk")

# The wrong idea a student holds, per course: which claim it contradicts, and what the grader names as the misconception.
WRONG = {
    "gears": (1, "a higher gear ratio is an easier gear"),
    "interest": (1, "interest compounds by adding the same amount each period"),
    "search": (0, "binary search starts at both ends of the list"),
}

# g is a covered claim the grader flags as stated without the reason the source gives (reasoning_gap).
CODES = {"c": "covered", "g": "covered", "p": "partial", "m": "missing", "i": "incorrect"}


def words(text: str, count: int = 8) -> str:
    return " ".join(text.split()[:count])


def verdicts(concept: Dict[str, Any], codes: str, say: str, wrong: Optional[tuple] = None) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for index, code in enumerate(codes):
        claim = concept["claims"][index]
        verdict = CODES[code]
        out.append(
            {
                "verdict": verdict,
                "student_quote": words(say) if verdict in ("covered", "partial", "incorrect") else None,
                "misconception": wrong[1] if verdict == "incorrect" and wrong else None,
                # A pointer names where to look and never restates the claim (the grader's own rule).
                "pointer": f"Look again at p. {claim['page']}: {concept['name']}" if verdict in ("missing", "partial") else None,
                # Only a covered claim is judged for its reasoning: g is stated bare, c comes with its reason.
                "reasoning_gap": (code == "g") if verdict == "covered" else None,
            }
        )
    return out


def build() -> List[Dict[str, Any]]:
    courses = json.loads(COURSES.read_text())
    scenarios: List[Dict[str, Any]] = []

    def idea(course: Dict[str, Any], concept_index: int, steps: List[tuple]) -> Dict[str, Any]:
        """One idea of a session: the concept as the app holds it, and the student's turns on it."""
        concept = course["concepts"][concept_index]
        wrong = WRONG[course["id"]]
        turns = []
        for kind, key, codes in steps:
            # A key starting with "=" is the words themselves (an "I don't know" the app's detector must hear as one).
            literal = key.startswith("=")
            say = key[1:] if literal else course["says"][key]
            turn = {"kind": kind, "say": say, "verdicts": verdicts(concept, codes, say, wrong)}
            if literal:
                turn["dont_know"] = True
            turns.append(turn)
        return {
            "concept": {
                "id": f"{course['id']}-c{concept_index}",
                "name": concept["name"],
                "prerequisite": concept["prerequisite"],
                "claims": [
                    {"id": f"{course['id']}-c{concept_index}-k{n}", "text": claim["text"], "page": claim["page"]}
                    for n, claim in enumerate(concept["claims"])
                ],
            },
            "turns": turns,
        }

    def add(course: Dict[str, Any], pattern: str, concept_index: int, steps: List[tuple], then: Optional[List[tuple]] = None) -> None:
        """`then`: the ideas that follow in the same session, each as (concept_index, steps)."""
        number = sum(1 for s in scenarios if s["pattern"] == pattern and s["course"] == course["id"]) + 1
        scenarios.append(
            {
                "id": f"tb-{pattern}-{course['id']}-{number}",
                "pattern": pattern,
                "course": course["id"],
                "source": {"set": "original"},
                "topic": course["topic"],
                **idea(course, concept_index, steps),
                **({"then": [idea(course, index, more) for index, more in then]} if then else {}),
            }
        )

    for course in courses:
        add(course, "just_tell_me", 0, [("explain", "partial", "cm"), ("explain", "just_tell_me", "cm"), ("explain", "just_tell_me", "cm"), ("explain", "say_back", "cc")])
    for course in courses:
        add(course, "idk3", 1, [("explain", "idk", "mm"), ("explain", "idk_again", "mm"), ("explain", "idk_again", "mm"), ("explain", "say_back", "cm"), ("explain", "idk_again", "cm")])
    for course in courses:
        wrong_at = WRONG[course["id"]][0]
        wrong_codes = "ic" if wrong_at == 0 else "ci"
        add(
            course,
            "wrong_wrong_right",
            0,
            [("explain", "wrong", wrong_codes), ("explain", "wrong_again", wrong_codes), ("explain", "right", "cc"), ("example", "example", "cm")],
        )
    for course in [courses[0], courses[2]]:
        wrong_at = WRONG[course["id"]][0]
        wrong_codes = "ic" if wrong_at == 0 else "ci"
        add(course, "confident_wrong", 0, [("explain", "wrong", wrong_codes), ("explain", "wrong_again", wrong_codes), ("explain", "wrong_again", wrong_codes), ("explain", "say_back", "cc")])
    for course in courses:
        add(course, "right_weak_reasoning", 0, [("explain", "weak", "cg"), ("explain", "partial_more", "cc"), ("example", "example", "cm")])
    for course, example_codes in zip([courses[0], courses[1]], ["cm", "mm"]):
        add(course, "full_coverage", 0, [("explain", "full", "cc"), ("example", "example", example_codes)])
    for course in [courses[1], courses[2]]:
        add(course, "off_topic", 0, [("explain", "partial", "cp"), ("explain", "off_topic", "cp"), ("explain", "partial_more", "cc"), ("example", "example", "cm")])
    for course in [courses[0], courses[2]]:
        add(course, "injection", 0, [("explain", "injection_one", "mm"), ("explain", "injection_two", "mm"), ("explain", "idk", "mm"), ("explain", "say_back", "cc")])
    for position, course in enumerate(courses):
        add(course, "idk_first", 0, [("explain", "=" + DONT_KNOW_SAYS[position], "mm"), ("explain", "say_back", "cm"), ("explain", "say_back", "cc")])
    for course in courses:
        add(course, "covers_nothing", 0, [("explain", "idk", "mm"), ("explain", "say_back", "cc")])
    # Two ideas in one session. The first closes three ways; the second is covered at once or starts from "I don't know".
    gears, interest, search = courses
    covered = [("explain", "second_full", "cc"), ("example", "second_example", "cm")]
    add(gears, "two_ideas", 0, [("explain", "full", "cc"), ("example", "example", "cm")], then=[(1, covered)])
    add(interest, "two_ideas", 0, [("explain", "full", "cc"), ("example", "example", "mm")], then=[(1, [("explain", "idk", "mm"), ("explain", "second_full", "cc")])])
    add(search, "two_ideas", 0, [("explain", "idk", "mm"), ("explain", "say_back", "cc")], then=[(1, covered)])
    return scenarios


def main() -> None:
    scenarios = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in scenarios))
    counts: Dict[str, int] = {}
    for scenario in scenarios:
        counts[scenario["pattern"]] = counts.get(scenario["pattern"], 0) + 1
    print(f"Wrote {OUT}: {len(scenarios)} scenarios {counts}")


if __name__ == "__main__":
    main()

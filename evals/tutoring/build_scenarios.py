"""Builds the practice scenarios (spec section 11).

Two sets, the same patterns and the same builder (students.py):

    python3 -I evals/tutoring/build_scenarios.py --original
        scenarios/practice-original.jsonl: 12 scenarios from problems/original.json, practice problems
        written for this eval (probability, algebra, algorithms) with all three hints. No course text.
        This is the committed set: the parity fixture, the tests and CI use it.

    python3 -I evals/tutoring/build_scenarios.py --worked
        scenarios/practice-worked.jsonl: 24 scenarios, each original problem once per worked-example pattern
        (fallback_worked, idk_button), 36 "Show me a worked example" presses. A6 runs it to measure how often a press
        gets the authored hint instead of a worked example (finding 60). Committed: the problems are the eval's own.

    python3 -I evals/tutoring/build_scenarios.py --raw-dir <generation results folder>/raw [--raw-dir ...]
        scenarios/practice.jsonl: 50 scenarios from the practice problems that the generation eval wrote
        from its two cached corpora (MIT OpenCourseWare, CC BY-NC-SA). That text is derived from the
        course material, so this file is git-ignored and rebuilt locally, as the generation eval's
        raw/ folders are. This is the set of the 50-scenario gates run.

The choice is deterministic for the same inputs. Nothing here calls a model.
"""
import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from students import PATTERNS, PRACTICE_MIX, WORKING_PATTERNS, make_scenario, problem_steps, usable  # noqa: E402

DEFAULT_OUT = HERE / "scenarios" / "practice.jsonl"
ORIGINAL_OUT = HERE / "scenarios" / "practice-original.jsonl"
ORIGINAL_PROBLEMS = HERE / "problems" / "original.json"
WORKED_OUT = HERE / "scenarios" / "practice-worked.jsonl"
# The patterns that press "Show me a worked example": fallback_worked twice, idk_button once.
WORKED_PATTERNS = ("fallback_worked", "idk_button")
# Every pattern, injection included, in 12 scenarios.
ORIGINAL_MIX = {
    "just_tell_me": 1,
    "idk3": 1,
    "wrong_wrong_right": 2,
    "confident_wrong": 1,
    "right_weak_reasoning": 2,
    "off_topic": 1,
    "injection": 2,
    "idk_button": 1,
    "fallback_worked": 1,
}
SEED = 0


def load_problems(raw_dirs: List[Path]) -> List[Dict[str, Any]]:
    """Every practice problem in the raw folders, once per statement, with where it came from."""
    seen = set()
    problems: List[Dict[str, Any]] = []
    for raw_dir in raw_dirs:
        for path in sorted(raw_dir.glob("*__interactive.json")):
            record = json.loads(path.read_text())
            if record.get("status") != "ok":
                continue
            for index, problem in enumerate(record.get("output") or []):
                statement = " ".join(str(problem.get("problem_statement", "")).split())
                if not statement or statement in seen:
                    continue
                seen.add(statement)
                problems.append(
                    {
                        "raw": {"title": problem.get("title", ""), "problem_statement": problem.get("problem_statement", ""), "steps": problem.get("steps", [])},
                        "source": {
                            "run": raw_dir.parent.name,
                            "file": path.name,
                            "problem_index": index,
                            "corpus": record.get("corpus"),
                            "topic": (record.get("topic") or {}).get("name"),
                        },
                    }
                )
    return problems


def load_original() -> List[Dict[str, Any]]:
    data = json.loads(ORIGINAL_PROBLEMS.read_text())
    return [{"raw": problem, "source": {"set": "original", "title": problem["title"]}} for problem in data]


def interleave_by_corpus(problems: List[Dict[str, Any]], rng: random.Random) -> List[Dict[str, Any]]:
    """A seeded shuffle, then corpora take turns so both are in every stretch of the list."""
    by_corpus: Dict[str, List[Dict[str, Any]]] = {}
    for problem in problems:
        by_corpus.setdefault(problem["source"].get("corpus") or "", []).append(problem)
    for group in by_corpus.values():
        rng.shuffle(group)
    ordered: List[Dict[str, Any]] = []
    groups = [by_corpus[key] for key in sorted(by_corpus)]
    while any(groups):
        for group in groups:
            if group:
                ordered.append(group.pop())
    return ordered


def deal(candidates: List[Dict[str, Any]], mix: Dict[str, int], rng: random.Random, shuffle_plan: bool = True) -> List[Dict[str, Any]]:
    """One problem per scenario, patterns dealt in the mix. A pattern that writes working with a
    mistake is placed first, while the problems that can carry it are still free."""
    plan = [pattern for pattern in PATTERNS for _ in range(mix.get(pattern, 0))]
    if shuffle_plan:
        rng.shuffle(plan)
    order = sorted(range(len(plan)), key=lambda i: (plan[i] not in WORKING_PATTERNS, i))
    built: Dict[int, Dict[str, Any]] = {}
    pool = list(candidates)
    for position in order:
        pattern = plan[position]
        scenario: Optional[Dict[str, Any]] = None
        for index, candidate in enumerate(pool):
            serial = position + 1
            scenario = make_scenario(f"practice-{serial:03d}-{pattern}", pattern, candidate["raw"], candidate["source"], rng, serial)
            if scenario is not None:
                del pool[index]  # one problem, one scenario
                break
        if scenario is None:
            raise SystemExit(f"ran out of suitable problems for '{pattern}' after {len(built)} scenarios; add more problems")
        built[position] = scenario
    return [built[i] for i in range(len(plan))]


def build(raw_dirs: List[Path], mix: Dict[str, int] = PRACTICE_MIX) -> List[Dict[str, Any]]:
    rng = random.Random(SEED)
    candidates = [p for p in load_problems(raw_dirs) if usable(problem_steps(p["raw"]))]
    return deal(interleave_by_corpus(candidates, rng), mix, rng)


def build_original(mix: Dict[str, int] = ORIGINAL_MIX) -> List[Dict[str, Any]]:
    rng = random.Random(SEED)
    return deal(load_original(), mix, rng, shuffle_plan=False)


def build_worked() -> List[Dict[str, Any]]:
    """Every original problem once per worked-example pattern, patterns in turn."""
    rng = random.Random(SEED)
    scenarios: List[Dict[str, Any]] = []
    for pattern in WORKED_PATTERNS:
        for candidate in load_original():
            serial = len(scenarios) + 1
            scenario = make_scenario(f"worked-{serial:03d}-{pattern}", pattern, candidate["raw"], candidate["source"], rng, serial)
            if scenario is None:
                raise SystemExit(f"original problem '{candidate['raw']['title']}' does not suit '{pattern}'")
            scenarios.append(scenario)
    return scenarios


def write(scenarios: List[Dict[str, Any]], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in scenarios))
    counts: Dict[str, int] = {}
    for scenario in scenarios:
        counts[scenario["pattern"]] = counts.get(scenario["pattern"], 0) + 1
    print(f"Wrote {len(scenarios)} scenarios to {out}: {counts}")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--original", action="store_true", help="build the committed set from problems/original.json")
    parser.add_argument("--worked", action="store_true", help="build the worked-example set (A6) from problems/original.json")
    parser.add_argument("--raw-dir", type=Path, action="append", default=[], help="a generation results folder's raw/ directory (repeatable)")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)
    if [args.original, args.worked, bool(args.raw_dir)].count(True) != 1:
        parser.error("give one of --original, --worked or one or more --raw-dir")
    if args.original:
        write(build_original(), args.out or ORIGINAL_OUT)
        return 0
    if args.worked:
        write(build_worked(), args.out or WORKED_OUT)
        return 0
    for raw_dir in args.raw_dir:
        if not raw_dir.is_dir():
            raise SystemExit(f"{raw_dir} is not a folder")
    write(build(args.raw_dir), args.out or DEFAULT_OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

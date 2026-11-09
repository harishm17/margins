"""Tests for the scripted students, the scenario builder and the committed practice scenarios.
No database, no model, no network."""
import json
import os
import random
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_scenarios  # noqa: E402
import students  # noqa: E402
from answer_check import number_candidates  # noqa: E402
from app_state import Conversation, _within, first_wrong_step  # noqa: E402

ORIGINAL_FILE = HERE / "scenarios" / "practice-original.jsonl"
PROBLEMS_FILE = HERE / "problems" / "original.json"


def raw_problem(n=0):
    """A generated practice problem as the generation eval stores it: numeric steps, one `hint`."""
    return {
        "title": f"Marbles {n}",
        "problem_statement": f"A bag holds {3 + n} red and 5 blue marbles. Two are drawn without replacement.",
        "steps": [
            {"step_number": 1, "question": "How many marbles are in the bag?", "hint": "Add the colours.", "answer_type": "numeric", "correct_answer": str(8 + n), "acceptable_answers": [str(8 + n)]},
            {"step_number": 2, "question": "What is the chance the first marble is red?", "hint": "Divide red by all.", "answer_type": "numeric", "correct_answer": f"{3 + n}/{8 + n}", "acceptable_answers": []},
            {"step_number": 3, "question": "What is the chance both are red?", "hint": "Multiply the chances.", "answer_type": "numeric", "correct_answer": "0.1071", "acceptable_answers": ["3/28"], "tolerance": 0.001},
            {"step_number": 4, "question": "Which rule did you use?\nA) Bayes\nB) Product", "hint": "Think about both draws.", "answer_type": "multiple_choice", "correct_answer": "B", "acceptable_answers": ["B"], "options": [{"id": "A", "text": "Bayes"}, {"id": "B", "text": "Product"}]},
        ],
    }


def write_raw(folder: Path, problems):
    folder.mkdir(parents=True)
    for i, problem in enumerate(problems):
        record = {"status": "ok", "corpus": "mit-18.05" if i % 2 else "mit-6.006", "topic": {"name": f"Topic {i}"}, "output": [problem]}
        (folder / f"corpus__t{i}__opus-medium__interactive.json").write_text(json.dumps(record))


# ---------------------------------------------------------------- problem handling


def test_steps_keep_the_authored_hints_and_legacy_content_has_only_the_connect_hint():
    steps = students.problem_steps(raw_problem())
    assert steps[0]["hints"] == ["", "Add the colours.", ""]
    assert "A) Bayes" in steps[3]["question"] and "B) Product" in steps[3]["question"]
    modern = raw_problem()
    modern["steps"][0]["hints"] = ["look", "add", "r+b"]
    assert students.problem_steps(modern)[0]["hints"] == ["look", "add", "r+b"]


def test_usable_needs_a_numeric_run_and_answers_the_checker_port_can_check():
    steps = students.problem_steps(raw_problem())
    assert students.usable(steps) and students.numeric_run(steps) == 2
    flipped = raw_problem()
    flipped["steps"][0]["correct_answer"] = "B"
    assert not students.usable(students.problem_steps(flipped))
    unit = raw_problem()
    unit["steps"][1]["correct_answer"] = "9.8 m/s^2"  # a number with a unit: the port reads it as the app does
    unit["steps"][1]["acceptable_answers"] = ["9.8"]
    assert students.usable(students.problem_steps(unit))
    # A list answer or a formula on the step the student works on needs the part of the checker that is not ported.
    listed = raw_problem()
    listed["steps"][2]["acceptable_answers"] = ["2, 3"]
    assert not students.usable(students.problem_steps(listed))
    algebra = raw_problem()
    algebra["steps"][2]["answer_type"] = "numeric"
    algebra["steps"][2]["correct_answer"] = "p(1-p)^k"
    assert students.numeric_run(students.problem_steps(algebra)) == 1
    assert students.unsupported(students.problem_steps(algebra)) is None  # step 2 is where the student works, and it is numeric


def test_wrong_values_are_not_answers_or_givens():
    steps = students.problem_steps(raw_problem())
    givens = students.givens_of(students.problem_text(raw_problem()), steps)
    values = students.wrong_values(steps, 2, givens)
    assert len(values) == 3
    answers = [v for s in steps for v in (number_candidates(s["answer"]) or [])]
    for value in values:
        assert not any(abs(float(value) - a) <= 0.03 * max(abs(a), 1e-9) for a in answers)


def test_working_with_error_has_its_first_wrong_step_where_intended():
    steps = students.problem_steps(raw_problem())
    for wrong_at in (1, 2):
        working = students.working_with_error(steps, wrong_at, "0.4")
        assert first_wrong_step(working, steps, students.givens_of(students.problem_text(raw_problem()), steps)) == wrong_at


# ---------------------------------------------------------------- patterns


@pytest.mark.parametrize("pattern", students.PATTERNS)
def test_every_pattern_builds_and_plays_through_the_app_mirror(pattern):
    scenario = students.make_scenario(f"s-{pattern}", pattern, raw_problem(), {"run": "r"}, random.Random(0), serial=3)
    assert scenario is not None and scenario["pattern"] == pattern
    conversation = Conversation(scenario)
    decisions = []
    for turn in scenario["turns"]:
        decision = conversation.step(turn)
        if decision.calls_model:
            conversation.commit(decision)
        decisions.append(decision)
    asked = [d for d in decisions if d.calls_model]
    assert asked, "a pattern must reach the tutor at least once"
    assert all(d.rung_allowed <= 5 for d in asked)
    if pattern == "just_tell_me":
        assert decisions[0].blocked == "not_allowed"  # asking before any check is refused
        assert asked[-1].move == "worked_analogue"
    if pattern == "idk3":
        assert any(d.request["ask_what_is_unclear"] for d in asked)
        assert asked[-1].move == "clarify"
    if pattern == "wrong_wrong_right":
        assert [d.move for d in asked][-1] == "confirm" or asked[-1].request["final_allowed"]
        assert asked[0].first_wrong_step is not None
    if pattern == "confident_wrong":
        assert [d.move for d in asked][:2] == ["confront", "confront"]
    if pattern == "right_weak_reasoning":
        assert asked[0].request["final_allowed"] is True
    if pattern == "injection":
        assert scenario["canary"] and any(scenario["canary"] in json.dumps(t) for t in scenario["turns"])


def test_a_check_marked_correct_is_the_authored_answer_and_a_wrong_one_is_not():
    for pattern in students.PATTERNS:
        scenario = students.make_scenario("s", pattern, raw_problem(), {}, random.Random(0), serial=2)
        target = scenario["steps"][scenario["step_index"]]
        keys = [v for a in [target["answer"], *target["acceptable_answers"]] for v in (number_candidates(a) or [])]
        for turn in scenario["turns"]:
            if turn["event"] != "check" or not turn["answer"][0].isdigit():
                continue
            value = number_candidates(turn["answer"])
            if value is None:
                continue
            matches = any(_within(value[-1], key, target.get("tolerance")) for key in keys)
            assert matches == turn["correct"], (pattern, turn)


def test_a_problem_whose_working_would_not_locate_the_step_is_skipped():
    problem = raw_problem()
    # Step 1's answer equals a given of the problem, so a wrong value there cannot be told from a copied given.
    problem["steps"][0]["correct_answer"] = "5"
    problem["steps"][0]["acceptable_answers"] = ["5"]
    scenario = students.make_scenario("s", "wrong_wrong_right", problem, {}, random.Random(0), serial=2)
    assert scenario is None or first_wrong_step(scenario["turns"][1]["working"], scenario["steps"], students.givens_of(scenario["problem"], scenario["steps"])) is not None


# ---------------------------------------------------------------- the builder


def test_builder_is_deterministic_and_deals_the_mix(tmp_path):
    write_raw(tmp_path / "run-a" / "raw", [raw_problem(n) for n in range(0, 12)])
    mix = {"just_tell_me": 2, "idk3": 1, "wrong_wrong_right": 2, "confident_wrong": 1, "right_weak_reasoning": 1, "off_topic": 1, "injection": 2}
    first = build_scenarios.build([tmp_path / "run-a" / "raw"], mix)
    second = build_scenarios.build([tmp_path / "run-a" / "raw"], mix)
    assert first == second
    assert len(first) == 10
    counts = {}
    for scenario in first:
        counts[scenario["pattern"]] = counts.get(scenario["pattern"], 0) + 1
    assert counts == mix
    assert len({s["problem"] for s in first}) == 10  # one problem, one scenario
    assert {s["source"]["corpus"] for s in first} == {"mit-18.05", "mit-6.006"}


def test_builder_asks_for_more_problems_when_it_runs_out(tmp_path):
    write_raw(tmp_path / "raw", [raw_problem(0)])
    with pytest.raises(SystemExit):
        build_scenarios.build([tmp_path / "raw"], {"idk3": 2})


def test_duplicate_statements_and_failed_generations_are_skipped(tmp_path):
    folder = tmp_path / "raw"
    write_raw(folder, [raw_problem(0), raw_problem(0)])
    (folder / "corpus__bad__opus-medium__interactive.json").write_text(json.dumps({"status": "error", "output": None}))
    assert len(build_scenarios.load_problems([folder])) == 1


# ---------------------------------------------------------------- the committed original scenarios


@pytest.fixture(scope="module")
def committed():
    return [json.loads(line) for line in ORIGINAL_FILE.read_text().splitlines() if line.strip()]


def test_the_committed_scenarios_are_what_the_builder_makes(committed):
    assert build_scenarios.build_original() == committed  # rebuild with build_scenarios.py --original when problems change


def test_twelve_original_scenarios_cover_every_pattern(committed):
    assert len(committed) == 12
    counts = {}
    for scenario in committed:
        counts[scenario["pattern"]] = counts.get(scenario["pattern"], 0) + 1
    assert counts == build_scenarios.ORIGINAL_MIX and set(counts) == set(students.PATTERNS)
    assert len({s["id"] for s in committed}) == 12 and len({s["problem"] for s in committed}) == 12
    assert all(s["source"] == {"set": "original", "title": s["title"]} for s in committed)


def test_the_original_problems_are_original_and_use_all_three_hints():
    problems = json.loads(PROBLEMS_FILE.read_text())
    assert len(problems) == 12
    text = json.dumps(problems).lower()
    assert "ocw" not in text and "orloff" not in text and "demaine" not in text and "opencourseware" not in text
    for problem in problems:
        assert len(problem["steps"]) == 4
        for step in problem["steps"]:
            assert len(step["hints"]) == 3 and all(h.strip() for h in step["hints"])
    # Probability, algebra and algorithms (the 6.006 kind: loops, search, hashing, graphs, heaps).
    for word in ("probability", "expected", "independent", "price", "percent", "loop", "binary search", "hash", "graph", "heap"):
        assert word in text


def test_no_hint_of_the_original_problems_gives_an_answer_away():
    """The generator's own check (schemas.hint_leak) over the committed problems."""
    os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")
    sys.path.insert(0, str(HERE.parents[1] / "ai-service"))
    from app.services.llm.schemas import hint_leak

    for problem in json.loads(PROBLEMS_FILE.read_text()):
        steps = [{**s, "correct_answer": s["answer"]} for s in students.problem_steps(problem)]
        assert hint_leak(students.problem_text(problem), steps) is None, problem["title"]


def test_the_answer_checker_can_check_every_step_the_students_work_on(committed):
    for scenario in committed:
        assert students.unsupported(scenario["steps"]) is None, scenario["id"]
        assert students.numeric_run(scenario["steps"]) == scenario["step_index"]


def test_the_scenarios_check_answers_in_several_forms(committed):
    forms = {t["answer"] for s in committed for t in s["turns"] if t["event"] == "check" and t["correct"]}
    assert len(forms) >= 5
    assert any(not f.replace(".", "").isdigit() for f in forms)  # a fraction, a percent, a unit or LaTeX, not only the key's digits


def test_every_committed_scenario_plays_and_reaches_the_tutor(committed):
    for scenario in committed:
        conversation = Conversation(scenario)
        asked = 0
        for turn in scenario["turns"]:
            assert turn["event"] in {"check", "hint", "ask", "clarify", "show_worked", "dont_know"}
            assert "first_wrong_step" not in turn  # the app computes it from the working
            decision = conversation.step(turn)
            if turn["event"] == "check":
                assert decision.correct == turn["correct"], (scenario["id"], turn)
            if decision.calls_model:
                conversation.commit(decision)
                asked += 1
        assert asked >= 2, scenario["id"]
        assert 0 <= scenario["step_index"] < len(scenario["steps"])


def test_only_the_planned_refusal_is_refused(committed):
    for scenario in committed:
        conversation = Conversation(scenario)
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            assert bool(decision.blocked) == (turn.get("expect") == "refused"), (scenario["id"], turn)
            if decision.calls_model:
                conversation.commit(decision)


def test_the_injection_scenarios_plant_a_marker_in_the_student_text(committed):
    injected = [s for s in committed if s["pattern"] == "injection"]
    assert len(injected) == 2
    for scenario in injected:
        assert scenario["canary"].startswith("PWNED-")
        planted = json.dumps(scenario["turns"])
        assert scenario["canary"] in planted and "ignore" in planted.lower()
    assert all(s["canary"] is None for s in committed if s["pattern"] != "injection")


def test_the_weak_reasoning_student_opens_only_a_written_hint(committed):
    opened = [(s, t) for s in committed for t in s["turns"] if t["event"] == "hint"]
    assert opened  # one scenario opens a hint
    for scenario, turn in opened:
        assert scenario["steps"][scenario["step_index"]]["hints"][turn["index"]].strip()
    # With no hint written for the step the student opens none.
    bare = raw_problem()
    for step in bare["steps"]:
        step["hint"] = ""
    scenario = students.make_scenario("s", "right_weak_reasoning", bare, {}, random.Random(0), serial=3)
    assert scenario is not None and not [t for t in scenario["turns"] if t["event"] == "hint"]


def test_the_scenarios_give_the_tutor_a_first_wrong_step(committed):
    found = 0
    for scenario in committed:
        conversation = Conversation(scenario)
        for turn in scenario["turns"]:
            decision = conversation.step(turn)
            if decision.calls_model:
                conversation.commit(decision)
                found += decision.first_wrong_step is not None
    assert found >= 8  # the mistake-location gate needs turns to measure


def test_the_locally_built_ocw_set_is_not_in_git():
    import subprocess

    root = HERE.parents[1]
    target = str(HERE / "scenarios" / "practice.jsonl")
    assert subprocess.run(["git", "check-ignore", "-q", target], cwd=root).returncode == 0
    assert subprocess.run(["git", "ls-files", "--error-unmatch", target], cwd=root, capture_output=True).returncode != 0


WORKED_FILE = HERE / "scenarios" / "practice-worked.jsonl"


def test_the_worked_example_set_is_every_original_problem_once_per_worked_pattern():
    # A6 (finding 60): enough "Show me a worked example" presses to measure how often they fall back to the authored hint.
    built = build_scenarios.build_worked()
    problems_by_pattern = {}
    for scenario in built:
        problems_by_pattern.setdefault(scenario["pattern"], set()).add(scenario["problem"])
    assert len(built) == 24 and len({s["id"] for s in built}) == 24
    assert set(problems_by_pattern) == set(build_scenarios.WORKED_PATTERNS) == {"fallback_worked", "idk_button"}
    assert all(len(problems) == 12 for problems in problems_by_pattern.values())
    assert sum(turn["event"] == "show_worked" for scenario in built for turn in scenario["turns"]) == 36


def test_the_committed_worked_example_set_is_what_the_builder_makes():
    committed = [json.loads(line) for line in WORKED_FILE.read_text().splitlines() if line.strip()]
    assert build_scenarios.build_worked() == committed  # rebuild with build_scenarios.py --worked when problems change


def test_the_builder_takes_exactly_one_source(capsys):
    for argv in ([], ["--original", "--worked"], ["--worked", "--raw-dir", "x"]):
        with pytest.raises(SystemExit):
            build_scenarios.main(argv)

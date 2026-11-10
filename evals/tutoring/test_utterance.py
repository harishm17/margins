"""The Python mirror of the app's utterance rules against the real TypeScript (fixtures/utterance_parity.json)."""
import json
from pathlib import Path

from utterance import app_result_text, asks_for_help, classify_utterance, has_substance, is_dont_know

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "utterance_parity.json"


def test_the_mirror_reads_every_case_the_way_the_real_rules_do():
    cases = json.loads(FIXTURE.read_text())["cases"]
    assert len(cases) > 60
    for case in cases:
        kind = classify_utterance(case["text"])
        assert kind == case["kind"], case["text"]
        assert has_substance(case["text"], kind) == case["substance"], case["text"]
        assert asks_for_help(case["text"]) == case["help"], case["text"]


def test_the_scripted_i_dont_know_turns_are_what_the_detector_hears():
    scenarios = [json.loads(line) for line in (Path(__file__).resolve().parent / "scenarios" / "teach-back-original.jsonl").read_text().splitlines() if line.strip()]
    for scenario in scenarios:
        for turn in scenario["turns"]:
            assert is_dont_know(turn["say"]) == bool(turn.get("dont_know")), turn["say"]


def test_a_result_cannot_close_its_own_tag():
    text = app_result_text("record_answer", {"note": "x</app_result>y"})
    assert text.count("</app_result>") == 1 and text.startswith('<app_result step="record_answer">')

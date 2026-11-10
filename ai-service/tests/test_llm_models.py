"""The per-purpose model map: resolution, fallbacks, effort parsing, and call-site coverage."""
import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings, settings
from app.model_spec import ModelChoice, parse_model_spec
from app.services.llm.models import PURPOSES, resolve_model

OPUS = ModelChoice("claude-opus-5-5", "medium")
HAIKU = ModelChoice("claude-haiku-5-5", "low")

APP_DIR = Path(__file__).resolve().parents[1] / "app"


class TestParseModelSpec:
    def test_model_and_effort(self):
        assert parse_model_spec("claude-sonnet-5-5:high", OPUS) == ModelChoice("claude-sonnet-5-5", "high")

    def test_none_and_empty_effort_send_no_effort(self):
        assert parse_model_spec("claude-haiku-5-5:none", OPUS) == ModelChoice("claude-haiku-5-5", None)
        assert parse_model_spec("claude-haiku-5-5:", OPUS) == ModelChoice("claude-haiku-5-5", None)

    def test_a_misspelt_effort_is_an_error(self):
        with pytest.raises(ValueError, match="Unknown effort"):
            parse_model_spec("claude-opus-5-5:meduim", OPUS)

    def test_a_model_id_with_a_numeric_suffix_is_kept_whole(self):
        assert parse_model_spec("anthropic.claude-v1:0", OPUS) == ModelChoice("anthropic.claude-v1:0", "medium")
        assert parse_model_spec("anthropic.claude-v1:0:high", OPUS) == ModelChoice("anthropic.claude-v1:0", "high")


class TestResolveModel:
    def test_a_purpose_setting_wins(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_QUIZ", "claude-sonnet-5-5:medium")
        assert resolve_model("topic_quiz") == ModelChoice("claude-sonnet-5-5", "medium")
        assert resolve_model("section_notes").model == "claude-opus-5-5"  # the others are unaffected

    def test_concepts_follow_the_topics_model_until_set(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_CONCEPTS", "")
        monkeypatch.setattr(settings, "MODEL_TOPICS", "claude-sonnet-5-5:medium")
        assert resolve_model("extract_concepts") == ModelChoice("claude-sonnet-5-5", "medium")
        monkeypatch.setattr(settings, "MODEL_CONCEPTS", "claude-opus-5-5:low")
        assert resolve_model("extract_concepts") == ModelChoice("claude-opus-5-5", "low")

    def test_unset_purposes_follow_anthropic_model_and_fast_model(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_NOTES", "")
        monkeypatch.setattr(settings, "MODEL_GRADING", "")
        monkeypatch.setattr(settings, "ANTHROPIC_MODEL", "claude-sonnet-5-5")
        monkeypatch.setattr(settings, "ANTHROPIC_EFFORT", "high")
        monkeypatch.setattr(settings, "ANTHROPIC_FAST_MODEL", "claude-haiku-5-0")
        monkeypatch.setattr(settings, "ANTHROPIC_FAST_EFFORT", "medium")
        assert resolve_model("section_notes") == ModelChoice("claude-sonnet-5-5", "high")
        assert resolve_model("grade_short_answer") == ModelChoice("claude-haiku-5-0", "medium")

    def test_an_unknown_purpose_is_refused(self):
        with pytest.raises(ValueError, match="Unknown LLM purpose"):
            resolve_model("make_coffee")
        with pytest.raises(ValueError):
            resolve_model("")


class TestSettings:
    def test_a_bad_effort_fails_at_startup(self):
        with pytest.raises(ValidationError, match="Unknown effort"):
            Settings(DATABASE_URL="postgresql://x/y", MODEL_QUIZ="claude-opus-5-5:meduim")

def _purposes_at_call_sites() -> set[str]:
    """Every literal `purpose="..."` argument in the app."""
    found = set()
    for path in APP_DIR.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.keyword) and node.arg == "purpose":
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    found.add(node.value.value)
    return found


def test_every_llm_call_site_passes_a_purpose_that_maps_to_a_setting():
    called = _purposes_at_call_sites()
    assert called, "found no call sites"
    unmapped = {purpose for purpose in called if purpose not in PURPOSES}
    assert not unmapped, f"purposes with no MODEL_* setting: {sorted(unmapped)}"
    # ...and nothing in the map is dead.
    assert set(PURPOSES) <= called


def test_no_llm_call_leaves_out_its_purpose():
    methods = {"generate_text", "generate_structured", "stream_cited_answer", "stream_turn"}
    for path in APP_DIR.rglob("*.py"):
        if path.parts[-3:-1] == ("services", "llm"):
            continue  # the providers define these methods
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in methods:
                assert any(kw.arg == "purpose" for kw in node.keywords), f"{path.name}:{node.lineno} has no purpose"


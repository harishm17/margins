"""The per-purpose model map: resolution, fallbacks, effort parsing, and call-site coverage."""
import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings, settings
from app.model_spec import ModelChoice, parse_model_spec
from app.services.llm.models import MODEL_SETTINGS, PURPOSES, resolve_model

OPUS = ModelChoice("claude-opus-5-5", "medium")
HAIKU = ModelChoice("claude-haiku-5-5", "low")

APP_DIR = Path(__file__).resolve().parents[1] / "app"


class TestParseModelSpec:
    def test_empty_is_the_fallback(self):
        assert parse_model_spec("", OPUS) == OPUS
        assert parse_model_spec("   ", OPUS) == OPUS

    def test_model_and_effort(self):
        assert parse_model_spec("claude-sonnet-5-5:high", OPUS) == ModelChoice("claude-sonnet-5-5", "high")

    def test_model_alone_keeps_the_fallback_effort(self):
        assert parse_model_spec("claude-sonnet-5-5", HAIKU) == ModelChoice("claude-sonnet-5-5", "low")

    def test_effort_alone_keeps_the_fallback_model(self):
        assert parse_model_spec(":low", OPUS) == ModelChoice("claude-opus-5-5", "low")

    def test_effort_is_case_and_space_insensitive(self):
        assert parse_model_spec(" claude-haiku-5-5 : LOW ", OPUS) == ModelChoice("claude-haiku-5-5", "low")

    @pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
    def test_every_effort_is_accepted(self, effort):
        assert parse_model_spec(f"m:{effort}", OPUS).effort == effort

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
    def test_defaults_keep_todays_models(self, monkeypatch):
        for name in MODEL_SETTINGS:
            monkeypatch.setattr(settings, name, Settings.model_fields[name].default)
        for purpose in ("section_notes", "solved_examples", "interactive_examples", "topic_quiz", "exam_questions"):
            assert resolve_model(purpose) == ModelChoice("claude-opus-5-5", "medium"), purpose
        for purpose in ("grade_short_answer", "validate_material", "order_units"):
            assert resolve_model(purpose) == ModelChoice("claude-haiku-5-5", "low"), purpose
        # One planning call per course, and structure decides every later lesson: the notes model.
        assert resolve_model("extract_topics") == ModelChoice("claude-opus-5-5", "low")
        # Chat and voice have always run at low effort.
        assert resolve_model("chat") == ModelChoice("claude-opus-5-5", "low")
        assert resolve_model("voice") == ModelChoice("claude-haiku-5-5", "low")
        assert resolve_model("voice_drill") == ModelChoice("claude-haiku-5-5", "low")

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

    def test_an_effort_only_setting_uses_the_fallback_model(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_CHAT", ":high")
        monkeypatch.setattr(settings, "ANTHROPIC_MODEL", "claude-sonnet-5-5")
        assert resolve_model("chat") == ModelChoice("claude-sonnet-5-5", "high")

    def test_exam_style_uses_the_topics_model_at_low_effort_whatever_its_setting(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_TOPICS", "claude-sonnet-5-5:high")
        assert resolve_model("exam_style") == ModelChoice("claude-sonnet-5-5", "low")
        assert resolve_model("extract_topics") == ModelChoice("claude-sonnet-5-5", "high")
        monkeypatch.setattr(settings, "MODEL_TOPICS", "claude-opus-5-5:none")
        assert resolve_model("exam_style") == ModelChoice("claude-opus-5-5", "low")

    def test_voice_and_drills_share_a_setting(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_VOICE", "claude-haiku-5-5:medium")
        assert resolve_model("voice") == resolve_model("voice_drill") == ModelChoice("claude-haiku-5-5", "medium")

    def test_an_unknown_purpose_is_refused(self):
        with pytest.raises(ValueError, match="Unknown LLM purpose"):
            resolve_model("make_coffee")
        with pytest.raises(ValueError):
            resolve_model("")


class TestSettings:
    def test_a_bad_effort_fails_at_startup(self):
        with pytest.raises(ValidationError, match="Unknown effort"):
            Settings(DATABASE_URL="postgresql://x/y", MODEL_QUIZ="claude-opus-5-5:meduim")

    def test_every_setting_the_map_names_exists(self):
        for config in PURPOSES.values():
            assert config.setting in Settings.model_fields

    def test_the_spec_settings_all_exist_with_the_spec_names(self):
        assert set(MODEL_SETTINGS) == {
            "MODEL_NOTES", "MODEL_EXAMPLES", "MODEL_PRACTICE", "MODEL_QUIZ", "MODEL_EXAM",
            "MODEL_GRADING", "MODEL_TOPICS", "MODEL_CONCEPTS", "MODEL_WARMUP", "MODEL_GAP_EXPLAINER", "MODEL_ROUTER", "MODEL_TUTOR", "MODEL_RECALL_GRADING", "MODEL_CHAT", "MODEL_VOICE", "MODEL_VALIDATION",
        }

    def test_new_retry_and_concurrency_defaults(self):
        assert Settings.model_fields["LLM_MAX_RETRIES"].default == 4
        assert Settings.model_fields["LLM_MAX_CONCURRENCY"].default == 4


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


def test_the_tutor_uses_sonnet_at_low_effort_and_the_leak_judge_the_router_model(monkeypatch):
    monkeypatch.setattr(settings, "MODEL_TUTOR", Settings.model_fields["MODEL_TUTOR"].default)
    monkeypatch.setattr(settings, "MODEL_ROUTER", Settings.model_fields["MODEL_ROUTER"].default)
    assert resolve_model("tutor") == ModelChoice("claude-sonnet-5-5", "low")
    assert resolve_model("router") == ModelChoice("claude-haiku-5-5", "low")

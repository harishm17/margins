"""PROMPTS_V2 switches the audited prompts on per area; empty means every area keeps v1."""
import pytest

from pydantic import ValidationError

from app.config import Settings, settings
from app.prompt_revision import PROMPT_AREAS, prompts_v2


def test_every_area_is_off_by_default(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "")
    assert not any(prompts_v2(area) for area in PROMPT_AREAS)


def test_listed_areas_are_on(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "generation, Tutor")
    assert prompts_v2("generation") and prompts_v2("tutor")
    assert not prompts_v2("ask")


def test_all_turns_every_area_on(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "all")
    assert all(prompts_v2(area) for area in PROMPT_AREAS)


def test_unknown_area_is_a_bug():
    with pytest.raises(ValueError):
        prompts_v2("nonsense")


def test_a_misspelt_area_in_the_setting_stops_the_service_at_start():
    """Whole-PR review of #90: PROMPTS_V2=voise was ignored, so the area stayed on v1 with nothing in the logs."""
    with pytest.raises(ValidationError, match="voise"):
        Settings(ENVIRONMENT="development", PROMPTS_V2="tutor, voise")
    assert Settings(ENVIRONMENT="development", PROMPTS_V2=" Tutor, ALL ,").PROMPTS_V2

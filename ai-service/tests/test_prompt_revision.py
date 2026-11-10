"""PROMPTS_V2 switches the audited prompts on per area; empty means every area keeps v1."""
import pytest

from app.config import settings
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

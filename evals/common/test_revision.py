"""prompt_revision records which prompt revision an eval ran; request_summary tells v1 and v2 requests apart."""
import os
import sys
from pathlib import Path

import pytest

EVALS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVALS))
sys.path.insert(0, str(EVALS.parent / "ai-service"))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/unused")

from app.config import settings  # noqa: E402
from app.services.llm.base import LLMMessage  # noqa: E402
from common.revision import prompt_revision, request_summary  # noqa: E402


@pytest.mark.parametrize(
    "setting, expected, revision",
    [
        ("", {"generation": "v1", "support": "v1"}, "v1"),
        ("generation", {"generation": "v2", "support": "v1"}, "mixed"),
        ("generation, support", {"generation": "v2", "support": "v2"}, "v2"),
        ("all", {"generation": "v2", "support": "v2"}, "v2"),
    ],
)
def test_prompt_revision_follows_the_setting(monkeypatch, setting, expected, revision):
    monkeypatch.setattr(settings, "PROMPTS_V2", setting)
    result = prompt_revision("generation", "support")
    assert result == {"PROMPTS_V2": setting.strip(), "areas": expected, "revision": revision}


def test_request_summary_differs_by_system_prompt_and_names_the_schema():
    class Schema:
        pass

    one = request_summary([LLMMessage(role="system", content="v1 text"), LLMMessage(role="user", content="q")], Schema)
    two = request_summary([LLMMessage(role="system", content="v2 text"), LLMMessage(role="user", content="q")], None)
    assert one["schema"] == "Schema" and two["schema"] is None
    assert one["system_sha"] != two["system_sha"]

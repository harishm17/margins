"""The output cap registry (prompt audit R7): every v2 call takes its cap from llm/caps.py, each v2 cap leaves room
for thinking beyond the call's v1 cap, and an empty PROMPTS_V2 sends the v1 cap unchanged."""
import ast
import importlib
from pathlib import Path

import pytest

from app.config import settings
from app.services.llm.caps import OUTPUT_CAPS, output_cap

APP = Path(__file__).resolve().parents[1] / "app"


def _call_sites():
    """(call name, v1 cap, file) for every `output_cap("name", v1)` in the service."""
    sites = []
    for path in APP.rglob("*.py"):
        tree = ast.parse(path.read_text())
        module = None
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "output_cap"):
                continue
            name, v1 = node.args
            if isinstance(v1, ast.Constant):
                cap = v1.value
            else:  # a module constant such as RECALL_MAX_TOKENS
                if module is None:
                    module = importlib.import_module(".".join(path.relative_to(APP.parent).with_suffix("").parts))
                cap = getattr(module, v1.id)
            sites.append((name.value, cap, path.name))
    return sites


SITES = _call_sites()


def test_every_registry_entry_is_used_and_every_call_is_registered():
    used = {name for name, _, _ in SITES}
    assert used <= set(OUTPUT_CAPS), used - set(OUTPUT_CAPS)
    # The leak judge reads its entry directly (Ask and the tutors share it).
    assert set(OUTPUT_CAPS) - used <= {"leak_judge"}


@pytest.mark.parametrize("name,v1,where", SITES)
def test_a_v2_cap_has_room_beyond_v1_and_v1_is_unchanged_when_off(monkeypatch, name, v1, where):
    monkeypatch.setattr(settings, "PROMPTS_V2", "")
    assert output_cap(name, v1) == v1
    monkeypatch.setattr(settings, "PROMPTS_V2", OUTPUT_CAPS[name].area)
    assert output_cap(name, v1) > v1, f"{name} in {where}: the v2 cap must leave room for thinking"


def test_the_leak_judge_has_room_on_v2():
    from app.services.tutor.leak import JUDGE_MAX_TOKENS

    assert OUTPUT_CAPS["leak_judge"].tokens > JUDGE_MAX_TOKENS

"""Which prompt revision an eval run used, for run.json / summary.json.

The app picks v1 or v2 prompts and schemas itself, from `settings.PROMPTS_V2` (env var PROMPTS_V2), through
`app.prompt_revision.prompts_v2(area)`. Evals must go through the app function that applies the flag instead of
importing a v1 constant, and record the setting with `prompt_revision(area)` so v1 and v2 runs can be told apart.
Call it after `prepare_app_environment` (app.config reads the environment on first import).
"""
from typing import Any, Dict, Optional, Sequence


def prompts_v2_setting() -> str:
    from app.config import settings

    return (settings.PROMPTS_V2 or "").strip()


def prompt_revision(*areas: str) -> Dict[str, Any]:
    """{"PROMPTS_V2": the raw setting, "areas": {area: "v2" | "v1"}, "revision": "v2" | "v1" | "mixed"} for `areas`."""
    from app.prompt_revision import prompts_v2

    per_area = {area: ("v2" if prompts_v2(area) else "v1") for area in areas}
    values = set(per_area.values())
    revision = values.pop() if len(values) == 1 else "mixed"
    return {"PROMPTS_V2": prompts_v2_setting(), "areas": per_area, "revision": revision}


def schema_name(schema: Optional[Any]) -> Optional[str]:
    return getattr(schema, "__name__", None) if schema is not None else None


def request_summary(messages: Sequence[Any], schema: Optional[Any]) -> Dict[str, Any]:
    """A short fingerprint of one model request: schema class name, system prompt length and a hash of its text."""
    import hashlib

    system = "\n".join(str(getattr(m, "content", "")) for m in messages if getattr(m, "role", "") == "system")
    return {
        "schema": schema_name(schema),
        "system_chars": len(system),
        "system_sha": hashlib.sha256(system.encode("utf-8")).hexdigest()[:12],
    }

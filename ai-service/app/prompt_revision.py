"""Which areas use the audited (v2) prompts of the 2026-11-09 prompt audit.

`PROMPTS_V2` is a comma-separated list of areas, or "all". Empty (the default) keeps every area
on its v1 prompts, so a deploy changes nothing until an area's eval has passed and it is listed.
A name that is not an area stops the service at start (config.py), so a misspelt area is not silently left on v1.
Once an area has run on v2 in production, its v1 text and this check are deleted.

Rule from the audit (PR 1.7): any change of model, or of a model's effort (llm/models.py), re-runs the prompt audit
for the calls it touches, and their evals, before it ships. Prompts are written for one model's behaviour; a new
model or effort can turn a fine prompt into a refusal, a cut-off reply or a different grade.
"""
from app.config import PROMPT_AREAS, settings

__all__ = ["PROMPT_AREAS", "prompts_v2"]


def prompts_v2(area: str) -> bool:
    if area not in PROMPT_AREAS:
        raise ValueError(f"Unknown prompt area {area!r}: add it to PROMPT_AREAS in app/config.py")
    listed = {part.strip().lower() for part in (settings.PROMPTS_V2 or "").split(",") if part.strip()}
    return "all" in listed or area in listed

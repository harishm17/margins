"""Guards from the 2026-11-09 prompt audit, so the same faults can't come back unnoticed.

On the Claude 5.5 models a required field that asks the model to write out its reasoning can be
declined as reasoning extraction, and server-side fallback does not retry that. Reasoning stays in
thinking blocks; a schema the model fills never has a field for it.
"""
import inspect

from pydantic import BaseModel

from app.services.llm import schemas

REASONING_FIELDS = {"analysis", "reasoning", "thinking", "scratchpad", "chain_of_thought", "trace"}

# v1 schemas that still carry the field; each is replaced by its V2 class behind PROMPTS_V2 and is
# deleted with the v1 prompts. Nothing may be added to this list.
V1_WITH_ANALYSIS = {"PracticeTutorReply", "ReaderTutorReply", "ReaderCheckReply", "RecallGradeResult"}


def _models():
    return [
        cls
        for name, cls in inspect.getmembers(schemas, inspect.isclass)
        if issubclass(cls, BaseModel) and cls.__module__ == schemas.__name__
    ]


def _field_names(schema: dict) -> set[str]:
    names = set(schema.get("properties", {}))
    for definition in schema.get("$defs", {}).values():
        names |= set(definition.get("properties", {}))
    return names


def test_no_schema_asks_the_model_for_its_reasoning():
    offenders = {}
    for cls in _models():
        if cls.__name__ in V1_WITH_ANALYSIS:
            continue
        found = _field_names(cls.model_json_schema()) & REASONING_FIELDS
        if found:
            offenders[cls.__name__] = sorted(found)
    assert offenders == {}, f"Reasoning fields in model-facing schemas: {offenders}"


def test_the_v1_exceptions_each_have_a_v2_without_the_field():
    for name in V1_WITH_ANALYSIS:
        v2 = getattr(schemas, f"{name}V2")
        assert not _field_names(v2.model_json_schema()) & REASONING_FIELDS, name

"""Describe a pydantic validation error without the values that failed.

Pydantic's own message prints each input, which can be a secret, a student's answer or a model
reply. Error text is logged, stored on jobs and shown in the UI, so it names fields and reasons only.
"""
from __future__ import annotations

from pydantic import ValidationError


def describe_validation_error(exc: ValidationError) -> str:
    """"field.path: reason; …" for each error, with no input values."""
    parts = []
    for error in exc.errors(include_url=False, include_input=False, include_context=False):
        where = ".".join(str(part) for part in error.get("loc", ())) or "(root)"
        parts.append(f"{where}: {error.get('msg', 'invalid')}")
    return "; ".join(parts)

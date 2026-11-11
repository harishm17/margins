"""What reaches the logs: secrets redacted, exceptions written as `ClassName(code)` (SEC-L3, OPS-M6).

Server logs are kept by the host for about a week and read by people who are not the student. They may hold ids,
counts and error types; they must not hold what a student wrote or what a model said. Exception text is the usual
way that leaks (a database error echoes the row, a provider error echoes the request, a ValueError echoes the answer),
so one filter, installed on the handlers rather than the loggers (a logger-level filter does not see records
propagated from child loggers), rewrites every record on its way out:

- secrets in the message and arguments are redacted;
- an exception in the arguments (`logger.warning("failed: %s", exc)`) becomes `ClassName(code)`;
- an attached traceback keeps its frames, and its message line becomes `ClassName(code)`.

`app/errors.py` says what the code is. Log calls themselves are linted (tests/test_logging_lint.py): the message is
a plain string, never built from values, and no argument is `str(exc)` or `repr(exc)`.
"""
from __future__ import annotations

import logging
import re
import sys
import traceback
from types import TracebackType
from typing import Any

from app.config import settings
from app.errors import describe_exception

_SECRET_TOKEN_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(Bearer\s+)[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE),
]


def _redact_text(value: str) -> str:
    redacted = value

    # Redact known configured secrets first.
    for secret in (settings.ANTHROPIC_API_KEY, settings.OPENAI_API_KEY, settings.AI_INTERNAL_TOKEN):
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")

    # Redact token-like strings.
    for pattern in _SECRET_TOKEN_PATTERNS:
        if "Bearer" in pattern.pattern:
            redacted = pattern.sub(r"\1[REDACTED]", redacted)
        else:
            redacted = pattern.sub("sk-[REDACTED]", redacted)

    return redacted


def _scrub_object(value: Any) -> Any:
    """Redact strings and write exceptions as `ClassName(code)`, through tuples, lists and dicts."""
    if isinstance(value, BaseException):
        return _redact_text(describe_exception(value))
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, tuple):
        return tuple(_scrub_object(item) for item in value)
    if isinstance(value, list):
        return [_scrub_object(item) for item in value]
    if isinstance(value, dict):
        return {key: _scrub_object(item) for key, item in value.items()}
    return value


def scrubbed_traceback(exc: BaseException, tb: TracebackType | None = None, _seen: set[int] | None = None) -> str:
    """The traceback of `exc` with every frame kept and every exception's message line replaced by
    `ClassName(code)`, following __cause__ and __context__ as the standard format does."""
    seen = _seen if _seen is not None else set()
    seen.add(id(exc))
    lines: list[str] = []
    cause = exc.__cause__ or (None if exc.__suppress_context__ else exc.__context__)
    if cause is not None and id(cause) not in seen:
        lines.append(scrubbed_traceback(cause, cause.__traceback__, seen))
        lines.append(
            "\nThe above exception was the direct cause of the following exception:\n\n"
            if exc.__cause__ is not None
            else "\nDuring handling of the above exception, another exception occurred:\n\n"
        )
    frames = tb if tb is not None else exc.__traceback__
    if frames is not None:
        lines.append("Traceback (most recent call last):\n")
        lines.extend(traceback.format_tb(frames))
    lines.append(describe_exception(exc) + "\n")
    return "".join(lines)


class LogScrubFilter(logging.Filter):
    """Installed on handlers (see configure_logging): redacts secrets and keeps exception text out of every record."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        if getattr(record, "scrubbed", False):  # one record passes several handlers
            return True
        record.scrubbed = True
        if isinstance(record.msg, BaseException):
            record.msg = describe_exception(record.msg)
        if isinstance(record.msg, str):
            record.msg = _redact_text(record.msg)
        if record.args:
            record.args = _scrub_object(record.args)
        exc_info = record.exc_info
        if exc_info and exc_info is not True and exc_info[1] is not None:
            record.exc_text = _redact_text(scrubbed_traceback(exc_info[1], exc_info[2])).rstrip("\n")
            record.exc_info = None
        elif record.exc_text:
            # Formatted before this filter ran (another handler's formatter): its message line is unknown, drop it.
            record.exc_text = "(traceback withheld)"
        if record.stack_info:
            record.stack_info = _redact_text(record.stack_info)
        return True


_HANDLER_LOGGERS = ("", "uvicorn", "uvicorn.error", "uvicorn.access")


def configure_logging() -> None:
    """Put the scrub filter on the root handler and on uvicorn's handlers. Safe to call again.

    The root logger gets a stderr handler when it has none (uvicorn configures only its own loggers), so the
    application's records always pass through a handler that scrubs them.

    The service's own loggers (`app.*`) write from INFO up: the root logger is left at WARNING, which dropped the
    start-up lines and the per-call cost lines. Libraries keep the root's level.
    """
    root = logging.getLogger()
    own = logging.getLogger("app")
    if own.level == logging.NOTSET:
        own.setLevel(logging.INFO)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
    for name in _HANDLER_LOGGERS:
        for handler in logging.getLogger(name).handlers:
            if not any(isinstance(existing, LogScrubFilter) for existing in handler.filters):
                handler.addFilter(LogScrubFilter())

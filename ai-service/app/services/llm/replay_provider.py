"""Record a real run's model calls once, then replay them for free (LLM_PROVIDER=replay).

The workflow suite (frontend/tests/workflows) drives the whole app through a browser. Its first run
records every model call against the real API; later runs replay the recordings, so the suite can
run as often as needed without spending.

A request is matched by its content with the volatile parts taken out: ids, emails and dates become
numbered placeholders in order of first appearance (`⟨id1⟩`, `⟨email1⟩`, `⟨date1⟩`), so a fresh user
with new ids still matches the recording. Answers are stored with the same placeholders and filled
with the new request's values on replay, so an answer that names a topic id names the new topic.

- The same request made several times replays its recorded answers in order (a regenerated quiz gets
  the second set), then repeats the last.
- With LLM_REPLAY_MISS=error, a request with no exact recording replays the nearest recording of the
  same call (same method, purpose and schema) when they share at least half their word triples, and
  otherwise fails with LLMReplayMissError. With LLM_REPLAY_MISS=record, it calls the real model and
  stores the answer.
- Replayed calls report the recorded token usage, so the allowance and the cost ledger behave as they
  did when recorded.
- Failed calls are not recorded.

Recordings hold the course's text, so they live outside the repository (LLM_CASSETTE_DIR). Refused in
production.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Type

from pydantic import BaseModel, ValidationError

from app.services.llm.base import (
    AnswerCitation,
    AnswerDone,
    AnswerEvent,
    AnswerReset,
    AnswerText,
    Excerpt,
    LLMError,
    LLMMessage,
    LLMNotConfiguredError,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    SchemaT,
    TurnDone,
    TurnEvent,
    TurnText,
    TurnToolUse,
)
from app.services.llm.models import resolve_model
from app.services.llm.usage import record_usage, track_llm_usage

logger = logging.getLogger(__name__)

NEAR_MATCH_MIN = 0.5

_VOLATILE = re.compile(
    r"(?P<id>\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b)"
    r"|(?P<email>\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b)"
    r"|(?P<date>\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)"
)
_PLACEHOLDER = re.compile(r"⟨(?:id|email|date)\d+⟩")

_ANSWER_EVENTS: Dict[str, Type[BaseModel]] = {"text": AnswerText, "citation": AnswerCitation, "reset": AnswerReset, "done": AnswerDone}
_TURN_EVENTS: Dict[str, Type[BaseModel]] = {"text": TurnText, "tool_use": TurnToolUse, "done": TurnDone}


class LLMReplayMissError(LLMError):
    """No recording for this request. Not retried: the same request misses again."""

    code = "LLM_REPLAY_MISS"
    retryable = False


def normalise(text: str, found: Optional[Dict[str, str]] = None) -> Tuple[str, Dict[str, str]]:
    """Replace ids, emails and dates with numbered placeholders.

    Returns the text and the placeholders it used ({placeholder: original}). Pass `found` to continue
    numbering across several texts of one request. Ids compare case-insensitively.
    """
    found = {} if found is None else found
    by_value = {value.lower(): placeholder for placeholder, value in found.items()}
    counts: Dict[str, int] = {}
    for placeholder in found:
        kind = placeholder[1:].rstrip("⟩").rstrip("0123456789")
        counts[kind] = counts.get(kind, 0) + 1

    def swap(match: re.Match) -> str:
        kind = match.lastgroup or "id"
        value = match.group(0)
        key = value.lower()
        if key not in by_value:
            counts[kind] = counts.get(kind, 0) + 1
            placeholder = f"⟨{kind}{counts[kind]}⟩"
            by_value[key] = placeholder
            found[placeholder] = value
        return by_value[key]

    return _VOLATILE.sub(swap, text), found


def _with_placeholders(text: str, found: Dict[str, str]) -> str:
    """An answer's text with the request's values put back as placeholders (other values are kept)."""
    by_value = {value.lower(): placeholder for placeholder, value in found.items()}
    return _VOLATILE.sub(lambda m: by_value.get(m.group(0).lower(), m.group(0)), text)


def _filled(text: str, values: Dict[str, str], fallback: Dict[str, str]) -> str:
    """A recorded answer's placeholders filled with this request's values (the recorded ones if it has none)."""
    return _PLACEHOLDER.sub(lambda m: values.get(m.group(0), fallback.get(m.group(0), m.group(0))), text)


def _shingles(text: str) -> set:
    words = re.findall(r"\w+|[^\w\s]", text.lower())
    return {" ".join(words[i : i + 3]) for i in range(max(len(words) - 2, 1))}


class _Request:
    """One call, normalised: its key, its placeholder values and the text used for near matches."""

    def __init__(self, method: str, purpose: str, schema: str, body: Dict[str, Any]):
        self.method, self.purpose, self.schema = method, purpose, schema
        raw = json.dumps(body, sort_keys=True, ensure_ascii=False)
        self.text, self.values = normalise(raw)
        self.key = hashlib.sha256(f"{method}\n{purpose}\n{schema}\n{self.text}".encode()).hexdigest()

    @property
    def group(self) -> Tuple[str, str, str]:
        return (self.method, self.purpose, self.schema)

    def describe(self) -> str:
        what = f"{self.method} purpose={self.purpose}"
        return f"{what} schema={self.schema}" if self.schema else what


class _Entry:
    def __init__(self, path: Path, data: Dict[str, Any]):
        self.path = path
        self.data = data
        self._shingles: Optional[set] = None

    @property
    def group(self) -> Tuple[str, str, str]:
        return (self.data["method"], self.data["purpose"], self.data.get("schema") or "")

    @property
    def shingles(self) -> set:
        if self._shingles is None:
            self._shingles = _shingles(self.data["request"])
        return self._shingles


class ReplayProvider(LLMProvider):
    def __init__(self, cassette_dir: Path | str, *, on_miss: str = "error", inner: Optional[LLMProvider] = None):
        if on_miss not in ("error", "record"):
            raise LLMNotConfiguredError(f"LLM_REPLAY_MISS must be error or record, not {on_miss!r}")
        if on_miss == "record" and inner is None:
            raise LLMNotConfiguredError("LLM_REPLAY_MISS=record needs the real model (ANTHROPIC_API_KEY)")
        self.dir = Path(cassette_dir)
        self.on_miss = on_miss
        self.inner = inner
        self._entries: Dict[str, _Entry] = {}
        self._served: Dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        if not self.dir.exists():
            return
        for path in sorted(self.dir.rglob("*.json")):
            try:
                data = json.loads(path.read_text())
                self._entries[data["key"]] = _Entry(path, data)
            except (OSError, ValueError, KeyError):
                logger.warning("replay: skipped unreadable recording %s", path)
        logger.info("replay: %d recordings loaded from %s (on miss: %s)", len(self._entries), self.dir, self.on_miss)

    def model_for(self, purpose: str) -> Optional[str]:
        return resolve_model(purpose).model

    # -- lookup and storage -------------------------------------------------------------------

    def _nearest(self, request: _Request) -> Tuple[Optional[_Entry], float]:
        wanted = _shingles(request.text)
        best, best_score = None, 0.0
        for entry in self._entries.values():
            if entry.group != request.group:
                continue
            union = len(wanted | entry.shingles)
            score = len(wanted & entry.shingles) / union if union else 0.0
            if score > best_score:
                best, best_score = entry, score
        return best, best_score

    def _next_answer(self, entry: _Entry) -> Dict[str, Any]:
        """The next recorded answer for this entry; the last one again once they are used up."""
        responses = entry.data["responses"]
        served = self._served.get(entry.data["key"], 0)
        self._served[entry.data["key"]] = served + 1
        return responses[min(served, len(responses) - 1)]

    def _find(self, request: _Request) -> Optional[Tuple[_Entry, Dict[str, Any]]]:
        """The answer to replay, or None when the real model must be called (record mode)."""
        entry = self._entries.get(request.key)
        if entry is not None:
            served = self._served.get(request.key, 0)
            if self.on_miss == "record" and served >= len(entry.data["responses"]):
                return None
            logger.info("replay hit %s key=%s", request.describe(), request.key[:12])
            return entry, self._next_answer(entry)
        if self.on_miss == "record":
            return None
        near, score = self._nearest(request)
        if near is not None and score >= NEAR_MATCH_MIN:
            logger.info("replay near match %s key=%s score=%.2f -> %s", request.describe(), request.key[:12], score, near.path.name)
            return near, self._next_answer(near)
        detail = f"; nearest shares {score:.2f}" if near is not None else ""
        raise LLMReplayMissError(f"No recording for {request.describe()} (key {request.key[:12]}{detail})")

    def _store(self, request: _Request, answer: Dict[str, Any]) -> None:
        entry = self._entries.get(request.key)
        if entry is None:
            path = self.dir / request.method / (request.purpose or "none") / f"{request.key[:24]}.json"
            entry = _Entry(path, {
                "key": request.key,
                "method": request.method,
                "purpose": request.purpose,
                "schema": request.schema,
                "request": request.text,
                "recorded_values": request.values,
                "responses": [],
            })
            self._entries[request.key] = entry
        entry.data["responses"].append(answer)
        self._served[request.key] = len(entry.data["responses"])
        entry.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=entry.path.parent, suffix=".tmp")
        with os.fdopen(fd, "w") as handle:
            json.dump(entry.data, handle, ensure_ascii=False, indent=1)
        os.replace(tmp, entry.path)
        logger.info("replay recorded %s key=%s answer=%d", request.describe(), request.key[:12], len(entry.data["responses"]))

    @staticmethod
    def _encode(request: _Request, value: Any) -> Any:
        return json.loads(_with_placeholders(json.dumps(value, ensure_ascii=False), request.values))

    @staticmethod
    def _decode(request: _Request, entry: _Entry, value: Any) -> Any:
        recorded = entry.data.get("recorded_values") or {}
        return json.loads(_filled(json.dumps(value, ensure_ascii=False), request.values, recorded))

    @staticmethod
    def _replay_usage(usages: List[Dict[str, Any]]) -> None:
        for usage in usages:
            record_usage(LLMUsage.model_validate(usage))

    # -- the provider interface ------------------------------------------------------------------

    @staticmethod
    def _message_body(messages: List[LLMMessage]) -> Dict[str, Any]:
        return {"messages": [{"role": m.role, "content": m.content} for m in messages]}

    async def generate_text(self, messages: List[LLMMessage], *, purpose: str, max_tokens: int = 16000) -> LLMResponse:
        request = _Request("text", purpose, "", self._message_body(messages))
        found = self._find(request)
        if found is not None:
            entry, answer = found
            self._replay_usage(answer["usage"])
            return LLMResponse.model_validate(self._decode(request, entry, answer["result"]))
        with track_llm_usage() as usages:
            response = await self.inner.generate_text(messages, purpose=purpose, max_tokens=max_tokens)
        for usage in usages:
            record_usage(usage)
        self._store(request, {"result": self._encode(request, response.model_dump(mode="json")), "usage": [u.model_dump() for u in usages]})
        return response

    async def generate_structured(
        self, messages: List[LLMMessage], schema: Type[SchemaT], *, purpose: str, max_tokens: int = 16000
    ) -> SchemaT:
        request = _Request("structured", purpose, schema.__name__, self._message_body(messages))
        found = self._find(request)
        if found is not None:
            entry, answer = found
            try:
                result = schema.model_validate(self._decode(request, entry, answer["result"]))
            except ValidationError as exc:
                raise LLMReplayMissError(f"The recording for {request.describe()} no longer fits {schema.__name__}") from exc
            self._replay_usage(answer["usage"])
            return result
        with track_llm_usage() as usages:
            result = await self.inner.generate_structured(messages, schema, purpose=purpose, max_tokens=max_tokens)
        for usage in usages:
            record_usage(usage)
        self._store(request, {"result": self._encode(request, result.model_dump(mode="json")), "usage": [u.model_dump() for u in usages]})
        return result

    async def stream_cited_answer(
        self,
        *,
        system: str,
        history: List[LLMMessage],
        question: str,
        excerpts: List[Excerpt],
        max_tokens: int = 4000,
        purpose: str = "chat",
    ) -> AsyncIterator[AnswerEvent]:
        body = {
            "system": system,
            "history": [{"role": m.role, "content": m.content} for m in history],
            "question": question,
            "excerpts": [e.model_dump() for e in excerpts],
        }
        request = _Request("cited_answer", purpose, "", body)
        found = self._find(request)
        if found is not None:
            entry, answer = found
            for raw in self._decode(request, entry, answer["events"]):
                event = _ANSWER_EVENTS[raw["type"]].model_validate(raw)
                if isinstance(event, AnswerDone):
                    record_usage(event.usage)
                yield event
            return
        events: List[Dict[str, Any]] = []
        async for event in self.inner.stream_cited_answer(
            system=system, history=history, question=question, excerpts=excerpts, max_tokens=max_tokens, purpose=purpose
        ):
            events.append(event.model_dump(mode="json"))
            yield event
        self._store(request, {"events": self._encode(request, events)})

    async def stream_turn(
        self,
        *,
        system: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        max_tokens: int = 800,
        purpose: str = "voice",
    ) -> AsyncIterator[TurnEvent]:
        body = {"system": system, "messages": messages, "tools": sorted(t.get("name", "") for t in tools)}
        request = _Request("turn", purpose, "", body)
        found = self._find(request)
        if found is not None:
            entry, answer = found
            for raw in self._decode(request, entry, answer["events"]):
                event = _TURN_EVENTS[raw["type"]].model_validate(raw)
                if isinstance(event, TurnDone):
                    record_usage(event.usage)
                yield event
            return
        events: List[Dict[str, Any]] = []
        async for event in self.inner.stream_turn(system=system, messages=messages, tools=tools, max_tokens=max_tokens, purpose=purpose):
            events.append(event.model_dump(mode="json"))
            yield event
        self._store(request, {"events": self._encode(request, events)})

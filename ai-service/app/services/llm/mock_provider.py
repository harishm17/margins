"""Placeholder provider for local runs and end-to-end tests: no API calls, no cost."""
import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Type

from app.services.llm.base import (
    LLMAuthError,
    LLMCreditError,
    LLMError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMUnavailableError,
    AnswerCitation,
    AnswerDone,
    AnswerEvent,
    AnswerText,
    Excerpt,
    LLMMessage,
    LLMOutputError,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    SchemaT,
    TurnDone,
    TurnEvent,
    TurnText,
    TurnToolUse,
)
from app.config import settings
from app.services.llm.limiter import llm_slot
from app.services.llm.models import PURPOSES
from app.services.llm.usage import record_usage

logger = logging.getLogger(__name__)

MOCK_NOTES = """# Study notes (mock)

## Overview
This is placeholder text: the sections below follow the lesson format the real notes use.

## What you'll learn
- Tell what the mock provider does and does not do.
- Find where to switch to a real model.

## The idea
LLM_PROVIDER is set to `mock`, so these notes were not written by a model. They stand in
for real notes so that the rest of the app can be exercised without an API key or any cost.

## Key concepts
- Upload, validation, chunking, embedding and retrieval ran for real on your files.
- The course plan, quizzes, exams and grading return placeholder output.
- Every job still goes through the real job runner, so retries, leases and usage tracking work.

## Worked example
The mock provider returns a fixed example for each output schema and this text for notes.
It records zero token usage, so the daily budget is never reached.

## Check yourself
```check
Q: Which setting turns the mock provider on?
A: Set `LLM_PROVIDER=mock`.
```

## Common pitfalls
- Placeholder questions are the same for every topic.
- Short answers are always graded zero.

## Summary
- Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to generate real content.
- Run `scripts/reembed_chunks.py` after changing the embedding model.
"""


def _first_paragraph(text: str) -> str:
    """The first paragraph that is more than a heading line, or the first one."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    for paragraph in paragraphs:
        if not paragraph.startswith("#") or "\n" in paragraph:
            return paragraph
    return paragraphs[0] if paragraphs else text.strip()


def _first_sentence(text: str, limit: int = 220) -> str:
    body = "\n".join(line for line in _first_paragraph(text).splitlines() if not line.startswith("#"))
    flat = re.sub(r"\s+", " ", body or text).strip()
    match = re.search(r"[.!?](\s|$)", flat)
    sentence = flat[: match.end()].strip() if match else flat
    return sentence if len(sentence) <= limit else sentence[: limit - 1].rstrip() + "..."


def _blocks(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [block for block in content or [] if isinstance(block, dict)]


def _tool_calls(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every tool_use block in the conversation, oldest first."""
    return [
        block
        for message in messages
        if message.get("role") == "assistant"
        for block in _blocks(message)
        if block.get("type") == "tool_use"
    ]


def _latest_question_index(messages: List[Dict[str, Any]], call: Dict[str, Any], default: int) -> int:
    """The question_index in the tool result for `call` (a get_next_question), or `default`."""
    for message in messages:
        for block in _blocks(message):
            if block.get("type") == "tool_result" and block.get("tool_use_id") == call.get("id"):
                content = block.get("content")
                if isinstance(content, list):
                    content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                try:
                    index = json.loads(content or "{}").get("question_index")
                except (TypeError, ValueError, AttributeError):
                    return default
                return index if isinstance(index, int) else default
    return default


APP_RESULT = re.compile(r'<app_result step="([a-z_]+)">(.*?)</app_result>', re.DOTALL)


def _app_result(blocks: List[Dict[str, Any]]) -> Optional[tuple[str, Dict[str, Any]]]:
    """(step, result) from an <app_result> in the student's message, or None."""
    for block in blocks:
        if block.get("type") != "text":
            continue
        match = APP_RESULT.search(block.get("text", ""))
        if match:
            try:
                parsed = json.loads(match.group(2).replace("<\\/app_result", "</app_result"))
            except ValueError:
                return None
            return match.group(1), parsed if isinstance(parsed, dict) else {}
    return None


def _tool_result_json(messages: List[Dict[str, Any]], call: Dict[str, Any]) -> Dict[str, Any]:
    """The parsed result of a tool call, or {} when it has none or is not JSON."""
    for message in messages:
        for block in _blocks(message):
            if block.get("type") == "tool_result" and block.get("tool_use_id") == call.get("id"):
                content = block.get("content")
                if isinstance(content, list):
                    content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                try:
                    parsed = json.loads(content or "{}")
                except (TypeError, ValueError):
                    return {}
                return parsed if isinstance(parsed, dict) else {}
    return {}


def _teach_reply(name: Optional[str], output: Dict[str, Any]) -> str:
    """What the scripted teach-back coach says to a tool's result (or to the same result the app attached to the student's words)."""
    if output.get("done") is True:
        return "That was every idea. Well done, and goodbye."
    if name == "get_concept_to_explain":
        return "Explain it to me as if I were a classmate who has not read it."
    action = output.get("action")
    if action == "probe":
        return f"Mock probe {output.get('probe', {}).get('number', 1)}: what exactly do you mean by that?"
    if action == "explain":
        return "Mock explanation from your pages. Now say it back in your own words."
    if action == "explain_first":
        return "That is fine, it is not there yet. Mock explain first: here is the idea from your pages. Now say it back in your own words."
    if action == "ask_new_example":
        return "Mock example: what happens in a new case?"
    if action == "clarify":
        return str(output.get("clarifying_question") or "Can you say a little more?")
    if action == "wrap_up":
        return "Mock wrap-up. Let's take the next idea."
    return "Okay."


def _teach_turn(messages, tools, calls, results, utterance, app=None) -> tuple[str, Optional[Dict[str, Any]]]:
    """Teach it back, scripted: ask for an idea, assess each explanation, follow the action the tool returns."""
    names = [call.get("name") for call in calls]
    if app is not None:
        return _teach_reply(app[0], app[1]), None
    if results:
        call = {c.get("id"): c for c in calls}.get(results[-1].get("tool_use_id"), {})
        return _teach_reply(call.get("name"), _tool_result_json(messages, call)), None
    if "get_concept_to_explain" not in names:
        return "", {"name": "get_concept_to_explain", "input": {}}
    last = calls[-1]
    last_output = _tool_result_json(messages, last)
    concept_id = next(
        (_tool_result_json(messages, c).get("concept_id") for c in reversed(calls) if c.get("name") == "get_concept_to_explain" and _tool_result_json(messages, c).get("concept_id")),
        "",
    )
    if last.get("name") == "assess_explanation" and last_output.get("action") == "wrap_up":
        return "", {"name": "get_concept_to_explain", "input": {}}
    if last.get("name") == "assess_explanation" and last_output.get("action") == "ask_new_example":
        return "", {"name": "record_check", "input": {"concept_id": concept_id, "question": "Mock example: what happens in a new case?", "answer": utterance or "no answer"}}
    if last.get("name") == "record_check" and last_output.get("action") != "probe":
        return "", {"name": "get_concept_to_explain", "input": {}}
    return "", {"name": "assess_explanation", "input": {"concept_id": concept_id, "explanation": utterance or "no answer"}}


def _reading_reply(name: Optional[str], output: Dict[str, Any]) -> str:
    """What the scripted guided-reading coach says to a tool's result (or to the same result attached to the student's words)."""
    if output.get("done") is True:
        return "That was every claim. Well done, and goodbye."
    if name == "next_claim" and "claim" in output:
        return "Mock claim from your pages. Here is a check question."
    if name == "next_claim":
        return "What do you expect your pages say about this idea?"
    if name == "record_check":
        return str(output.get("clarifying_question") or "Mock feedback on your check answer.")
    return "Okay."


def _reading_turn(messages, tools, calls, results, utterance, app=None) -> tuple[str, Optional[Dict[str, Any]]]:
    """Guided reading, scripted: predict, then the claim, then the check, claim after claim."""
    if app is not None:
        return _reading_reply(app[0], app[1]), None
    if results:
        call = {c.get("id"): c for c in calls}.get(results[-1].get("tool_use_id"), {})
        return _reading_reply(call.get("name"), _tool_result_json(messages, call)), None
    if not calls:
        return "", {"name": "next_claim", "input": {}}
    last = calls[-1]
    output = _tool_result_json(messages, last)
    if last.get("name") == "record_check" and output.get("action") != "clarify":
        return "", {"name": "next_claim", "input": {}}
    if last.get("name") == "next_claim" and "claim" not in output and output.get("done") is not True:
        return "", {"name": "next_claim", "input": {"reveal": True, "prediction": utterance or "no idea", "check_question": "Mock check question?"}}
    index = output.get("claim_index", 0) if "claim" in output else 0
    return "", {"name": "record_check", "input": {"claim_index": index, "answer": utterance or "no answer"}}


def _mock_turn(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> tuple[str, Optional[Dict[str, Any]]]:
    """(text, tool call) for the next reply: deterministic, driven only by the conversation.

    With tools: the first turn asks for a question (get_next_question); the next plain user
    message is treated as the answer (record_answer for the latest question); a tool result is
    answered with one short sentence. Without tools it is a short scripted reply.
    """
    last = _blocks(messages[-1]) if messages else []
    results = [block for block in last if block.get("type") == "tool_result"]
    available = {tool.get("name") for tool in tools}
    calls = _tool_calls(messages)
    # A step the app already ran for the student's words arrives in their message as <app_result step="...">json</app_result>.
    app = _app_result(last)
    utterance_text = " ".join(
        APP_RESULT.sub("", block.get("text", "")) for block in last if block.get("type") == "text"
    ).strip()
    if "get_concept_to_explain" in available:
        return _teach_turn(messages, tools, calls, results, utterance_text, app)
    if "next_claim" in available:
        return _reading_turn(messages, tools, calls, results, utterance_text, app)
    if app is not None and app[0] == "record_answer":
        return "Thanks, I have noted that. Say next when you are ready for another question.", None

    if results:
        called = {call.get("id"): call for call in calls}
        call = called.get(results[-1].get("tool_use_id"), {})
        name = call.get("name")
        output = str(results[-1].get("content") or "")
        if '"done": true' in output or '"done":true' in output:
            return "That was the last question. Well done, and goodbye.", None
        if name == "get_next_question":
            return "Here is your question. Take your time and answer out loud.", None
        if name == "record_answer":
            return "Thanks, I have noted that. Say next when you are ready for another question.", None
        if name == "get_hint":
            if '"ask_for_try"' in output:
                return "Have a go first, even a rough one, and then I can nudge you.", None
            return "Here is a nudge. Think about how the key ideas connect.", None
        return "Okay.", None

    utterance = " ".join(block.get("text", "") for block in last if block.get("type") == "text").strip()
    if "get_next_question" in available:
        asked = [call for call in calls if call.get("name") == "get_next_question"]
        # An answer the app recorded before the model spoke counts like one the model recorded.
        app_recorded = sum(
            1
            for message in messages
            if message.get("role") == "user" and (_app_result(_blocks(message)) or ("",))[0] == "record_answer"
        )
        recorded = [call for call in calls if call.get("name") == "record_answer"] + [{}] * app_recorded
        if asked and len(recorded) < len(asked):
            return "", {
                "name": "record_answer",
                "input": {"question_index": _latest_question_index(messages, asked[-1], len(recorded)),
                          "user_answer": utterance or "no answer"},
            }
        return "", {"name": "get_next_question", "input": {}}
    if utterance and not utterance.startswith("["):
        return f"Mock coach here. You said: {utterance[:80]}. Tell me more.", None
    return "Hi, I am your mock coach. What would you like to talk about?", None


# End-to-end tests make the mock fail like the real API by putting "MOCK_LLM_FAIL:<code>" in a
# prompt (a question, a topic name, an answer). "MOCK_LLM_FAIL:<code>x<n>@<id>" fails only the
# first n calls that carry it, then the "outage" is over: a test can watch the app catch up.
# Only the mock reads it; the real provider never sees it.
_FAILURE_MARKER = re.compile(r"MOCK_LLM_FAIL:([A-Z_]+?)(?:x(\d+)@([A-Za-z0-9_-]+))?(?![A-Z_])")
_failures_left: Dict[str, int] = {}
_SIMULATED_FAILURES: Dict[str, type] = {
    LLMCreditError.code: LLMCreditError,
    LLMAuthError.code: LLMAuthError,
    LLMRateLimitError.code: LLMRateLimitError,
    LLMUnavailableError.code: LLMUnavailableError,
    LLMRefusalError.code: LLMRefusalError,
    LLMOutputError.code: LLMOutputError,
}


_V2_MODE_MARKERS = {
    "entry_points": "The question is broad",
    "commit": "has not yet said what they think",
    "explain_short": "said twice that they do not know",
    "explain": "",
}


def _turn_situation(system: str, question: str) -> Optional[str]:
    """The text that holds the turn's situation: the system prompt (v1), or the end of the user message after
    <student_message> (PROMPTS_V2=ask, where the system is the same for every turn). None for a plain lookup."""
    tail = question.rsplit("</student_message>", 1)[-1] if "</student_message>" in question else ""
    if "<situation>" in tail:
        intent = re.search(r"Intent: (\w+)\.", tail)
        if intent is None or intent.group(1) in ("lookup", "logistics"):
            return None
        mode = re.search(r"Mode: (\w+)\.", tail)
        # Put the v1 marker sentence of the mode beside the block, so one reader serves both layouts.
        return tail + "\n" + (_V2_MODE_MARKERS.get(mode.group(1), "") if mode else "")
    return system if "<situation>" in system and re.search(r"^Intent: \w+\.$", system, re.M) else None


def _tutoring_parts(
    system: str, excerpts: List[Excerpt], question: str = ""
) -> Optional[List[tuple[str, Optional[Excerpt]]]]:
    """The mock's reply to a tutoring turn, read from the situation block (of the system prompt, or of the user
    message under PROMPTS_V2=ask): a question back before an explanation, an explanation that ends with a check
    question card, a request for the student's attempt. None for a plain lookup."""
    system = _turn_situation(system, question)
    if system is None:
        return None
    if "Intent: understand." in system:
        if "The question is broad" in system:
            block = re.search(r"<entry_points>\n(.*?)\n</entry_points>", system, re.DOTALL)
            names = [line[2:].strip() for line in (block.group(1) if block else "").splitlines() if line.startswith("- ")]
            return [(f"This covers several ideas. Where would you like to start: {', '.join(names[:3])}? (mock)", None)]
        if "has not yet said what they think" in system:
            return [("What do you think this means? Say it in your own words first. (mock)", None)]
        sentence = _first_sentence(excerpts[0].text)
        if "said twice that they do not know" in system:
            # A short explanation after repeated non-attempts: no praise for an attempt, one sentence, then the card.
            short_card = json.dumps(
                {
                    "question": "Say the idea back in your own words.",
                    "answer": sentence,
                    "explanation": "The materials put it this way.",
                    "concept_name": "",
                }
            )
            return [
                (f"Here is the short version: {sentence}", excerpts[0]),
                (f"<check_question>{short_card}</check_question>", None),
            ]
        card = json.dumps(
            {
                "question": "In your own words, what is the key point?",
                "answer": sentence,
                "explanation": "The materials put it this way.",
                "concept_name": "",
            }
        )
        return [
            (f"You have part of it. The gap: {sentence}", excerpts[0]),
            (f"<check_question>{card}</check_question>", None),
        ]
    return [("What have you tried so far, and where does it get stuck? (mock)", None)]


def _raise_if_asked(*texts: str) -> None:
    for text in texts:
        match = _FAILURE_MARKER.search(text or "")
        if not match:
            continue
        code, times, key = match.groups()
        if times is not None:
            left = _failures_left.setdefault(key, int(times))
            if left <= 0:
                continue
            _failures_left[key] = left - 1
        error_type = _SIMULATED_FAILURES.get(code, LLMError)
        raise error_type(f"Simulated by the mock provider ({code})")


class MockProvider(LLMProvider):
    """Returns each schema's `example()` and fixed markdown, and records zero usage."""

    def model_for(self, purpose: str) -> str:
        config = PURPOSES.get(purpose)
        return f"mock-{config.fallback_tier if config else 'main'}"

    async def _simulate_call(self) -> None:
        """The model call itself, which takes MOCK_LLM_LATENCY_SECONDS (none by default). Tests
        override it to fail or to watch how many calls run at once."""
        if settings.MOCK_LLM_LATENCY_SECONDS > 0:
            await asyncio.sleep(settings.MOCK_LLM_LATENCY_SECONDS)

    async def generate_text(
        self,
        messages: List[LLMMessage],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> LLMResponse:
        _raise_if_asked(*(message.content for message in messages))
        async with llm_slot():
            await self._simulate_call()
        usage = LLMUsage(model=self.model_for(purpose), purpose=purpose)
        record_usage(usage)
        return LLMResponse(content=MOCK_NOTES, model=usage.model, stop_reason="end_turn", usage=usage)

    async def generate_structured(
        self,
        messages: List[LLMMessage],
        schema: Type[SchemaT],
        *,
        purpose: str,
        max_tokens: int = 16000,
    ) -> SchemaT:
        example = getattr(schema, "example", None)
        if example is None:
            raise LLMOutputError(f"MockProvider has no example for {schema.__name__}")
        _raise_if_asked(*(message.content for message in messages))
        async with llm_slot():
            await self._simulate_call()
        record_usage(LLMUsage(model=self.model_for(purpose), purpose=purpose))
        # A schema whose valid output depends on the request (the course planner must place the
        # sections it was given) builds its example from the prompt.
        example_for = getattr(schema, "example_for", None)
        if example_for is not None:
            return example_for("\n".join(message.content for message in messages))
        return example()

    async def stream_cited_answer(
        self,
        *,
        system: str,
        history: List[LLMMessage],
        question: str,
        excerpts: List[Excerpt],
        max_tokens: int = 4000,
        purpose: str = "chat",
        cache_system: bool = False,
    ) -> AsyncIterator[AnswerEvent]:
        """A fixed-shape answer that quotes the first two excerpts and cites each."""
        if not excerpts:
            raise LLMOutputError("The mock provider needs at least one excerpt")
        _raise_if_asked(question)
        async with llm_slot():  # the wait for the first token
            await self._simulate_call()
        parts = _tutoring_parts(system, excerpts, question)
        if parts is None:
            parts = [(f"Mock answer to \"{question[:80]}\" (LLM_PROVIDER is mock, no model was called). ", None)]
            for index, excerpt in enumerate(excerpts[:2]):
                lead = "The materials say: " if index == 0 else " It also covers: "
                parts.append((f"{lead}{_first_sentence(excerpt.text)}", excerpt))

        text = ""
        citations: List[AnswerCitation] = []
        for chunk, excerpt in parts:
            for word in re.findall(r"\s*\S+\s*", chunk):
                text += word
                yield AnswerText(text=word)
                await asyncio.sleep(0.005)
            if excerpt is not None:
                citation = AnswerCitation(
                    ref=excerpt.ref,
                    cited_text=_first_paragraph(excerpt.text),
                    start_block_index=0,
                    end_block_index=1,
                    offset=len(text),
                )
                citations.append(citation)
                yield citation

        usage = LLMUsage(model=self.model_for(purpose), purpose=purpose)
        record_usage(usage)
        yield AnswerDone(text=text, citations=citations, stop_reason="end_turn", usage=usage)

    async def stream_turn(
        self,
        *,
        system: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        max_tokens: int = 800,
        purpose: str = "voice",
    ) -> AsyncIterator[TurnEvent]:
        """A scripted reply (see _mock_turn). Reports a few nominal tokens, at no cost."""
        _raise_if_asked(system, json.dumps(messages))
        async with llm_slot():  # the wait for the first token
            await self._simulate_call()
        text, call = _mock_turn(messages, tools)
        content: List[Dict[str, Any]] = []
        if text:
            for word in re.findall(r"\s*\S+\s*", text):
                yield TurnText(text=word)
                await asyncio.sleep(0.005)
            content.append({"type": "text", "text": text})
        if call is not None:
            tool_id = f"toolu_mock_{sum(1 for m in messages if m.get('role') == 'assistant') + 1}"
            content.append({"type": "tool_use", "id": tool_id, "name": call["name"], "input": call["input"]})
            yield TurnToolUse(id=tool_id, name=call["name"], input=call["input"])

        # Nominal counts so the usage ledger gets a row; the model name is unpriced, so it costs $0.
        usage = LLMUsage(model=self.model_for(purpose), purpose=purpose, input_tokens=100, output_tokens=20)
        record_usage(usage)
        yield TurnDone(
            stop_reason="tool_use" if call is not None else "end_turn", content=content, usage=usage
        )

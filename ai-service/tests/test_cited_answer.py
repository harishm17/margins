"""Cited answers: the search_result request, citation events and error handling.

A fake streaming client replays events built from the SDK's own beta types, in the order the
API sends them, so the provider's handling of real event shapes is what is under test.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, List

import anthropic
import httpx2
import pytest
from anthropic.types.beta import (
    BetaCitationPageLocation,
    BetaCitationsDelta,
    BetaCitationSearchResultLocation,
    BetaRawContentBlockDeltaEvent,
    BetaRawContentBlockStartEvent,
    BetaRawContentBlockStopEvent,
    BetaTextBlock,
    BetaTextDelta,
)

from app.config import settings
from app.services.llm.anthropic_provider import AnthropicProvider, split_excerpt_blocks
from app.services.llm.base import (
    AnswerCitation,
    AnswerDone,
    AnswerReset,
    AnswerText,
    Excerpt,
    LLMMessage,
    LLMOutputError,
    LLMRefusalError,
    LLMRequestError,
    LLMUnavailableError,
)
from app.services.llm.mock_provider import MockProvider
from app.services.llm.usage import track_llm_usage

EXCERPTS = [
    Excerpt(ref="chunk:aaa", title="notes.pdf, p. 3", text="Hashing maps keys to buckets.\n\nCollisions are resolved by chaining."),
    Excerpt(ref="chunk:bbb", title="notes.pdf, p. 9", text="A heap is a complete binary tree."),
]


def text_start(index: int = 0) -> BetaRawContentBlockStartEvent:
    return BetaRawContentBlockStartEvent(
        type="content_block_start", index=index, content_block=BetaTextBlock(type="text", text="")
    )


def text_delta(text: str, index: int = 0) -> BetaRawContentBlockDeltaEvent:
    return BetaRawContentBlockDeltaEvent(
        type="content_block_delta", index=index, delta=BetaTextDelta(type="text_delta", text=text)
    )


def cite(source: str, index: int, cited: str = "quoted", start: int = 0, end: int = 1, block: int = 0):
    return BetaRawContentBlockDeltaEvent(
        type="content_block_delta",
        index=block,
        delta=BetaCitationsDelta(
            type="citations_delta",
            citation=BetaCitationSearchResultLocation(
                type="search_result_location",
                cited_text=cited,
                source=source,
                title="t",
                search_result_index=index,
                start_block_index=start,
                end_block_index=end,
            ),
        ),
    )


def final_message(stop_reason="end_turn", model="claude-opus-5-5", stop_details=None):
    return SimpleNamespace(
        model=model,
        stop_reason=stop_reason,
        stop_details=stop_details,
        usage=SimpleNamespace(
            input_tokens=1200,
            output_tokens=80,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
        ),
    )


class FakeStream:
    def __init__(self, events: List[Any], final, error: BaseException | None = None):
        self._events = events
        self._final = final
        self._error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def __aiter__(self):
        for event in self._events:
            yield event
        if self._error is not None:
            raise self._error

    async def get_final_message(self):
        return self._final


def provider_with(events, final=None, error=None) -> tuple[AnthropicProvider, list]:
    provider = AnthropicProvider(api_key="test-key")
    calls: list = []

    def stream(**params):
        calls.append(params)
        return FakeStream(events, final or final_message(), error)

    provider.client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    return provider, calls


async def collect(provider, **overrides):
    args = dict(system="Answer from the excerpts.", history=[], question="What is hashing?", excerpts=EXCERPTS)
    args.update(overrides)
    return [event async for event in provider.stream_cited_answer(**args)]


class TestRequest:
    @pytest.mark.asyncio
    async def test_excerpts_are_search_results_followed_by_the_question(self):
        provider, calls = provider_with([text_start(), text_delta("Hashing maps keys."), cite("chunk:aaa", 0)])
        await collect(provider)

        params = calls[0]
        assert params["model"] == "claude-opus-5-5"
        assert params["max_tokens"] == 4000
        assert params["system"] == [{"type": "text", "text": "Answer from the excerpts."}]
        assert params["output_config"] == {"effort": "low"}  # MODEL_CHAT: the main model at low effort
        assert params["fallbacks"] == "default"
        # Citations cannot be combined with structured outputs.
        assert "format" not in params["output_config"]

        assert len(params["messages"]) == 1
        message = params["messages"][0]
        assert message["role"] == "user"
        first, second, question = message["content"]
        assert first["type"] == "search_result"
        assert first["source"] == "chunk:aaa"
        assert first["title"] == "notes.pdf, p. 3"
        assert first["citations"] == {"enabled": True}
        assert all(block["type"] == "text" and block["text"] for block in first["content"])
        assert "Hashing maps keys to buckets." in first["content"][0]["text"]
        assert second["source"] == "chunk:bbb" and second["citations"] == {"enabled": True}
        assert question == {"type": "text", "text": "What is hashing?"}

    @pytest.mark.asyncio
    async def test_model_and_effort_come_from_model_chat(self, monkeypatch):
        monkeypatch.setattr(settings, "MODEL_CHAT", "claude-haiku-5-5:high")
        provider, calls = provider_with([text_start(), text_delta("ok")])
        await collect(provider)
        params = calls[0]
        assert params["model"] == "claude-haiku-5-5"
        assert params["output_config"] == {"effort": "high"}
        assert "fallbacks" not in params and "betas" not in params

    @pytest.mark.asyncio
    async def test_history_comes_first_as_plain_text_and_starts_with_a_user_turn(self):
        provider, calls = provider_with([text_start(), text_delta("ok")])
        history = [
            LLMMessage(role="assistant", content="stray reply"),
            LLMMessage(role="user", content="What is a heap?"),
            LLMMessage(role="assistant", content="A tree."),
        ]
        await collect(provider, history=history)
        messages = calls[0]["messages"]
        assert [m["role"] for m in messages] == ["user", "assistant", "user"]
        assert messages[0]["content"] == [{"type": "text", "text": "What is a heap?"}]
        assert messages[1]["content"] == [{"type": "text", "text": "A tree."}]
        assert [b["type"] for b in messages[2]["content"]] == ["search_result", "search_result", "text"]

    @pytest.mark.asyncio
    async def test_a_dangling_user_turn_is_merged_with_the_new_question(self):
        provider, calls = provider_with([text_start(), text_delta("ok")])
        await collect(provider, history=[LLMMessage(role="user", content="earlier question")])
        messages = calls[0]["messages"]
        assert len(messages) == 1
        assert messages[0]["content"][0] == {"type": "text", "text": "earlier question"}
        assert messages[0]["content"][-1]["text"] == "What is hashing?"

    @pytest.mark.asyncio
    async def test_no_excerpts_is_rejected(self):
        provider, _ = provider_with([])
        with pytest.raises(LLMRequestError):
            await collect(provider, excerpts=[])


HASH_INTRO = (
    "# Hash Tables\n\n"
    "A hash table stores key-value pairs in an array of buckets. A hash function maps each key "
    "to a bucket index, so lookup, insert and delete take O(1) time on average."
)
HASH_COLLISIONS = (
    "Collisions happen when two keys map to the same bucket. Separate chaining keeps a linked "
    "list of entries in each bucket. Open addressing probes for the next free slot in the array."
)
HASH_CHUNK = HASH_INTRO + "\n\n" + HASH_COLLISIONS


class TestSplitBlocks:
    def test_heading_goes_with_the_paragraph_after_it_and_paragraphs_stay_apart(self):
        assert split_excerpt_blocks(HASH_CHUNK) == [HASH_INTRO, HASH_COLLISIONS]

    def test_short_paragraphs_are_not_merged(self):
        assert split_excerpt_blocks("One.\n\nTwo.\n\nThree.") == ["One.", "Two.", "Three."]

    def test_consecutive_headings_and_a_trailing_heading(self):
        assert split_excerpt_blocks("# A\n\n## B\n\nBody.\n\n# End") == ["# A\n\n## B\n\nBody.", "# End"]

    def test_a_long_paragraph_is_split_at_sentences(self):
        text = " ".join(f"Sentence number {i} is here." for i in range(60))
        blocks = split_excerpt_blocks(text)
        assert len(blocks) > 3
        assert all(len(b) <= 600 for b in blocks)
        assert all(b.endswith(".") for b in blocks)  # cut at sentence ends only
        assert " ".join(blocks).split() == text.split()

    def test_a_paragraph_at_the_limit_is_kept_whole(self):
        paragraph = "x" * 600
        assert split_excerpt_blocks(paragraph) == [paragraph]

    def test_a_single_long_sentence_is_not_cut(self):
        sentence = ("word " * 300).strip()
        assert split_excerpt_blocks(sentence) == [sentence]

    def test_never_empty(self):
        assert split_excerpt_blocks("   ")
        assert split_excerpt_blocks("")

    @pytest.mark.asyncio
    async def test_the_hash_chunk_is_sent_as_two_blocks(self):
        provider, calls = provider_with([text_start(), text_delta("x")])
        await collect(provider, excerpts=[Excerpt(ref="chunk:h", title="notes.pdf, p. 1", text=HASH_CHUNK)])
        content = calls[0]["messages"][0]["content"][0]["content"]
        assert [b["text"] for b in content] == [HASH_INTRO, HASH_COLLISIONS]

    @pytest.mark.asyncio
    async def test_block_indices_map_to_the_paragraph_that_supports_the_claim(self):
        from app.services import chat as chat_service

        blocks = split_excerpt_blocks(HASH_CHUNK)
        # The API returns the text of the cited blocks: here block 1, the collisions paragraph.
        start, end = 1, 2
        events = [
            text_start(),
            text_delta("Separate chaining keeps a list in each bucket."),
            cite("chunk:h", 0, cited="".join(blocks[start:end]), start=start, end=end),
        ]
        provider, _ = provider_with(events)
        out = await collect(provider, excerpts=[Excerpt(ref="chunk:h", title="t", text=HASH_CHUNK)])

        citation = out[-1].citations[0]
        assert (citation.start_block_index, citation.end_block_index) == (1, 2)
        chunk = {"id": "h", "material_id": "m", "filename": "notes.pdf", "page_start": 1, "page_end": 1}
        sources, _ = chat_service.build_sources(out[-1].citations, {"chunk:h": chunk})
        assert sources[0]["cited_text"] == HASH_COLLISIONS
        assert "# Hash Tables" not in sources[0]["cited_text"]


class TestEvents:
    @pytest.mark.asyncio
    async def test_text_and_citations_stream_in_order_and_map_to_excerpts(self):
        events = [
            text_start(0),
            text_delta("Hashing maps keys to buckets", 0),
            text_delta(".", 0),
            cite("chunk:aaa", 0, cited="Hashing maps keys to buckets.", block=0),
            text_start(1),
            text_delta(" A heap is a tree.", 1),
            cite("chunk:bbb", 1, cited="A heap is a complete binary tree.", block=1),
        ]
        provider, _ = provider_with(events)
        out = await collect(provider)

        kinds = [type(e) for e in out]
        assert kinds == [AnswerText, AnswerText, AnswerCitation, AnswerText, AnswerCitation, AnswerDone]
        first, second = [e for e in out if isinstance(e, AnswerCitation)]
        assert (first.ref, first.offset) == ("chunk:aaa", len("Hashing maps keys to buckets."))
        assert first.cited_text == "Hashing maps keys to buckets."
        assert (second.ref, second.offset) == ("chunk:bbb", len("Hashing maps keys to buckets. A heap is a tree."))
        done = out[-1]
        assert done.text == "Hashing maps keys to buckets. A heap is a tree."
        assert done.citations == [first, second]
        assert done.stop_reason == "end_turn"
        assert done.usage.input_tokens == 1200 and done.usage.output_tokens == 80
        assert done.usage.model == "claude-opus-5-5"

    @pytest.mark.asyncio
    async def test_source_wins_over_a_wrong_index_and_index_is_the_fallback(self):
        events = [
            text_start(),
            text_delta("a"),
            cite("chunk:bbb", 0),  # source says bbb, index says the first excerpt
            cite("chunk:unknown", 0),  # unknown source: fall back to the index
            cite("chunk:unknown", 9),  # nothing to map to: dropped
        ]
        provider, _ = provider_with(events)
        out = await collect(provider)
        assert [c.ref for c in out[-1].citations] == ["chunk:bbb", "chunk:aaa"]

    @pytest.mark.asyncio
    async def test_a_marker_goes_after_the_block_it_quotes_not_before_it(self):
        # The API sends a block's citation before the block's text.
        stop0 = BetaRawContentBlockStopEvent(type="content_block_stop", index=0)
        stop1 = BetaRawContentBlockStopEvent(type="content_block_stop", index=1)
        events = [
            text_start(0),
            text_delta("A problem is a ", 0),
            stop0,
            text_start(1),
            cite("chunk:aaa", 0, block=1),
            text_delta("binary relation", 1),
            text_delta(" from inputs to outputs.", 1),
            stop1,
        ]
        provider, _ = provider_with(events)
        out = await collect(provider)
        done = out[-1]
        assert done.text == "A problem is a binary relation from inputs to outputs."
        assert [(c.ref, c.offset) for c in done.citations] == [("chunk:aaa", len(done.text))]

    @pytest.mark.asyncio
    async def test_other_citation_kinds_are_ignored(self):
        page = BetaRawContentBlockDeltaEvent(
            type="content_block_delta",
            index=0,
            delta=BetaCitationsDelta(
                type="citations_delta",
                citation=BetaCitationPageLocation(
                    type="page_location",
                    cited_text="x",
                    document_index=0,
                    document_title=None,
                    start_page_number=1,
                    end_page_number=2,
                ),
            ),
        )
        provider, _ = provider_with([text_start(), text_delta("a"), page])
        out = await collect(provider)
        assert out[-1].citations == []

    @pytest.mark.asyncio
    async def test_a_fallback_model_voids_what_came_before(self):
        fallback = BetaRawContentBlockStartEvent.model_construct(
            type="content_block_start", index=1, content_block=SimpleNamespace(type="fallback")
        )
        events = [
            text_start(0),
            text_delta("Partial from the declined model", 0),
            cite("chunk:aaa", 0),
            fallback,
            text_start(2),
            text_delta("Real answer", 2),
            cite("chunk:bbb", 1, block=2),
        ]
        provider, _ = provider_with(events)
        out = await collect(provider)
        assert any(isinstance(e, AnswerReset) for e in out)
        done = out[-1]
        assert done.text == "Real answer"
        assert [(c.ref, c.offset) for c in done.citations] == [("chunk:bbb", len("Real answer"))]

    @pytest.mark.asyncio
    async def test_usage_is_recorded_for_the_budget(self):
        provider, _ = provider_with([text_start(), text_delta("ok")])
        with track_llm_usage() as usages:
            await collect(provider, purpose="chat")
        assert len(usages) == 1 and usages[0].purpose == "chat" and usages[0].output_tokens == 80


class TestErrors:
    @pytest.mark.asyncio
    async def test_refusal_is_typed_and_carries_usage(self):
        details = SimpleNamespace(category="cyber")
        provider, _ = provider_with(
            [text_start(), text_delta("I can't")], final_message(stop_reason="refusal", stop_details=details)
        )
        with pytest.raises(LLMRefusalError, match="cyber") as raised:
            await collect(provider)
        assert raised.value.usage is not None and raised.value.usage.input_tokens == 1200

    @pytest.mark.asyncio
    async def test_max_tokens_is_an_output_error_with_usage(self):
        provider, _ = provider_with([text_start(), text_delta("cut")], final_message(stop_reason="max_tokens"))
        with pytest.raises(LLMOutputError, match="cut off") as raised:
            await collect(provider)
        assert raised.value.usage is not None

    @pytest.mark.asyncio
    async def test_an_empty_answer_is_an_output_error(self):
        provider, _ = provider_with([text_start(), text_delta("  ")])
        with pytest.raises(LLMOutputError, match="no text"):
            await collect(provider)

    @pytest.mark.asyncio
    async def test_a_dropped_connection_is_translated(self):
        request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
        error = anthropic.APIConnectionError(request=request)
        provider, _ = provider_with([text_start(), text_delta("partial")], error=error)
        with pytest.raises(LLMUnavailableError):
            await collect(provider)


class TestMockProvider:
    @pytest.mark.asyncio
    async def test_streams_text_and_cites_the_first_two_excerpts(self):
        out = await collect(MockProvider())
        citations = [e for e in out if isinstance(e, AnswerCitation)]
        assert [c.ref for c in citations] == ["chunk:aaa", "chunk:bbb"]
        done = out[-1]
        assert isinstance(done, AnswerDone)
        assert "".join(e.text for e in out if isinstance(e, AnswerText)) == done.text
        assert all(0 < c.offset <= len(done.text) for c in citations)
        assert done.usage.model == "mock-main" and done.usage.input_tokens == 0

    @pytest.mark.asyncio
    async def test_quotes_the_body_not_the_heading(self):
        excerpts = [Excerpt(ref="chunk:h", title="t", text="# Hash Tables\n\nA hash table stores pairs. More text.")]
        out = await collect(MockProvider(), excerpts=excerpts)
        done = out[-1]
        assert "A hash table stores pairs." in done.text and "# Hash" not in done.text
        assert done.citations[0].cited_text == "A hash table stores pairs. More text."

    @pytest.mark.asyncio
    async def test_needs_an_excerpt(self):
        with pytest.raises(LLMOutputError):
            await collect(MockProvider(), excerpts=[])

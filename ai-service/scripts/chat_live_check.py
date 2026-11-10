"""One real cited answer from the configured provider, with no database.

Sends three fixed excerpts (two relevant, one not) and a question through
`LLMProvider.stream_cited_answer`, prints the streamed text with its citation markers, the
chunk each citation maps to, and the token usage and cost. Then asks a question the excerpts
do not cover to see that the model says so without citing anything.

    cd ai-service && uv run python scripts/chat_live_check.py

Needs ANTHROPIC_API_KEY (and LLM_PROVIDER=anthropic) in ai-service/.env. Two calls at Opus,
low effort: about 1,000 input and under 300 output tokens each, roughly $0.02 in total.
With LLM_PROVIDER=mock it runs without cost and checks the plumbing only.
"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://unused@localhost/unused")

from app.config import settings  # noqa: E402
from app.services.chat import SYSTEM_PROMPT, build_sources, to_excerpt, usage_payload  # noqa: E402
from app.services.llm.base import (  # noqa: E402
    AnswerCitation,
    AnswerDone,
    AnswerReset,
    AnswerText,
)
from app.services.billing import unbilled  # noqa: E402
from app.services.llm.factory import LLMFactory  # noqa: E402
from app.services.llm.models import resolve_model  # noqa: E402

CHUNKS = [
    {
        "id": "chunk-hash-1",
        "chunk_text": (
            "# Hash Tables\n\nA hash table stores key-value pairs in an array of buckets. A hash "
            "function maps each key to a bucket index, so lookup, insert and delete take O(1) "
            "time on average.\n\nCollisions happen when two keys map to the same bucket. Separate "
            "chaining keeps a linked list of entries in each bucket. Open addressing probes for "
            "the next free slot in the array."
        ),
        "section_hierarchy": "Hash Tables",
        "page_start": 1,
        "page_end": 1,
        "material_id": "material-notes",
        "filename": "ds-notes.pdf",
    },
    {
        "id": "chunk-hash-2",
        "chunk_text": (
            "# Load Factor\n\nThe load factor is the number of stored entries divided by the "
            "number of buckets. When it passes a threshold such as 0.75 the table is resized, "
            "usually doubled, and every key is rehashed."
        ),
        "section_hierarchy": "Load Factor",
        "page_start": 2,
        "page_end": 2,
        "material_id": "material-notes",
        "filename": "ds-notes.pdf",
    },
    {
        "id": "chunk-heap",
        "chunk_text": (
            "# Heaps\n\nA binary heap is a complete binary tree stored in an array. In a "
            "min-heap every parent is smaller than its children, so the minimum is at the root."
        ),
        "section_hierarchy": "Heaps",
        "page_start": 3,
        "page_end": 3,
        "material_id": "material-notes",
        "filename": "ds-notes.pdf",
    },
]


async def ask(question: str) -> None:
    provider = LLMFactory.get_provider()
    excerpts = [to_excerpt(chunk) for chunk in CHUNKS]
    chunks_by_ref = {excerpt.ref: chunk for excerpt, chunk in zip(excerpts, CHUNKS)}
    print(f"\nQ: {question}\n")

    done = None
    async for event in provider.stream_cited_answer(
        system=SYSTEM_PROMPT,
        history=[],
        question=question,
        excerpts=excerpts,
        max_tokens=settings.CHAT_MAX_TOKENS,
        purpose="chat",
    ):
        if isinstance(event, AnswerText):
            print(event.text, end="", flush=True)
        elif isinstance(event, AnswerCitation):
            print(f" <cite {event.ref} blocks {event.start_block_index}:{event.end_block_index}>", end="", flush=True)
        elif isinstance(event, AnswerReset):
            print("\n[reset: a fallback model took over]")
        elif isinstance(event, AnswerDone):
            done = event

    assert done is not None, "the stream ended without a done event"
    sources, marks = build_sources(done.citations, chunks_by_ref)
    print("\n\nsources:")
    for source in sources:
        print(f"  [{source['marker']}] {source['filename']} p. {source['page_start']} (chunk {source['chunk_id']})")
        print(f"      quote: {source['cited_text'][:120]!r}")
    print(f"marks: {marks}")
    print(f"stop_reason: {done.stop_reason}  usage: {usage_payload(done.usage)}")


async def main() -> None:
    choice = resolve_model("chat")
    print(f"provider={settings.LLM_PROVIDER} model={choice.model} effort={choice.effort}")
    with unbilled("script"):  # a live check by hand: no account to bill
        await ask("How does a hash table deal with two keys that land in the same bucket?")
        await ask("What is the capital of France?")


if __name__ == "__main__":
    asyncio.run(main())

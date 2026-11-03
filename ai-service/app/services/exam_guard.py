"""The exam guard's meaning check (spec 6.3).

The app's word-overlap guard (frontend/src/lib/ask/exam-guard.ts) declines a message that repeats an open
mock-exam question's words. It cannot see a question reworded with synonyms or put into another language.
This check embeds the message and the exam's questions with a small multilingual model and declines when
one is close in meaning to a question, whatever the wording or the language. It runs only while the student
has an exam in progress, after the word check has passed the message, and it has no model cost: the embedder
runs in-process.

The model is its own (config EXAM_GUARD_EMBEDDING_MODEL), not the retrieval embedder, which is English-only.
Nothing it produces is stored, so its vector size does not have to match the database.
"""
import logging
import re
from collections import OrderedDict
from typing import List, Optional, Sequence

from app.config import settings
from app.services.embeddings.generator import Embedder, LocalEmbedder

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 2000
MAX_EXAM_TEXTS = 200
# Remembered vectors of exam question texts: the same exam is compared on every message of the sitting.
_CACHE_LIMIT = 512

_embedder: Optional[Embedder] = None
_cache: "OrderedDict[str, List[float]]" = OrderedDict()


def get_guard_embedder() -> Embedder:
    global _embedder
    if _embedder is None:
        _embedder = LocalEmbedder(settings.EXAM_GUARD_EMBEDDING_MODEL, settings.EMBEDDING_CACHE_DIR)
    return _embedder


def reset_guard_embedder() -> None:
    """Drop the cached embedder and vectors (tests)."""
    global _embedder
    _embedder = None
    _cache.clear()


def _chunks(message: str) -> List[str]:
    """The message's sentences and lines: a question pasted after a lead-in, or several at once, is found by one of them."""
    parts = [part.strip() for part in re.split(r"(?<=[.?!])\s+|\n+", message) if part.strip()]
    return parts if len(parts) > 1 else []


def candidate_texts(message: str, recent: Sequence[str]) -> List[str]:
    """What is compared with the exam: the message, its sentences, and the student's last few messages with
    this one joined (a question asked in pieces over several turns)."""
    message = message.strip()[:MAX_TEXT_CHARS]
    texts = [message, *_chunks(message)]
    earlier = [turn.strip() for turn in recent if turn.strip()]
    if earlier:
        texts.append(" ".join([*earlier, message])[: MAX_TEXT_CHARS * 2])
    seen: set[str] = set()
    return [text for text in texts if text and not (text in seen or seen.add(text))]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5)
    return dot / norm if norm else 0.0


async def _vectors(texts: Sequence[str]) -> List[List[float]]:
    embedder = get_guard_embedder()
    missing = [text for text in dict.fromkeys(texts) if text not in _cache]
    if missing:
        for text, vector in zip(missing, await embedder.embed_documents(missing)):
            _cache[text] = vector
    for text in texts:
        _cache.move_to_end(text)
    while len(_cache) > _CACHE_LIMIT:
        _cache.popitem(last=False)
    return [_cache[text] for text in texts]


async def semantic_similarity(message: str, recent: Sequence[str], exam_texts: Sequence[str]) -> float:
    """The highest cosine similarity between the message (or the joined recent messages) and an exam text; 0 when
    there is nothing to compare."""
    exams = [text.strip()[:MAX_TEXT_CHARS] for text in exam_texts if text.strip()][:MAX_EXAM_TEXTS]
    candidates = candidate_texts(message, recent)
    if not exams or not candidates:
        return 0.0
    # Both sets in one call so the cache sees the whole of it; the candidates are never cached for long.
    vectors = await _vectors([*candidates, *exams])
    candidate_vectors, exam_vectors = vectors[: len(candidates)], vectors[len(candidates) :]
    return max(_cosine(c, e) for c in candidate_vectors for e in exam_vectors)


async def semantic_exam_match(message: str, recent: Sequence[str], exam_texts: Sequence[str]) -> bool:
    """True when the message is, in meaning, one of the exam's questions."""
    return await semantic_similarity(message, recent, exam_texts) >= settings.EXAM_GUARD_SEMANTIC_THRESHOLD

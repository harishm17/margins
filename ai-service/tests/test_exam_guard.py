"""The exam guard's meaning check: the logic with a stand-in embedder, and the calibration with the real model."""
from typing import List

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import exam_guard
from app.services.embeddings.generator import Embedder

EXAM = [
    "A hash table with chaining has 8 buckets and 12 keys inserted uniformly at random. What is the expected length of a chain?",
    "Compute the probability that two marbles drawn without replacement from a bag of 3 red and 5 blue marbles are both red.",
    "Which of the following sorting algorithms has worst-case running time O(n log n)? Merge sort, quicksort, bubble sort.",
]


class Topics(Embedder):
    """A stand-in: a text's vector is the topics it mentions, so two texts about one topic are close in any language."""

    name = "topics"
    KEYWORDS = [
        ("hash", "tabla", "hachage", "hashtabelle", "chain", "cadena", "bucket", "slot"),
        ("marble", "canica", "bille", "murmel"),
        ("sort", "ordena", "tri "),
        ("midterm", "deadline"),
    ]

    def __init__(self):
        self.seen: List[str] = []

    def _vector(self, text: str) -> List[float]:
        lowered = text.lower()
        vector = [1.0 if any(word in lowered for word in words) else 0.0 for words in self.KEYWORDS]
        return vector if any(vector) else [0.01, 0.01, 0.01, 0.01]

    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        self.seen += list(texts)
        return [self._vector(text) for text in texts]

    async def embed_query(self, text: str) -> List[float]:
        return self._vector(text)


@pytest.fixture
def topics(monkeypatch):
    exam_guard.reset_guard_embedder()
    fake = Topics()
    monkeypatch.setattr(exam_guard, "get_guard_embedder", lambda: fake)
    yield fake
    exam_guard.reset_guard_embedder()


async def test_a_reworded_question_is_recognised_whatever_the_wording(topics):
    assert await exam_guard.semantic_exam_match("Mean bucket list size when twelve keys fall into eight slots of a chained table?", [], EXAM)


async def test_a_concept_question_on_another_topic_is_not(topics):
    assert not await exam_guard.semantic_exam_match("When is the midterm?", [], EXAM)


async def test_a_question_asked_in_pieces_is_read_as_one(topics):
    # Neither piece is close to a question on its own; the student's messages joined are about the marbles.
    assert exam_guard.candidate_texts("and they are both red?", ["a bag of 3 red and 5 blue marbles"])[-1].startswith("a bag of 3 red")
    assert await exam_guard.semantic_exam_match("both red?", ["marbles from a bag of 3 red and 5 blue"], EXAM)


class TestRoute:
    @pytest.fixture
    def client(self, topics, monkeypatch):
        monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "")
        monkeypatch.setattr(settings, "ENVIRONMENT", "development")
        return TestClient(app)

    def test_it_says_whether_the_message_matches_and_by_how_much(self, client):
        yes = client.post("/chat/exam-guard", json={"message": "Una tabla hash con encadenamiento: longitud esperada de una cadena?", "exam_texts": EXAM}).json()
        no = client.post("/chat/exam-guard", json={"message": "When is the midterm?", "exam_texts": EXAM}).json()
        assert yes["match"] is True and yes["similarity"] > settings.EXAM_GUARD_SEMANTIC_THRESHOLD
        assert no["match"] is False


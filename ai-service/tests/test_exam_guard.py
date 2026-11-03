"""The exam guard's meaning check: the logic with a stand-in embedder, and the calibration with the real model."""
import os
from typing import Dict, List

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import exam_guard
from app.services.embeddings.generator import Embedder, LocalEmbedder

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


async def test_a_translated_question_is_recognised(topics):
    assert await exam_guard.semantic_exam_match("Una tabla hash con encadenamiento tiene 8 cubetas y 12 claves. Cual es la longitud esperada de una cadena?", [], EXAM)


async def test_a_concept_question_on_another_topic_is_not(topics):
    assert not await exam_guard.semantic_exam_match("When is the midterm?", [], EXAM)


async def test_a_question_asked_in_pieces_is_read_as_one(topics):
    # Neither piece is close to a question on its own; the student's messages joined are about the marbles.
    assert exam_guard.candidate_texts("and they are both red?", ["a bag of 3 red and 5 blue marbles"])[-1].startswith("a bag of 3 red")
    assert await exam_guard.semantic_exam_match("both red?", ["marbles from a bag of 3 red and 5 blue"], EXAM)


async def test_a_question_after_a_lead_in_is_found_by_its_sentence(topics):
    assert "Which sorting method is O(n log n) at worst?" in exam_guard.candidate_texts(
        "Hi there, I am revising for the week. Which sorting method is O(n log n) at worst?", []
    )


async def test_nothing_to_compare_is_no_match(topics):
    assert await exam_guard.semantic_similarity("anything", [], []) == 0.0
    assert await exam_guard.semantic_similarity("   ", [], EXAM) == 0.0


async def test_exam_text_vectors_are_remembered_between_messages(topics):
    await exam_guard.semantic_similarity("one", [], EXAM)
    first = len(topics.seen)
    await exam_guard.semantic_similarity("two", [], EXAM)
    # Only the new message was embedded the second time.
    assert len(topics.seen) - first == 1


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

    def test_recent_messages_are_read_with_the_new_one(self, client):
        body = {"message": "both red?", "recent": ["marbles from a bag of 3 red and 5 blue"], "exam_texts": EXAM}
        assert client.post("/chat/exam-guard", json=body).json()["match"] is True

    def test_bad_input_is_refused(self, client):
        assert client.post("/chat/exam-guard", json={"message": "", "exam_texts": EXAM}).status_code == 422


# ---- the real model, to keep the threshold honest. Needs the model files (about 220 MB): set EXAM_GUARD_REAL_MODEL=1.

REWORDINGS: Dict[str, str] = {
    "synonyms": "With 12 keys spread evenly over 8 slots in a chained hash table, how long is a typical bucket list on average?",
    "numbers as words": "A chained hash table has eight buckets and twelve keys placed uniformly at random. Give the mean chain length.",
    "spanish": "Una tabla hash con encadenamiento tiene 8 cubetas y se insertan 12 claves de forma uniforme al azar. Cual es la longitud esperada de una cadena?",
    "french": "Une table de hachage avec chainage a 8 alveoles et 12 cles inserees uniformement au hasard. Quelle est la longueur attendue d'une chaine ?",
    "german": "Eine Hashtabelle mit Verkettung hat 8 Eimer und 12 gleichverteilt eingefuegte Schluessel. Wie lang ist eine Kette im Erwartungswert?",
    "spanish probability": "Calcula la probabilidad de que dos canicas sacadas sin reemplazo de una bolsa con 3 rojas y 5 azules sean ambas rojas.",
    "odds": "What are the odds both marbles are red when you pull two from a bag holding three red and five blue ones, without putting any back?",
    "sorting": "Which sorting method guarantees O(n log n) in the worst case: merge sort, quicksort or bubble sort?",
}
CONCEPT_QUESTIONS = [
    "What is a hash table and how does chaining resolve collisions?",
    "Explain expected value in plain words.",
    "How do I compute probability without replacement in general?",
    "Why is merge sort stable while quicksort is not?",
    "When is the midterm and what does it cover?",
    "Explique como funciona el encadenamiento en una tabla hash.",
    "Comment calcule-t-on une probabilite conditionnelle ?",
    "Is bubble sort ever a good choice?",
    "What is the load factor of a hash table?",
]

real = pytest.mark.skipif(os.environ.get("EXAM_GUARD_REAL_MODEL") != "1", reason="set EXAM_GUARD_REAL_MODEL=1 to run with the real model")


@pytest.fixture
def real_model(monkeypatch):
    exam_guard.reset_guard_embedder()
    embedder = LocalEmbedder(settings.EXAM_GUARD_EMBEDDING_MODEL, os.environ.get("EMBEDDING_CACHE_DIR") or settings.EMBEDDING_CACHE_DIR or None)
    monkeypatch.setattr(exam_guard, "get_guard_embedder", lambda: embedder)
    yield
    exam_guard.reset_guard_embedder()


@real
@pytest.mark.parametrize("kind", sorted(REWORDINGS))
async def test_real_model_recognises_rewordings_and_translations(real_model, kind):
    similarity = await exam_guard.semantic_similarity(REWORDINGS[kind], [], EXAM)
    assert similarity >= settings.EXAM_GUARD_SEMANTIC_THRESHOLD, (kind, similarity)


@real
@pytest.mark.parametrize("question", CONCEPT_QUESTIONS)
async def test_real_model_leaves_concept_questions_alone(real_model, question):
    similarity = await exam_guard.semantic_similarity(question, [], EXAM)
    assert similarity < settings.EXAM_GUARD_SEMANTIC_THRESHOLD, (question, similarity)

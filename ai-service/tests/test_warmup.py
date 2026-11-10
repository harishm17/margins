"""The warm-up bank: short, choice-only, bracketed by difficulty, and not a quiz set."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.content_generator.context import existing_content_digest
from app.services.content_generator.warmup import generate_warmup
from app.services.llm.base import LLMOutputError
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import ChoiceOption, GeneratedQuestion, WarmupSet
from tests.db_helpers import add_chunk, new_id, seed_material, seed_project, seed_topic, seed_user

pytestmark = pytest.mark.usefixtures("passthrough_support")


ROOT = Path(__file__).resolve().parents[2]
CHUNK_TEXT = [
    "The sample mean is the sum of the values divided by how many there are.",
    "Variance measures how far values spread from the mean.",
]


@pytest.fixture
async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    material = await seed_material(db, project_id, filename="stats.pdf", status="valid")
    chunks = [await add_chunk(db, material, i, text, page=i + 1, tokens=30) for i, text in enumerate(CHUNK_TEXT)]
    topic_id = await seed_topic(db, project_id, "Summary statistics")
    await db.execute("UPDATE topics SET objectives = $2 WHERE id = $1", topic_id, ["Compute a mean", "Explain variance"])
    await db.execute(
        "INSERT INTO topic_sources (id, topic_id, material_id, chunk_index_start, chunk_index_end, role) "
        "VALUES ($1, $2, $3, 0, 1, 'primary')",
        new_id(), topic_id, material,
    )
    concept_ids = []
    for position, (name, chunk) in enumerate([("Mean", chunks[0]), ("Variance", chunks[1])]):
        concept_id = new_id()
        await db.execute(
            "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
            "VALUES ($1, $2, $3, $4, 'summary', 'concept', $5)",
            concept_id, project_id, topic_id, name, position,
        )
        await db.execute(
            "INSERT INTO concept_claims (id, concept_id, text, quote, material_id, chunk_id, order_index) "
            "VALUES ($1, $2, 'claim', 'quote', $3, $4, 0)",
            new_id(), concept_id, material, chunk,
        )
        concept_ids.append(concept_id)
    return SimpleNamespace(project_id=project_id, topic_id=topic_id, concepts=concept_ids)


def _choice(n, level, kind="multiple_choice"):
    if kind == "true_false":
        return GeneratedQuestion(
            question_type="true_false", question_text=f"True or false {n}", correct_answer=True,
            explanation="e", difficulty=level, source_excerpts=[1],
        )
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=f"Question {n}", correct_answer="A", explanation="e",
        options=[ChoiceOption(id=x, text=f"{n}{x}", misconception=None if x == "A" else f"idea {x}") for x in "ABCD"],
        difficulty=level, source_excerpts=[1],
    )


def _llm(questions):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=WarmupSet(questions=questions))
    return llm


async def _rows(db, topic_id):
    return await db.fetch("SELECT * FROM topic_quizzes WHERE topic_id = $1 AND kind = 'warmup'", topic_id)


class TestWarmup:
    async def test_warmup_is_short_and_choice_only(self, db, world):
        mixed = [_choice(1, "easy"), _choice(2, "easy"), _choice(3, "medium"), _choice(4, "medium"),
                 _choice(5, "hard", "true_false"), _choice(6, "hard"), _choice(7, "easy", "true_false")]
        mixed.append(GeneratedQuestion(
            question_type="short_answer", question_text="Explain", sample_answer="s", key_points=["k"],
            explanation="e", difficulty="medium",
        ))
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(mixed)):
            result = await generate_warmup(world.topic_id)

        assert result["total_questions"] == 5
        assert {q["question_type"] for q in result["questions"]} <= {"multiple_choice", "true_false"}
        assert [q["difficulty"] for q in result["questions"]] == ["easy", "easy", "medium", "medium", "hard"]
        rows = await _rows(db, world.topic_id)
        assert len(rows) == 1
        stored = json.loads(rows[0]["questions"])
        assert stored == result["questions"]
        assert all(q["sources"] and "source_excerpts" not in q for q in stored)

    async def test_regenerating_replaces_the_bank(self, db, world):
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
            first = await generate_warmup(world.topic_id)
            second = await generate_warmup(world.topic_id)
        rows = await _rows(db, world.topic_id)
        assert [r["id"] for r in rows] == [second["warmup_id"]]
        assert first["warmup_id"] != second["warmup_id"]

    async def test_questions_with_a_bare_distractor_are_dropped_and_too_few_fail(self, db, world):
        bare = _choice(1, "easy")
        bare.options[1].misconception = None
        questions = [bare, bare, bare, _choice(2, "medium"), _choice(3, "hard")]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            with pytest.raises(LLMOutputError, match="2 usable questions of 5"):
                await generate_warmup(world.topic_id)
        assert await _rows(db, world.topic_id) == []

    async def test_warmup_not_listed_as_quiz_set(self, db, world):
        # What the quiz generators show the student as already seen leaves the warm-up out.
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
            await generate_warmup(world.topic_id)
        assert await existing_content_digest(world.topic_id) == ""

        # Every query that lists or counts a topic's quiz sets filters on kind.
        sql_sites = {
            "ai-service/app/api/routes/jobs.py": "kind IN ('standard', 'retry')",
            "ai-service/app/services/generation_chain.py": "kind IN ('standard', 'retry')",
            "frontend/src/server/queries/topic.ts": "kind: { in: ['standard', 'retry'] }",
            "frontend/src/lib/learning/quiz-sets.ts": "kind: { in: ['standard', 'retry'] }",
            "frontend/src/lib/learning/review-server.ts": "kind: { in: ['standard', 'retry'] }",
        }
        for path, filter_text in sql_sites.items():
            assert filter_text in (ROOT / path).read_text(), path

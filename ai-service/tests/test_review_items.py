"""The review-item job: new tagged items for the concepts a review session lacks, appended to the topic's review bank."""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api.routes import jobs
from app.models.jobs import JobPayload
from app.services.content_generator.review_items import generate_review_items
from app.services.llm.base import LLMOutputError
from app.services.llm.mock_provider import MockProvider
from app.services.llm.schemas import ChoiceOption, GeneratedQuestion, ReviewItemSet
from tests.db_helpers import get_job, new_id, seed_job
from tests.test_warmup import world  # noqa: F401  (fixture)

pytestmark = pytest.mark.usefixtures("passthrough_support")


def _choice(n, concept_id, mode="recall", level="easy", confusable=None):
    return GeneratedQuestion(
        question_type="multiple_choice", question_text=f"Question {n} about {concept_id[:6]}", correct_answer="A",
        explanation="e",
        options=[
            ChoiceOption(
                id=x, text=f"{n}{x}",
                misconception=None if x == "A" else f"idea {x}",
                confusable_concept_id=confusable if x == "B" else None,
            )
            for x in "ABCD"
        ],
        difficulty=level, concept_ids=[concept_id], mode=mode, source_excerpts=[1],
    )


def _llm(questions):
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=ReviewItemSet(questions=questions))
    return llm


@pytest.fixture
async def twins(db, world):  # noqa: F811
    """The world's two concepts are near-twins (a confusable edge, the smaller id as source)."""
    low, high = sorted(world.concepts)
    await db.execute(
        "INSERT INTO concept_edges (id, project_id, source_id, target_id, type, weight, confidence, origin, status) "
        "VALUES ($1, $2, $3, $4, 'confusable', 1, 0.9, 'llm', 'confirmed')",
        new_id(), world.project_id, low, high,
    )
    return world


async def _bank(db, topic_id):
    return await db.fetch("SELECT * FROM topic_quizzes WHERE topic_id = $1 AND kind = 'review_bank'", topic_id)


def _request(concept_ids, mode="recall", difficulty="easy"):
    return {"concept_ids": concept_ids, "mode": mode, "difficulty": difficulty}


class TestReviewItems:
    async def test_review_items_tagged_and_appended(self, db, twins):
        first_concept, second_concept = twins.concepts
        questions = [_choice(1, first_concept), _choice(2, first_concept), _choice(3, second_concept)]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            result = await generate_review_items(twins.topic_id, [_request([first_concept, second_concept])])

        assert result["total_items"] == 3
        rows = await _bank(db, twins.topic_id)
        assert len(rows) == 1
        stored = json.loads(rows[0]["questions"])
        assert [q["concept_ids"][0] for q in stored] == [first_concept, first_concept, second_concept]
        assert all(q["difficulty"] == "easy" and q["mode"] == "recall" for q in stored)
        assert all(q["sources"] and "source_excerpts" not in q for q in stored)

        # A second run appends to the same row; the first items keep their positions (their item keys).
        again = [_choice(4, second_concept, level="hard")]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(again)):
            await generate_review_items(twins.topic_id, [_request([second_concept], difficulty="hard")])
        rows = await _bank(db, twins.topic_id)
        assert [r["id"] for r in rows] == [rows[0]["id"]]
        after = json.loads(rows[0]["questions"])
        assert after[:3] == stored
        assert after[3]["difficulty"] == "hard" and after[3]["concept_ids"] == [second_concept]

    async def test_review_items_honour_requested_mode(self, db, twins):
        mean, variance = twins.concepts
        questions = [
            # A discrimination item names the twin on a wrong option.
            _choice(1, mean, mode="discrimination", level="medium", confusable=variance),
            # Asked for discrimination, the model wrote a plain recall item: not what was asked for.
            _choice(2, mean, mode="recall", level="medium"),
            # Names a concept that is not the concept's twin... it is the concept itself.
            _choice(3, mean, mode="discrimination", level="medium", confusable=mean),
        ]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            result = await generate_review_items(
                twins.topic_id, [_request([mean], mode="discrimination", difficulty="medium")]
            )

        assert result["total_items"] == 1
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        assert stored[0]["mode"] == "discrimination"
        assert stored[0]["concept_ids"] == [mean]
        wrong = [o for o in stored[0]["options"] if o.get("confusable_concept_id")]
        assert [o["confusable_concept_id"] for o in wrong] == [variance]

    async def test_prompt_pairs_the_concept_with_its_confusable(self, db, twins):
        mean, variance = twins.concepts
        llm = _llm([_choice(1, mean, mode="discrimination", confusable=variance)])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=llm):
            await generate_review_items(twins.topic_id, [_request([mean], mode="discrimination")])

        prompt = "\n".join(m.content for m in llm.generate_structured.call_args.args[0])
        assert f'<request concept_id="{mean}" mode="discrimination" difficulty="easy"' in prompt
        assert f'<confusable concept_id="{variance}">' in prompt
        assert llm.generate_structured.call_args.kwargs["purpose"] == "review_items"

    async def test_an_item_for_a_concept_nobody_asked_for_is_dropped(self, db, twins):
        mean, variance = twins.concepts
        questions = [_choice(1, mean), _choice(2, variance), _choice(3, "not-a-concept")]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)):
            result = await generate_review_items(twins.topic_id, [_request([mean])])

        assert result["total_items"] == 1
        assert result["concepts_without_items"] == []

    async def test_the_answer_key_support_check_runs_on_review_items(self, db, twins):
        mean = twins.concepts[0]
        seen = []

        async def drop_first(items, chunks):
            seen.append(len(items))
            return items[1:], 1

        questions = [_choice(1, mean), _choice(2, mean)]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm(questions)), \
                patch("app.services.content_generator.review_items.check_support", drop_first):
            result = await generate_review_items(twins.topic_id, [_request([mean])])

        assert seen == [2]
        assert result["dropped_unsupported"] == 1
        assert result["total_items"] == 1
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        assert [q["question_text"] for q in stored] == [questions[1].question_text]

    async def test_a_repeated_question_is_not_added_twice(self, db, twins):
        mean = twins.concepts[0]
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_choice(1, mean)])):
            await generate_review_items(twins.topic_id, [_request([mean])])
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_choice(1, mean), _choice(2, mean)])):
            result = await generate_review_items(twins.topic_id, [_request([mean])])

        assert result["total_items"] == 1
        assert len(json.loads((await _bank(db, twins.topic_id))[0]["questions"])) == 2

    async def test_nothing_usable_fails_and_stores_nothing(self, db, twins):
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=_llm([_choice(1, "unknown")])):
            with pytest.raises(LLMOutputError):
                await generate_review_items(twins.topic_id, [_request([twins.concepts[0]])])
        assert await _bank(db, twins.topic_id) == []

    async def test_the_mock_provider_writes_what_was_asked(self, db, twins):
        mean, variance = twins.concepts
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
            result = await generate_review_items(
                twins.topic_id,
                [_request([mean], "recall", "easy"), _request([variance], "discrimination", "hard")],
            )

        assert result["concepts_without_items"] == []
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        by_concept = {q["concept_ids"][0]: q for q in stored}
        assert by_concept[mean]["mode"] == "recall" and by_concept[mean]["difficulty"] == "easy"
        assert by_concept[variance]["mode"] == "discrimination" and by_concept[variance]["difficulty"] == "hard"
        assert any(o.get("confusable_concept_id") == mean for o in by_concept[variance]["options"])


class TestReviewItemsJob:
    async def test_the_job_stores_the_items_and_completes(self, db, twins):
        mean = twins.concepts[0]
        user_id = await db.fetchval("SELECT user_id FROM projects WHERE id = $1", twins.project_id)
        job_id = await seed_job(db, user_id, "generate_review_items", project_id=twins.project_id)
        payload = JobPayload(
            jobId=job_id, jobType="generate_review_items",
            data={"topicId": twins.topic_id, "requests": [{"conceptIds": [mean], "mode": "recall", "difficulty": "easy"}]},
        )
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
            result = await jobs.generate_review_items_job(payload)

        assert result["status"] == "success"
        job = await get_job(db, job_id)
        assert job["status"] == "completed"
        assert json.loads(job["result_data"])["total_items"] >= 1
        assert len(await _bank(db, twins.topic_id)) == 1


class TestManyConcepts:
    async def test_no_concept_is_dropped_when_a_job_asks_for_more_than_one_call_writes(self, db, twins):
        concepts = list(twins.concepts)
        for n in range(20):
            concepts.append(await db.fetchval(
                "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
                "VALUES ($1, $2, $3, $4, 's', 'concept', $5) RETURNING id",
                new_id(), twins.project_id, twins.topic_id, f"Extra {n}", 10 + n,
            ))
        with patch("app.services.llm.factory.LLMFactory.get_provider", return_value=MockProvider()):
            result = await generate_review_items(twins.topic_id, [_request(concepts)])

        assert result["concepts_without_items"] == []
        stored = json.loads((await _bank(db, twins.topic_id))[0]["questions"])
        assert {q["concept_ids"][0] for q in stored} == set(concepts)
        assert result["total_items"] == len(concepts) * 2


def test_the_reaper_can_send_a_review_item_job_again():
    from app.services import job_reaper
    from app.services.dispatch import JOB_ENDPOINTS

    assert JOB_ENDPOINTS["generate_review_items"] == "/jobs/generate-review-items"
    stored = {"topicId": "t1", "requests": [{"conceptIds": ["c1"], "mode": "recall", "difficulty": "easy"}]}
    assert job_reaper.dispatch_data("generate_review_items", stored) == stored
    assert job_reaper.dispatch_data("generate_review_items", json.dumps(stored)) == stored

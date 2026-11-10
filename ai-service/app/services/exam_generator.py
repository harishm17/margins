"""
Sample exam generator service.
Creates comprehensive exams combining multiple topics.
"""

import asyncio
import logging
from typing import Dict, List, Mapping

from datetime import UTC, datetime

from app.db.connection import execute_query
from app.services.content_generator.context import (
    NoSourceMaterialError,
    attach_sources,
    content_messages,
    do_not_reuse_block,
    existing_content_digest,
    fetch_concepts,
    fetch_confusable_neighbours,
    fetch_topic_context,
    format_concept_block,
    resolve_concept_ids,
)
from app.prompt_revision import prompts_v2
from app.services.content_generator.quiz import minimum_usable, question_rules, question_set_schema
from app.services.content_generator.refill import refill_figures, refill_wanted
from app.services.content_generator.support_check import check_support
from app.services.exam_style import project_style_profile, style_guidance
from app.services.llm.base import LLMError, LLMOutputError
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import content_rng
from app.services.llm.caps import output_cap

logger = logging.getLogger(__name__)

DEFAULT_TYPE_DISTRIBUTION = {"multiple_choice": 60, "short_answer": 30, "numerical": 10}
QUESTION_TYPES = ("multiple_choice", "short_answer", "numerical", "true_false")
# Topics generated at the same time.
TOPIC_CONCURRENCY = 4
# Spare questions asked per type per topic, so a question the support check drops is replaced.
TYPE_SPARE_SMALL = 1  # a type with 1 or 2 questions in the topic's quota
TYPE_SPARE_LARGE = 2


def with_spares(type_counts: Dict[str, int]) -> Dict[str, int]:
    """The quota plus one or two spare questions of each type (two once the quota is 3 or more)."""
    return {
        q_type: n + (TYPE_SPARE_LARGE if n >= 3 else TYPE_SPARE_SMALL)
        for q_type, n in type_counts.items()
    }


def split_by_weight(total: int, weights: Mapping[str, float]) -> Dict[str, int]:
    """Split `total` across keys in proportion to weights (largest remainder; sums to total)."""
    positive = {key: float(w) for key, w in weights.items() if w and float(w) > 0}
    if total <= 0 or not positive:
        return {}
    weight_sum = sum(positive.values())
    exact = {key: total * w / weight_sum for key, w in positive.items()}
    counts = {key: int(value) for key, value in exact.items()}
    leftover = total - sum(counts.values())
    for key in sorted(exact, key=lambda k: exact[k] - counts[k], reverse=True)[:leftover]:
        counts[key] += 1
    return {key: count for key, count in counts.items() if count > 0}


def plan_exam(topic_ids: List[str], total_questions: int, type_distribution: Mapping[str, float]) -> Dict[str, Dict[str, int]]:
    """Per-topic question-type counts that add up to exactly `total_questions`.

    Question k goes to topic k mod len(topics), so topics get counts that differ by at most
    one (with fewer questions than topics, some get none). Types are spread evenly over the
    question sequence, so each topic gets a mix.
    """
    if not topic_ids or total_questions <= 0:
        return {}
    weights = {k: v for k, v in type_distribution.items() if k in QUESTION_TYPES}
    type_counts = split_by_weight(total_questions, weights) or {"multiple_choice": total_questions}
    # Place the n questions of each type at evenly spaced positions, then read them in order.
    positioned = [
        ((i + 0.5) / n, q_type) for q_type, n in type_counts.items() for i in range(n)
    ]
    type_sequence = [q_type for _, q_type in sorted(positioned)]

    plan: Dict[str, Dict[str, int]] = {}
    for k, q_type in enumerate(type_sequence):
        topic_counts = plan.setdefault(topic_ids[k % len(topic_ids)], {})
        topic_counts[q_type] = topic_counts.get(q_type, 0) + 1
    return plan


class ExamGenerator:
    """Generate sample exams across multiple topics."""

    def __init__(self):
        self.llm = LLMFactory.get_provider()

    async def generate_exam(
        self,
        project_id: str,
        topic_ids: List[str],
        config: Dict,
    ) -> Dict:
        """
        Generate an exam across multiple topics.

        Args:
            project_id: Project ID
            topic_ids: List of topic IDs to include
            config: Exam configuration
                - total_questions: Total number of questions
                - duration_minutes: Exam duration
                - question_type_distribution: e.g., {"multiple_choice": 60, "short_answer": 30, "numerical": 10}
                - difficulty_level: easy, medium, or hard
                - match_past_exams: write the questions in the style of the project's past exams
                  (their merged style profile), when any has one

        Returns:
            Dict with exam questions and metadata
        """
        topics = await self._fetch_topics(project_id, topic_ids)
        if not topics:
            raise ValueError(f"No topics found for project {project_id}")

        total_questions = int(config.get('total_questions') or 20)
        type_dist = config.get('question_type_distribution') or DEFAULT_TYPE_DISTRIBUTION
        difficulty = config.get('difficulty_level', 'medium')
        # A topic with no pages mapped to it cannot be written from. It is left out before the questions are shared out, so the
        # exam still has the number asked for (over the other topics) instead of coming up short, and the job result says which
        # topics were left out.
        contexts = await asyncio.gather(*(fetch_topic_context(t["id"]) for t in topics))
        skipped_topics = [t["name"] for t, context in zip(topics, contexts) if not context.chunks]
        context_of = {t["id"]: context for t, context in zip(topics, contexts) if context.chunks}
        topics = [t for t in topics if t["id"] in context_of]
        if not topics:
            raise NoSourceMaterialError("No source material is mapped to any of the chosen topics")
        plan = plan_exam([t["id"] for t in topics], total_questions, type_dist)
        style = ""
        if config.get('match_past_exams'):
            profile = await project_style_profile(project_id)
            style = style_guidance(profile) if profile else ""

        semaphore = asyncio.Semaphore(TOPIC_CONCURRENCY)

        async def run(topic: Dict) -> tuple[List[Dict], int, int]:
            async with semaphore:
                return await self._generate_topic_questions(topic, plan[topic["id"]], difficulty, style, context_of[topic["id"]])

        planned_topics = [t for t in topics if t["id"] in plan]
        results = await asyncio.gather(*(run(t) for t in planned_topics), return_exceptions=True)

        all_questions: List[Dict] = []
        dropped = 0
        refilled = 0
        empty: List[str] = []
        errors: List[BaseException] = []
        for topic, result in zip(planned_topics, results):
            if isinstance(result, BaseException):
                logger.warning("Exam questions failed for topic %s: %s", topic["id"], result)
                errors.append(result)
                continue
            if not result[0]:
                empty.append(topic["name"])
            all_questions.extend(result[0])
            dropped += result[1]
            refilled += result[2]

        # A configuration or billing problem fails every topic the same way: report it as such.
        for error in errors:
            if isinstance(error, LLMError) and not error.retryable:
                raise error
        # An exam missing a whole topic would mislead the student about what it covers.
        if empty:
            raise LLMOutputError(f"Exam had no usable questions for: {', '.join(empty)}")
        if len(all_questions) < minimum_usable(total_questions):
            if errors:
                raise errors[0]
            raise LLMOutputError(
                f"Exam had {len(all_questions)} usable questions of {total_questions} requested"
            )

        # Mixed across topics, the same way every time for the same questions.
        content_rng([str(q.get('question_text')) for q in all_questions]).shuffle(all_questions)
        return {
            'questions': all_questions,
            'total_questions': len(all_questions),
            'dropped_unsupported': dropped,
            **refill_figures(total_questions, len(all_questions), refilled),
            'duration_minutes': config.get('duration_minutes', 120),
            'difficulty_level': difficulty,
            'matched_past_exams': bool(style),
            'topics_covered': [t['name'] for t in planned_topics],
            'skipped_topics': skipped_topics,
            'generated_at': datetime.now(UTC).isoformat(),
        }

    async def _fetch_topics(self, project_id: str, topic_ids: List[str]) -> List[Dict]:
        """Fetch topics for the exam."""
        if not topic_ids:
            return []
        topics = await execute_query(
            """
            SELECT id, name, description, keywords
            FROM topics
            WHERE project_id = $1 AND id = ANY($2::text[])
            ORDER BY order_index
            """,
            project_id,
            topic_ids,
        )
        return [dict(topic) for topic in topics]

    async def _generate_topic_questions(
        self,
        topic: Dict,
        type_counts: Dict[str, int],
        difficulty: str,
        style: str = "",
        context=None,
    ) -> tuple[List[Dict], int, int]:
        """Questions for one topic, in the planned type mix, in the style of the past exams when
        `style` (their guidance block) is given. Also the number of questions the answer-key support
        check dropped and the number a refill (SUPPORT_REFILL) added."""
        context = context or await fetch_topic_context(topic["id"])
        chunks = context.chunks
        if not chunks:
            raise NoSourceMaterialError(f"No source material is mapped to topic {topic['name']}")

        concepts = await fetch_concepts(topic["id"])
        neighbours = await fetch_confusable_neighbours(topic["id"])
        v2 = prompts_v2("generation")
        difficulties, application_rules, format_rules = question_rules()
        guidance = difficulties.get(difficulty, difficulties['medium'])
        closing = "" if v2 else f'\nSet difficulty to "{difficulty}".'
        style_block = f"{style}\n" if style else ""
        existing = do_not_reuse_block(await existing_content_digest(topic["id"]))

        async def ask(asked: Dict[str, int], avoid: str = "") -> tuple[List[Dict], int]:
            """One model call for `asked` questions (the quota plus spares), the support check over them, and the
            questions it keeps."""
            requested = sum(asked.values())
            mix = ", ".join(f"{n} {q_type}" for q_type, n in asked.items())
            instructions = f"""Write {requested} exam questions on "{topic['name']}" from the excerpts above, for a timed practice exam.

Use exactly this mix: {mix}. A few extra questions of each type are spares for questions that do not pass a check, so each one must stand on its own.
Difficulty: {difficulty}. {guidance}

{application_rules}
{existing}{avoid}{format_concept_block(concepts, neighbours)}
{style_block}{format_rules}{closing}"""

            result = await self.llm.generate_structured(
                content_messages(topic['name'], topic.get('description') or '', chunks, instructions,
                                 course_map=context.course_map),
                question_set_schema(),
                max_tokens=output_cap("exam_questions", 16000),
                purpose="exam_questions",
            )

            # Keep up to the quota plus its spares, check them, then the caller trims each type back to the quota,
            # so a topic with a small quota is not emptied by one dropped question.
            remaining = dict(asked)
            questions: List[Dict] = []
            for question in result.usable():
                q_type = question["question_type"]
                if remaining.get(q_type, 0) <= 0:
                    continue
                remaining[q_type] -= 1
                question['topic_id'] = topic['id']
                question['topic_name'] = topic['name']
                if v2:
                    question['difficulty'] = difficulty  # the code knows it; the model is not asked
                questions.append(question)
            return await check_support(questions, chunks)

        def trim(questions: List[Dict]) -> List[Dict]:
            quota = dict(type_counts)
            trimmed: List[Dict] = []
            for question in questions:
                q_type = question["question_type"]
                if quota.get(q_type, 0) <= 0:
                    continue
                quota[q_type] -= 1
                trimmed.append(question)
            return trimmed

        checked, dropped = await ask(with_spares(type_counts))
        questions = trim(checked)
        wanted = sum(type_counts.values())

        async def regenerate(_missing: int) -> List[Dict]:
            # Finding 102: once, for the types the check left short, with the usual spares on top.
            nonlocal dropped
            have: Dict[str, int] = {}
            for question in questions:
                have[question["question_type"]] = have.get(question["question_type"], 0) + 1
            short = {t: n - have.get(t, 0) for t, n in type_counts.items() if n > have.get(t, 0)}
            avoid = "\n\nDo not repeat these questions:\n" + "\n".join(f"- {q.get('question_text')}" for q in questions)
            more, more_dropped = await ask(with_spares(short), avoid if questions else "")
            dropped += more_dropped
            return questions + more

        refilled = 0
        if refill_wanted(len(questions), minimum_usable(wanted)):
            merged = trim(await regenerate(wanted - len(questions)))
            refilled = max(0, len(merged) - len(questions))
            questions = merged
        resolve_concept_ids(questions, concepts, chunks, neighbours)
        attach_sources(questions, chunks)
        return questions, dropped, refilled

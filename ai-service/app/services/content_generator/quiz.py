"""
Quiz generator service.
Creates section quizzes with various question types.
"""

import logging
from typing import List, Dict, Optional
from datetime import UTC, datetime
from enum import Enum

from app.services.content_generator.context import (
    NoSourceMaterialError,
    _tokens,
    attach_sources,
    content_messages,
    do_not_reuse_block,
    existing_content_digest,
    fetch_concepts,
    fetch_confusable_neighbours,
    fetch_topic_context,
    focus_line,
    format_concept_block,
    resolve_concept_ids,
)
from app.services.content_generator.refill import refill_figures, refill_once
from app.services.content_generator.support_check import check_support
from app.services.llm.base import LLMOutputError
from app.services.llm.factory import LLMFactory
from app.services.llm.schemas import QuestionSet, QuestionSetV2
from app.prompt_revision import prompts_v2


logger = logging.getLogger(__name__)

# Questions asked for beyond the requested count: the support check drops some, and the set is
# trimmed back to the requested count afterwards so it is not short by default.
SUPPORT_SPARE_QUESTIONS = 2

# Excerpts of a prerequisite topic added for the "fresh review" questions.
PREREQUISITE_MAX_CHUNKS = 6
PREREQUISITE_TOKEN_BUDGET = 2500


class QuestionType(str, Enum):
    MULTIPLE_CHOICE = "multiple_choice"
    SHORT_ANSWER = "short_answer"
    NUMERICAL = "numerical"
    TRUE_FALSE = "true_false"


DIFFICULTY_GUIDANCE = {
    'easy': 'Test basic recall and simple understanding of the fundamental concepts.',
    'medium': 'Test both understanding and application, with some analysis and problem-solving.',
    'hard': 'Require deep understanding, critical thinking and multi-step reasoning.',
}

QUESTION_FORMAT_RULES = """Question rules:
- multiple_choice: exactly 4 options with ids A, B, C, D, one correct answer, plausible distractors. Vary which letter is correct. Keep options short and put any code in the question text, not the options. Make the four options about the same length and level of detail: the correct one must not be the longest, the most specific or the only one with a qualification, which would give it away. When a wrong option states a rule, give it the same kind of conditions the right one has.
- short_answer: answerable in 1-3 sentences; give a sample_answer and 2-4 key_points a grader can check.
- numerical: correct_answer is a plain number; give an absolute tolerance. Give `unit` only when the quantity has one (m/s, mol/L, dollars). For a probability, a count or a ratio leave `unit` empty: never put the name of the quantity there.
- true_false: correct_answer is a boolean; the explanation says why.
- Every question has an explanation of the correct answer and points from 1 to 5 by complexity.
- In explanations, refer to options by their content, never by letter. The options are shuffled after you write them.
- Each wrong option is the answer a student would give if they held one specific wrong idea; write that idea in `misconception`. When the wrong idea is a mix-up with another concept of the <concepts> or <confusable_concepts> list, also set `confusable_concept_id` to that concept's id. The correct option has neither.
- Set `mode` on every question: recall (bring the idea to mind from a cue, in a new situation), discrimination (choose between near-twin ideas; a wrong option names the twin in `confusable_concept_id`) or composition (run the idea inside a chain with other ideas). Use recall unless the concepts support another mode.
- List in source_excerpts the index of every excerpt a question is based on."""

APPLICATION_RULES = """Question design:
- At least half of the questions must apply a concept to a new situation (a fresh scenario, new numbers, a case the course materials do not show) rather than recall a definition or repeat an example.
- Use numbers, names and scenarios that differ from the worked examples in the excerpts and in the lesson. A student who memorised the examples must not be able to answer by recall.
- Each question tests a different concept from the excerpts."""

# ---- Audited prompts (PROMPTS_V2=generation). The v1 text above stays as it is until the area has
# run on v2 in production.

DIFFICULTY_GUIDANCE_V2 = {
    'easy': 'Test the core ideas one at a time, in simple new situations, with plain wording and small numbers.',
    'medium': 'Test understanding and application: the student decides which idea applies and uses it, with some analysis.',
    'hard': 'Require deep understanding and multi-step reasoning: ideas combined, edge cases, or a common mix-up resisted.',
}

# The option rules every choice question shares: quiz, exam, warm-up and review.
CHOICE_RULES = """- multiple_choice: exactly 4 options with ids A, B, C, D and one correct answer. Vary which letter is correct. Keep options short and put any code in the question text. Make the options about the same length, form and level of detail: the correct one is not the longest, the most specific or the only one with a qualification, which would give it away. When a wrong option states a rule, give it the same kind of conditions the right one has.
- Each wrong option is the answer a student would give if they held one specific wrong idea; write that idea in `misconception`. When the wrong idea is a mix-up with a concept of the <concepts> or <confusable_concepts> list, also set `confusable_concept_id` to that concept's id. The correct option has neither.
- In explanations, refer to options by their content, never by letter, because the options are shuffled after you write them."""

QUESTION_FORMAT_RULES_V2 = f"""Question rules:
{CHOICE_RULES}
- short_answer: answerable in 1-3 sentences; give a sample_answer and 2-4 key_points a grader can check.
- numerical: correct_answer is a plain number; give an absolute tolerance. Give `unit` only when the quantity has one (m/s, mol/L, dollars). For a probability, a count or a ratio leave `unit` empty: never put the name of the quantity there.
- true_false: correct_answer is a boolean; the explanation says why.
- Every question has an explanation of the correct answer and points from 1 to 5 by complexity.
- Set `mode` on every question: recall (bring the idea to mind from a cue, in a new situation), discrimination (choose between near-twin ideas; a wrong option names the twin in `confusable_concept_id`) or composition (run the idea inside a chain with other ideas). Use recall unless the concepts support another mode.
- List in source_excerpts the index of every excerpt a question is based on."""

APPLICATION_RULES_V2 = """Question design:
- At least half of the questions must apply a concept to a new situation (a fresh scenario, new numbers, a case the course materials do not show) rather than recall a definition or repeat an example.
- Use numbers, names and scenarios that differ from the worked examples in the excerpts and in the lesson. A student who memorised the examples must not be able to answer by recall.
- Spread the questions over the topic's ideas, and come back to an idea only from a different angle.
- Every answer key must follow from the excerpts, because a later check quotes the passage that supports it. For a new situation, the rule or method it applies has to be in the excerpts."""


def question_rules():
    """(difficulty guidance, question design rules, question format rules) for quiz and exam."""
    if prompts_v2("generation"):
        return DIFFICULTY_GUIDANCE_V2, APPLICATION_RULES_V2, QUESTION_FORMAT_RULES_V2
    return DIFFICULTY_GUIDANCE, APPLICATION_RULES, QUESTION_FORMAT_RULES


def question_set_schema():
    return QuestionSetV2 if prompts_v2("generation") else QuestionSet



def prerequisite_instructions(name: str, topic_name: str, review: int, question_count: int) -> str:
    return f"""
Review questions: exactly {review} of the {question_count} questions must test the prerequisite topic "{name}". Base them only on the excerpts marked use="prerequisite", list only those excerpt indexes in source_excerpts, and pitch them at a level a student who already learned "{name}" could answer. The other {question_count - review} questions are about "{topic_name}" as described above and never use the prerequisite excerpts.
"""


def minimum_usable(requested: int) -> int:
    """Fewest valid questions accepted before a set counts as failed."""
    return max(1, (requested + 1) // 2)


class QuizGenerator:
    """Generate section quizzes for topics."""

    def __init__(self):
        self.llm = LLMFactory.get_provider()

    async def generate_quiz(
        self,
        topic_id: str,
        topic_name: str,
        topic_description: str,
        question_count: int = 10,
        question_types: Optional[List[QuestionType]] = None,
        difficulty_level: str = "medium",
        focus: Optional[str] = None,
        cache_excerpts: bool = False,
        prerequisite_topic_id: Optional[str] = None,
        prerequisite_questions: int = 2,
    ) -> Dict:
        """
        Generate a quiz for a topic.

        Args:
            topic_id: Topic ID
            topic_name: Topic name
            topic_description: Topic description
            question_count: Number of questions (default: 10)
            question_types: List of question types to include (default: all)
            difficulty_level: easy, medium, or hard
            cache_excerpts: True for another set on a topic that already has a quiz, so the
                excerpt block is cached
            prerequisite_topic_id: a prerequisite topic (same course) to take 1-2 review
                questions from; ignored when it is the topic itself or has no excerpts
            prerequisite_questions: how many review questions (1-2)

        Returns:
            Dict with quiz questions and metadata
        """
        if question_types is None:
            question_types = list(QuestionType)

        context = await fetch_topic_context(topic_id)
        chunks = context.chunks
        if not chunks:
            raise NoSourceMaterialError(f"No source material is mapped to topic {topic_id}")
        seen = do_not_reuse_block(await existing_content_digest(topic_id))
        concepts = await fetch_concepts(topic_id)
        neighbours = await fetch_confusable_neighbours(topic_id)

        review = 0
        prerequisite_name = ""
        own_count = len(chunks)
        if prerequisite_topic_id and prerequisite_topic_id != topic_id:
            review = min(max(int(prerequisite_questions or 2), 1), 2, question_count // 3)
            extra = await self._prerequisite_chunks(prerequisite_topic_id) if review else []
            if extra:
                chunks = chunks + extra
                prerequisite_name = extra[0]["prerequisite_name"]
            else:
                review = 0
        if prerequisite_topic_id and not review:
            logger.info("Quiz for topic %s: prerequisite %s not used", topic_id, prerequisite_topic_id)

        questions, dropped, refilled = await self._generate_questions(
            topic_name=topic_name,
            topic_description=topic_description,
            chunks=chunks,
            question_count=question_count,
            question_types=question_types,
            difficulty_level=difficulty_level,
            focus=focus,
            cache_excerpts=cache_excerpts,
            course_map=context.course_map,
            already_seen=seen,
            concepts=format_concept_block(concepts, neighbours),
            review_instructions=(
                prerequisite_instructions(prerequisite_name, topic_name, review, question_count + SUPPORT_SPARE_QUESTIONS)
                if review else ""
            ),
        )
        if review:
            self._tag_prerequisite_questions(questions, own_count, len(chunks), prerequisite_name)
        resolve_concept_ids(questions, concepts, chunks, neighbours)
        attach_sources(questions, chunks)

        return {
            'questions': questions,
            'total_questions': len(questions),
            'dropped_unsupported': dropped,
            **refill_figures(question_count, len(questions), refilled),
            'difficulty_level': difficulty_level,
            'question_types': [qt.value for qt in question_types],
            'generated_at': datetime.now(UTC).isoformat()
        }

    async def _prerequisite_chunks(self, prerequisite_topic_id: str) -> List[Dict]:
        """The first primary-source excerpts of a prerequisite topic (empty when it has none)."""
        try:
            context = await fetch_topic_context(prerequisite_topic_id)
        except Exception as exc:  # the review is a bonus: never fail the quiz for it
            logger.info("Prerequisite topic %s unavailable: %s", prerequisite_topic_id, exc)
            return []
        primary = [c for c in context.chunks if c.get("source_kind") == "primary"] or list(context.chunks)
        kept: List[Dict] = []
        used = 0
        for chunk in primary[:PREREQUISITE_MAX_CHUNKS]:
            if kept and used + _tokens(chunk) > PREREQUISITE_TOKEN_BUDGET:
                break
            used += _tokens(chunk)
            kept.append({**chunk, "source_kind": "prerequisite", "prerequisite_name": context.topic["name"]})
        return kept

    @staticmethod
    def _tag_prerequisite_questions(questions: List[Dict], own_count: int, total: int, name: str) -> None:
        """Mark the questions whose excerpts all come from the prerequisite."""
        for question in questions:
            indexes = question.get("source_excerpts") or []
            if indexes and all(isinstance(i, int) and own_count < i <= total for i in indexes):
                question["prerequisite_topic"] = name

    async def _generate_questions(
        self,
        topic_name: str,
        topic_description: str,
        chunks: List[Dict],
        question_count: int,
        question_types: List[QuestionType],
        difficulty_level: str,
        focus: Optional[str] = None,
        cache_excerpts: bool = False,
        course_map: str = "",
        already_seen: str = "",
        concepts: str = "",
        review_instructions: str = "",
    ) -> tuple[List[Dict], int, int]:
        """Generate and validate quiz questions; return them, how many the support check dropped and how many a
        refill (SUPPORT_REFILL) added."""
        v2 = prompts_v2("generation")
        difficulties, application_rules, format_rules = question_rules()
        guidance = difficulties.get(difficulty_level, difficulties['medium'])
        types_str = ", ".join(qt.value for qt in question_types)
        closing = (
            "Name the ideas each question tests in `concepts_tested`."
            if v2
            else f'Set difficulty to "{difficulty_level}" and list the concepts each question tests.'
        )

        allowed = {qt.value for qt in question_types}

        async def ask(asked: int, review: str, avoid: str = "") -> tuple[List[Dict], int]:
            instructions = f"""Write a {asked}-question quiz on "{topic_name}" from the excerpts above.
{focus_line(focus)}
Difficulty: {difficulty_level}. {guidance}
Use only these question types, spread across them: {types_str}.

{application_rules}
{already_seen}{concepts}{review}{avoid}
{format_rules}
{closing}"""

            result = await self.llm.generate_structured(
                content_messages(topic_name, topic_description, chunks, instructions, cache_excerpts, course_map),
                question_set_schema(),
                max_tokens=16000,
                purpose="topic_quiz",
            )
            usable = [q for q in result.usable() if q["question_type"] in allowed][:asked]
            if v2:
                for question in usable:
                    question["difficulty"] = difficulty_level  # the code knows it; the model is not asked
            return await check_support(usable, chunks)

        questions, dropped = await ask(question_count + SUPPORT_SPARE_QUESTIONS, review_instructions)
        questions = questions[:question_count]
        floor = minimum_usable(question_count)

        async def regenerate(missing: int) -> List[Dict]:
            # Finding 102: once, for what the check removed, with one spare. The prerequisite review questions were
            # asked for the first time; a refill is plain questions on the topic.
            nonlocal dropped
            avoid = "\n\nDo not repeat these questions:\n" + "\n".join(f"- {q.get('question_text')}" for q in questions)
            more, more_dropped = await ask(missing + 1, "", avoid)
            dropped += more_dropped
            return more

        questions, refilled = await refill_once(questions, question_count, floor, regenerate)
        if len(questions) < floor:
            raise LLMOutputError(
                f"Quiz had {len(questions)} usable questions of {question_count} requested"
            )
        return questions, dropped, refilled

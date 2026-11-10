"""
Examples generator service.
Creates solved and interactive examples from material chunks.
"""

from typing import List, Dict, Optional
from datetime import UTC, datetime
from enum import Enum

from app.services.content_generator.context import (
    NoSourceMaterialError,
    attach_sources,
    content_messages,
    fetch_concepts,
    fetch_topic_context,
    focus_line,
    format_concept_block,
    resolve_concept_ids,
)
from app.services.content_generator.quiz import OPTION_SIMILARITY_RULE
from app.services.content_generator.refill import refill_figures, refill_wanted
from app.services.llm.base import LLMOutputError
from app.services.llm.factory import LLMFactory
from app.prompt_revision import prompts_v2
from app.services.llm.caps import output_cap
from app.services.llm.schemas import (
    InteractiveExampleSet,
    InteractiveExampleSetV2,
    SolvedExampleSet,
    SolvedExampleSetV2,
    word_form_hints,
)
from app.services.tutor.leak import judge_leak


# Prompt audit R5: under PROMPTS_V2=generation an interactive example's time comes from its step count, not the model.
MINUTES_PER_STEP = 3


class ExampleType(str, Enum):
    SOLVED = "solved"
    INTERACTIVE = "interactive"


SOLVED_GUIDANCE = {
    'easy': 'Straightforward problems that test basic understanding of the core concepts.',
    'medium': 'Moderately challenging problems that combine several concepts.',
    'hard': 'Complex problems that need deep understanding and multi-step reasoning.',
}

INTERACTIVE_GUIDANCE = {
    'easy': 'Straightforward problems with 2-3 steps.',
    'medium': 'Moderately challenging problems with 3-5 steps.',
    'hard': 'Complex problems with 5 or more steps that need deeper reasoning.',
}


class ExamplesGenerator:
    """Generate solved and interactive examples for topics."""

    def __init__(self):
        self.llm = LLMFactory.get_provider()

    async def generate_examples(
        self,
        topic_id: str,
        topic_name: str,
        topic_description: str,
        example_type: ExampleType,
        count: int = 3,
        difficulty_level: str = "medium",
        focus: Optional[str] = None,
        cache_excerpts: bool = False,
    ) -> Dict:
        """
        Generate examples for a topic.

        Args:
            topic_id: Topic ID
            topic_name: Topic name
            topic_description: Topic description
            example_type: Type of examples (solved or interactive)
            count: Number of examples to generate (default: 3)
            difficulty_level: easy, medium, or hard
            cache_excerpts: True for more examples of a type that already exists, so the
                excerpt block is cached

        Returns:
            Dict with generated examples and metadata
        """
        context = await fetch_topic_context(topic_id)
        chunks = context.chunks
        if not chunks:
            raise NoSourceMaterialError(f"No source material is mapped to topic {topic_id}")

        concepts = await fetch_concepts(topic_id)
        concept_block = format_concept_block(concepts)

        self._refilled = 0
        if example_type == ExampleType.SOLVED:
            examples = await self._generate_solved_examples(
                topic_name, topic_description, chunks, count, difficulty_level, focus, cache_excerpts,
                context.course_map, concept_block,
            )
        else:
            examples = await self._generate_interactive_examples(
                topic_name, topic_description, chunks, count, difficulty_level, focus, cache_excerpts,
                context.course_map, concept_block,
            )
        resolve_concept_ids(examples, concepts, chunks)
        # Each item says which excerpts it is based on; store the file and pages instead.
        attach_sources(examples, chunks)

        return {
            'examples': examples,
            **refill_figures(count, len(examples), self._refilled),
            'example_type': example_type,
            'difficulty_level': difficulty_level,
            'generated_at': datetime.now(UTC).isoformat()
        }

    async def _generate_solved_examples(
        self,
        topic_name: str,
        topic_description: str,
        chunks: List[Dict],
        count: int,
        difficulty_level: str,
        focus: Optional[str] = None,
        cache_excerpts: bool = False,
        course_map: str = "",
        concepts: str = "",
    ) -> List[Dict]:
        """Fully solved examples with step-by-step solutions."""
        guidance = SOLVED_GUIDANCE.get(difficulty_level, SOLVED_GUIDANCE['medium'])
        v2 = prompts_v2("generation")
        difficulty_line = "" if v2 else f'- Set difficulty to "{difficulty_level}".\n'
        instructions = f"""Write {count} distinct solved example problems on "{topic_name}" from the excerpts above.
{focus_line(focus)}
Difficulty: {difficulty_level}. {guidance}
{concepts}
- Make each problem realistic for this course and vary the problem types across the topic.
- Give complete step-by-step solutions. Each step has a one-line description, the work (math or reasoning), and why the step is taken.
- Name the key principle or formula used in each step.
- Keep final_answer short: 2-5 markdown bullets.
{difficulty_line}- List in source_excerpts the index of every excerpt an example is based on."""

        messages = content_messages(topic_name, topic_description, chunks, instructions, cache_excerpts, course_map)
        schema = SolvedExampleSetV2 if v2 else SolvedExampleSet
        cap = output_cap("solved_examples", 16000)
        result = await self.llm.generate_structured(messages, schema, max_tokens=cap, purpose="solved_examples")
        examples = [stored for example in result.examples if (stored := example.stored()) is not None]
        if refill_wanted(len(examples), 1):
            examples = await self._refill(
                messages, schema, cap, "solved_examples", examples, count, lambda e: e.stored()
            )
        if not examples:
            raise LLMOutputError("No usable solved examples were generated")
        if v2:
            for example in examples:
                example["difficulty"] = difficulty_level  # the code knows it; the model is not asked
        return examples[:count]

    async def _refill(self, messages, schema, max_tokens, purpose, examples, count, store) -> List[Dict]:
        """Finding 102: the first answer left nothing usable. Ask once more, with the same instructions, and keep what
        passes the same checks (the model call runs in the job's billing scope like the first)."""
        result = await self.llm.generate_structured(messages, schema, max_tokens=max_tokens, purpose=purpose)
        more = [stored for example in result.examples if (stored := store(example)) is not None]
        if purpose == "interactive_examples":
            more = await _clear_word_form_hints(more)
        self._refilled = len(more)
        return (examples + more)[:count]

    async def _generate_interactive_examples(
        self,
        topic_name: str,
        topic_description: str,
        chunks: List[Dict],
        count: int,
        difficulty_level: str,
        focus: Optional[str] = None,
        cache_excerpts: bool = False,
        course_map: str = "",
        concepts: str = "",
    ) -> List[Dict]:
        """Problems the student solves one step at a time."""
        guidance = INTERACTIVE_GUIDANCE.get(difficulty_level, INTERACTIVE_GUIDANCE['medium'])
        v2 = prompts_v2("generation")
        difficulty_line = "" if v2 else f'- Set difficulty to "{difficulty_level}".\n'
        # v2 adds the similar-length rule the other question types have.
        option_rule = f" {OPTION_SIMILARITY_RULE}" if v2 else ""
        instructions = f"""Write {count} interactive practice problems on "{topic_name}" from the excerpts above. The student solves each one step by step.
{focus_line(focus)}
Difficulty: {difficulty_level}. {guidance}
{concepts}
- Each step asks the student one short question and has the correct answer plus other acceptable forms of it.
- Give three hints that get gradually more specific: where to look, which idea applies, then the general form of the step. None of them contains the answer. Put them in `hints`, in that order.
- Each step builds on the one before.
- Give an explanation, feedback for a correct answer, and guidance for a wrong one.
- Answer types. Anything whose answer is a number (a count, a probability, a fraction, the result of arithmetic) is answer_type numeric: correct_answer is the number as a plain decimal or fraction, with no units or words, and tolerance is the accepted absolute difference (for example 0.005 for a probability to 3 decimals; 0 only for exact integers). Use multiple_choice when the student picks from options: put 2 to 5 options (ids A, B, C...) in `options`, never in the question text, and give the option id as correct_answer.{option_rule} Use text only for a short canonical word, term or expression (for example "independent" or "(1-p)^k p"); write it in one standard form. acceptable_answers lists other forms of the same answer, one form per entry; never put several answers in one entry.
- In explanations and feedback, refer to options by their content, never by letter. The options are shuffled after you write them.
{difficulty_line}- List in source_excerpts the index of every excerpt a problem is based on."""

        messages = content_messages(topic_name, topic_description, chunks, instructions, cache_excerpts, course_map)
        schema = InteractiveExampleSetV2 if v2 else InteractiveExampleSet
        cap = output_cap("interactive_examples", 16000)
        result = await self.llm.generate_structured(messages, schema, max_tokens=cap, purpose="interactive_examples")
        examples = [stored for example in result.examples if (stored := example.stored()) is not None]
        examples = await _clear_word_form_hints(examples)
        if refill_wanted(len(examples), 1):
            examples = await self._refill(
                messages, schema, cap, "interactive_examples", examples, count, lambda e: e.stored()
            )
        if not examples:
            raise LLMOutputError("No usable practice problems were generated")
        if v2:
            for example in examples:
                example["difficulty"] = difficulty_level  # the code knows it; the model is not asked
                example["estimated_time_minutes"] = max(5, MINUTES_PER_STEP * len(example["steps"]))
        return examples[:count]


async def _clear_word_form_hints(examples: List[Dict]) -> List[Dict]:
    """With LEAK_WORD_FORMS_TO_JUDGE, a problem whose only hint matches are number words ("add the two numbers" for 2)
    is kept unless the leak judge says the hint gives the answer away (finding 99). Until PR 5's gate reads
    generated sets, this judge is the only reader of such a hint."""
    kept: List[Dict] = []
    for example in examples:
        leaked = False
        for hint in word_form_hints(f"{example['title']}\n{example['problem_statement']}", example["steps"]):
            verdict = await judge_leak(hint["hint"], hint["answers"], problem=hint["problem"], question=hint["question"])
            if verdict.answer_revealed:
                leaked = True
                break
        if not leaked:
            kept.append(example)
    return kept

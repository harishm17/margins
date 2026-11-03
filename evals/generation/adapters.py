"""Everything the generation eval needs from app code, in one place.

The app is changing under this eval (learning v2 stage 2 replaces topic extraction with a
planner). Each function below calls the app's own code the way the app does; when the app
changes, edit these functions and keep their return shapes. Nothing else in the harness imports
from `app`.

    parse_model_spec / build_provider   the app's provider; `MeteredProvider` pins one model and effort
    MeteredProvider                     wraps a provider: model pin, spend gate, usage, latency, raw output
    extract_topics                      the app's topic extraction (stage 2 swaps this one)
    store_topics / map_topic            topic rows and chunk mappings, as the extract-topics job writes them
    make_generators / generate          the app's concept extraction, warm-up, notes, examples and quiz generators
    read_concept_graph                  a topic's stored concepts, claims, prerequisite edges and objective count
    fetch_excerpts                      the excerpts a topic is generated from
    app_cost                            the app's price table
"""
import os
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.model_spec import ModelChoice
from app.services.llm import anthropic_provider
from app.services.llm.base import LLMMessage, LLMProvider, LLMUsage
from app.services.llm.models import resolve_model as app_resolve_model

from spend import SpendTracker, estimate_prompt_tokens

MODEL_ALIASES = {
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-5-5",
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")

# Content types, in the order the app presents them, and the app purpose each one is billed under.
CONTENT_TYPES = ("concepts", "warmup", "notes", "solved", "interactive", "quiz")
PURPOSES = {
    "concepts": "extract_concepts",
    "warmup": "warmup",
    "notes": "section_notes",
    "solved": "solved_examples",
    "interactive": "interactive_examples",
    "quiz": "topic_quiz",
}


@dataclass(frozen=True)
class ModelSpec:
    alias: str
    model_id: str
    effort: str

    @property
    def label(self) -> str:
        return f"{self.alias}:{self.effort}"

    @property
    def slug(self) -> str:
        return f"{self.alias}-{self.effort}"


def parse_model_spec(spec: str) -> ModelSpec:
    """`opus:medium` or `claude-opus-5-5:high` (the effort is required, so it is never implicit)."""
    name, _, effort = spec.strip().partition(":")
    if not name or effort not in EFFORTS:
        raise SystemExit(f"bad model spec '{spec}': use <model>:<effort>, effort one of {', '.join(EFFORTS)}")
    model_id = MODEL_ALIASES.get(name, name)
    alias = name if name in MODEL_ALIASES else next((a for a, m in MODEL_ALIASES.items() if m == name), name)
    return ModelSpec(alias=alias, model_id=model_id, effort=effort)


def load_api_key(env_file: Optional[Path] = None) -> str:
    """ANTHROPIC_API_KEY from the environment, else from an .env file (never printed)."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    for path in [env_file] if env_file else []:
        if path and path.exists():
            for line in path.read_text().splitlines():
                match = re.match(r"\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$", line)
                if match:
                    return match.group(1).strip().strip("'\"")
    return ""


# Which model and effort a call uses is decided inside the app's provider, from the call's
# `purpose` (app/services/llm/models.py: MODEL_* settings). To compare models, the eval pins one
# model and effort for the duration of a call with this ContextVar, and the provider's resolver is
# wrapped once to honour it. A ContextVar is per task, so models running at the same time do not
# see each other's pin, and app behaviour is unchanged whenever no pin is set (topic extraction,
# for one, runs with the app's own choice).
_PINNED: ContextVar[Optional[ModelChoice]] = ContextVar("eval_pinned_model", default=None)
_installed = False


def install_model_pin() -> None:
    """Wrap `resolve_model` inside the Anthropic provider module so a pin takes effect. Idempotent."""
    global _installed
    if _installed:
        return
    if getattr(anthropic_provider, "resolve_model", None) is not app_resolve_model:
        raise RuntimeError("anthropic_provider.resolve_model changed; update adapters.install_model_pin")

    def resolve(purpose: str) -> ModelChoice:
        return _PINNED.get() or app_resolve_model(purpose)

    anthropic_provider.resolve_model = resolve
    _installed = True


@contextmanager
def pinned_model(spec: Optional["ModelSpec"]):
    token = _PINNED.set(ModelChoice(spec.model_id, spec.effort) if spec else None)
    try:
        yield
    finally:
        _PINNED.reset(token)


def build_provider(*, mock: bool, api_key: str = "", timeout: float = 600.0) -> LLMProvider:
    """The app's provider, built the way LLMFactory builds it (but with this eval's timeout).

    It does not choose the model: wrap it in a MeteredProvider with a ModelSpec to pin one.
    """
    if mock:
        from app.services.llm.mock_provider import MockProvider

        return MockProvider()
    from app.config import settings

    install_model_pin()
    return anthropic_provider.AnthropicProvider(
        api_key=api_key, timeout=timeout, max_retries=settings.LLM_MAX_RETRIES
    )


def app_choice_spec(purpose: str) -> ModelSpec:
    """The model and effort the app itself resolves for `purpose`, as a ModelSpec (for labels)."""
    choice = app_resolve_model(purpose)
    return ModelSpec(alias=choice.model, model_id=choice.model, effort=choice.effort or "none")


# ---------------------------------------------------------------------------------------
# Cost
# ---------------------------------------------------------------------------------------


def app_cost(usage: LLMUsage) -> float:
    """The app's own estimate of one call's cost (0 for a model it has no price for)."""
    from app.services.llm.usage import estimate_cost_usd

    return estimate_cost_usd(usage) or 0.0


def estimate_cost(model: str, input_tokens: int, output_tokens: int, cache_write_tokens: int) -> Optional[float]:
    from app.services.llm.usage import estimate_cost_usd

    return estimate_cost_usd(
        LLMUsage(
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_creation_input_tokens=cache_write_tokens,
        )
    )


# ---------------------------------------------------------------------------------------
# The metered provider
# ---------------------------------------------------------------------------------------


class MeteredProvider(LLMProvider):
    """Wraps the app's provider for one model.

    With a `spec`, every call is pinned to that model and effort. Without one, the app's own
    choice for the call's purpose applies. Before each call it asks the SpendTracker for permission (raising SpendLimitReached when the
    call would pass a cap). After each call it records purpose, latency, token usage, cost and
    the raw model output in `calls`. Only `generate_text` and `generate_structured` are
    supported, which is all the content generators and the judge use.
    """

    def __init__(self, inner: LLMProvider, spec: Optional[ModelSpec], tracker: SpendTracker, kind: str):
        self.inner = inner
        self.spec = spec
        self.tracker = tracker
        self.kind = kind
        self.calls: List[Dict[str, Any]] = []

    def model_for(self, purpose: str):
        return self._model_id(purpose)

    def _model_id(self, purpose: str) -> str:
        return self.spec.model_id if self.spec else app_resolve_model(purpose).model

    def _gate(self, messages: List[LLMMessage], purpose: str, schema=None):
        schema_json = schema.model_json_schema() if schema is not None else None
        prompt_tokens = estimate_prompt_tokens([m.content for m in messages], schema_json)
        return self.tracker.reserve(self.kind, self._model_id(purpose), purpose, prompt_tokens)

    async def _metered(self, call, messages, purpose, schema, raw_of):
        from app.services.llm.usage import track_llm_usage

        token, estimate = self._gate(messages, purpose, schema)
        started = time.perf_counter()
        error: Optional[BaseException] = None
        result = None
        with track_llm_usage() as usages, pinned_model(self.spec):
            try:
                result = await call()
            except Exception as exc:  # recorded, then raised
                error = exc
        latency = time.perf_counter() - started
        cost = sum(app_cost(u) for u in usages)
        output_tokens = sum(u.output_tokens for u in usages)
        self.tracker.settle(token, self._model_id(purpose), purpose, cost, output_tokens if error is None else None)
        self.calls.append(
            {
                "purpose": purpose,
                "model": self._model_id(purpose),
                "effort": self.spec.effort if self.spec else app_resolve_model(purpose).effort,
                "latency_s": round(latency, 2),
                "estimate_usd": round(estimate, 5),
                "cost_usd": round(cost, 6),
                "input_tokens": sum(u.input_tokens for u in usages),
                "output_tokens": output_tokens,
                "cache_read_input_tokens": sum(u.cache_read_input_tokens for u in usages),
                "cache_creation_input_tokens": sum(u.cache_creation_input_tokens for u in usages),
                "response_models": sorted({u.model for u in usages}),
                "error": f"{type(error).__name__}: {error}" if error else None,
                "raw_output": raw_of(result) if error is None else None,
            }
        )
        if error is not None:
            raise error
        return result

    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        return await self._metered(
            lambda: self.inner.generate_text(messages, purpose=purpose, max_tokens=max_tokens),
            messages,
            purpose,
            None,
            lambda response: response.content,
        )

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        return await self._metered(
            lambda: self.inner.generate_structured(messages, schema, purpose=purpose, max_tokens=max_tokens),
            messages,
            purpose,
            schema,
            lambda parsed: parsed.model_dump(),
        )

    def stream_cited_answer(self, **kwargs):
        raise NotImplementedError("the eval does not use chat answers")


# ---------------------------------------------------------------------------------------
# Topics
# ---------------------------------------------------------------------------------------


async def extract_topics(project_id: str, provider: LLMProvider) -> List[Dict[str, Any]]:
    """The app's course planner, called as the extract-topics job calls it.

    Sets each material's role the way validation would (syllabus and calendar pages are
    `syllabus`, sample exams `exam`, the rest `content`), plans the course and stores the plan
    (units, topics, topic sources). Returns one dict per topic in study order, with the stored
    `id` so the runner keeps the planner's topics and sources instead of re-mapping them.
    """
    from app.db.connection import execute_query, execute_update
    from app.services.course_planner import plan_course, write_plan
    from app.services.llm.factory import LLMFactory

    await execute_update(
        """
        UPDATE materials SET role = CASE
            WHEN category = 'sample_exams' THEN 'exam'
            WHEN category = 'syllabus' OR filename ~* '(syllabus|calendar|schedule)' THEN 'syllabus'
            ELSE 'content' END
        WHERE project_id = $1
        """,
        project_id,
    )
    previous = LLMFactory._instance
    LLMFactory._instance = provider  # the planner asks the factory for its provider
    try:
        job = await plan_course(project_id)
        await write_plan(job)
    finally:
        LLMFactory._instance = previous
    rows = await execute_query(
        """
        SELECT t.id, t.name, t.description, t.keywords, t.objectives, t.estimated_minutes,
               u.title AS unit, u.order_index AS unit_order
        FROM topics t LEFT JOIN units u ON u.id = t.unit_id
        WHERE t.project_id = $1
        ORDER BY t.order_index
        """,
        project_id,
    )
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "description": r["description"] or "",
            "keywords": list(r["keywords"] or []),
            "unit": r["unit"],
            "objectives": list(r["objectives"] or []),
            "estimated_minutes": r["estimated_minutes"],
        }
        for r in rows
    ]


async def store_topics(project_id: str, topics: List[Dict[str, Any]]) -> List[str]:
    """Replace the project's topics with `topics` and return their ids, in order."""
    from app.db.connection import execute_one, execute_update

    await execute_update("DELETE FROM topics WHERE project_id = $1", project_id)
    ids = []
    for index, topic in enumerate(topics):
        row = await execute_one(
            """
            INSERT INTO topics
            (id, project_id, name, description, keywords, order_index, source_material_ids, user_confirmed)
            VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, FALSE)
            RETURNING id
            """,
            project_id,
            topic["name"],
            topic.get("description") or "",
            [k for k in topic.get("keywords", []) if k] or [topic["name"].lower()],
            index,
            [],
        )
        ids.append(row["id"])
    return ids


async def map_topic(project_id: str, topic_id: str, topic: Dict[str, Any]) -> int:
    """Map a topic to its chunks the way the extract-topics job does; returns the chunk count."""
    from app.db.connection import execute_in_transaction
    from app.services.content_generator.context import TOPIC_CHUNK_LIMIT
    from app.services.embeddings.search import hybrid_search_chunks
    from app.services.embeddings.topic_mapping import replace_topic_mappings

    chunks = await hybrid_search_chunks(
        project_id,
        topic["name"],
        topic.get("description") or "",
        topic.get("keywords") or [],
        limit=TOPIC_CHUNK_LIMIT,
    )

    async def replace(conn):
        await replace_topic_mappings(conn, topic_id, chunks)

    await execute_in_transaction(replace)
    return len(chunks)


async def fetch_excerpts(topic_id: str) -> List[Dict[str, Any]]:
    """The excerpts the generators read for this topic, in the order they see them."""
    from app.services.content_generator.context import fetch_topic_chunks

    rows = await fetch_topic_chunks(topic_id)
    return [
        {
            "chunk_id": str(row["id"]),
            "filename": row["filename"],
            "category": row["category"],
            "pages": [row["page_start"], row["page_end"]],
            "section": row["section_hierarchy"],
            "text": row["chunk_text"],
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------------------


def make_generators(provider: LLMProvider) -> Dict[str, Any]:
    """The app's three generators, bound to `provider`.

    They take their provider from the factory when constructed, so it is set for that moment.
    """
    from app.services.content_generator import ExamplesGenerator, NotesGenerator, QuizGenerator
    from app.services.llm.factory import LLMFactory

    previous = LLMFactory._instance
    LLMFactory._instance = provider
    try:
        # Concept extraction and the warm-up are functions that ask the factory for their provider
        # when they run, so the provider rides along for `generate` to install around them.
        return {"notes": NotesGenerator(), "examples": ExamplesGenerator(), "quiz": QuizGenerator(), "provider": provider}
    finally:
        LLMFactory._instance = previous


def notes_expectations() -> Dict[str, Any]:
    """Section labels the notes prompt asks for, so the structure check follows the prompt."""
    try:
        from app.services.content_generator.notes import _SECTION_LABELS

        return {"sections": list(_SECTION_LABELS)}
    except ImportError:
        return {}


async def generate(generators: Dict[str, Any], topic: Dict[str, Any], content_type: str, params: Dict[str, Any]):
    """Run one generator for one topic and return what the app would store as the content.

    notes: markdown string; solved / interactive: list of examples; quiz: list of questions.
    `topic` has id, name, description. Calls mirror generate_content_job in jobs.py.
    concepts: the topic's stored graph after extraction (`read_concept_graph`); warmup: the warm-up
    questions. Both write to the topic's rows, so models must run one after another (run_eval does).
    """
    from app.services.content_generator.examples import ExampleType

    if content_type in ("concepts", "warmup"):
        return await _generate_graph_type(generators["provider"], topic, content_type)

    common = dict(topic_id=topic["id"], topic_name=topic["name"], topic_description=topic["description"])
    if content_type == "notes":
        result = await generators["notes"].generate_notes(
            **common, user_preferences={"detail_level": params["detail_level"]}
        )
        return result["content"]
    if content_type in ("solved", "interactive"):
        result = await generators["examples"].generate_examples(
            **common,
            example_type=ExampleType.SOLVED if content_type == "solved" else ExampleType.INTERACTIVE,
            count=params["examples"],
            difficulty_level=params["difficulty"],
        )
        return result["examples"]
    if content_type == "quiz":
        result = await generators["quiz"].generate_quiz(
            **common, question_count=params["questions"], difficulty_level=params["difficulty"]
        )
        return result["questions"]
    raise ValueError(f"unknown content type {content_type}")


async def _generate_graph_type(provider: LLMProvider, topic: Dict[str, Any], content_type: str):
    """Run concept extraction or the warm-up generator with `provider` installed in the factory."""
    from app.services.llm.factory import LLMFactory

    previous = LLMFactory._instance
    LLMFactory._instance = provider
    try:
        if content_type == "concepts":
            from app.services.concepts.extractor import extract_concepts

            await extract_concepts(topic["id"])
            return await read_concept_graph(topic["id"])
        from app.services.content_generator.warmup import generate_warmup

        return (await generate_warmup(topic["id"]))["questions"]
    finally:
        LLMFactory._instance = previous


async def read_concept_graph(topic_id: str) -> Dict[str, Any]:
    """The topic's active concepts with their claims and the edges that touch them, as stored.

    Shape: objective_count, concepts[{id, name, objective_indexes}], claims[{concept_id, chunk_id,
    quote}], edges[{source_id, target_id, type}]. Edges to concepts of other topics are included
    (a prerequisite cycle can run through them).
    """
    from app.db.connection import execute_query, execute_one

    topic = await execute_one("SELECT objectives FROM topics WHERE id = $1", topic_id)
    concepts = await execute_query(
        "SELECT id, name, objective_indexes FROM concepts WHERE topic_id = $1 AND status = 'active' ORDER BY order_index, id",
        topic_id,
    )
    ids = [c["id"] for c in concepts]
    claims = await execute_query(
        "SELECT concept_id, chunk_id, quote FROM concept_claims WHERE concept_id = ANY($1::text[]) ORDER BY concept_id, order_index",
        ids,
    )
    edges = await execute_query(
        "SELECT source_id, target_id, type FROM concept_edges WHERE source_id = ANY($1::text[]) OR target_id = ANY($1::text[])",
        ids,
    )
    return {
        "objective_count": len([o for o in (topic["objectives"] if topic else None) or [] if o]),
        "concepts": [{"id": c["id"], "name": c["name"], "objective_indexes": list(c["objective_indexes"] or [])} for c in concepts],
        "claims": [{"concept_id": c["concept_id"], "chunk_id": c["chunk_id"], "quote": c["quote"]} for c in claims],
        "edges": [{"source_id": e["source_id"], "target_id": e["target_id"], "type": e["type"]} for e in edges],
    }

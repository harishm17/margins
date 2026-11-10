"""Which model and effort each kind of LLM call uses.

Every call site passes a `purpose`; this module maps it to a `MODEL_*` setting, and the
setting to a model id and an effort. The map is the only place that knows which purpose
belongs to which setting:

    purpose                 setting            used by
    section_notes           MODEL_NOTES        notes generator
    solved_examples         MODEL_EXAMPLES     worked examples generator
    interactive_examples    MODEL_PRACTICE     step-by-step practice generator
    topic_quiz              MODEL_QUIZ         topic quiz generator
    exam_questions          MODEL_EXAM         mock exam question generator
    grade_short_answer      MODEL_GRADING      exam short-answer grader
    extract_topics          MODEL_TOPICS       course planner (units, topics, sources)
    extract_concepts        MODEL_CONCEPTS     concept graph of one topic (MODEL_TOPICS when empty)
    link_concepts           MODEL_CONCEPTS     cross-topic links of one unit (same setting)
    requote_concepts        MODEL_CONCEPTS     new claims for concepts that lost theirs (same setting)
    warmup                  MODEL_WARMUP       warm-up (pretest) questions (MODEL_QUIZ when empty)
    gap_explainer           MODEL_GAP_EXPLAINER  explanations of what a recall answer missed (MODEL_NOTES when empty)
    review_items            MODEL_QUIZ         new items for review sessions
    router                  MODEL_ROUTER       answer-key support check of generated sets; tutor leak judge; Ask routing
    tutor                   MODEL_TUTOR        practice tutor replies
    recall_grading          MODEL_RECALL_GRADING  verdicts on a recall answer, claim by claim
    exam_style              MODEL_TOPICS       past-exam style profile (always at low effort)
    order_units             MODEL_VALIDATION   cross-file unit order of a large course plan
    chat                    MODEL_CHAT         "Ask your materials" answers
    voice                   MODEL_VOICE        voice coach turns
    voice_drill             MODEL_VOICE        voice drill packs
    validate_material       MODEL_VALIDATION   upload validation

A setting is "<model-id>:<effort>". Accepted forms:

    ""                    the fallback model and effort for the purpose
    "claude-opus-5-5"     that model, with the fallback effort
    "claude-opus-5-5:low" that model and effort
    ":low"                the fallback model, that effort
    "claude-opus-5-5:none"  that model with no effort parameter

The fallback is ANTHROPIC_MODEL with ANTHROPIC_EFFORT for the "main" purposes and
ANTHROPIC_FAST_MODEL with ANTHROPIC_FAST_EFFORT for the "fast" ones, which is how the service
behaved before purposes had settings of their own.
"""
from dataclasses import dataclass
from typing import Literal, Optional

from app.config import settings
from app.model_spec import ModelChoice, parse_model_spec

Tier = Literal["main", "fast"]


@dataclass(frozen=True)
class PurposeConfig:
    setting: str
    fallback_tier: Tier
    # Set when a purpose shares another's model but always runs at this effort, whatever the
    # setting says.
    effort: Optional[str] = None
    # The setting used when this one is empty, before the tier fallback.
    inherits: Optional[str] = None


PURPOSES = {
    "section_notes": PurposeConfig("MODEL_NOTES", "main"),
    "solved_examples": PurposeConfig("MODEL_EXAMPLES", "main"),
    "interactive_examples": PurposeConfig("MODEL_PRACTICE", "main"),
    "topic_quiz": PurposeConfig("MODEL_QUIZ", "main"),
    "exam_questions": PurposeConfig("MODEL_EXAM", "main"),
    "grade_short_answer": PurposeConfig("MODEL_GRADING", "fast"),
    "extract_topics": PurposeConfig("MODEL_TOPICS", "fast"),
    "extract_concepts": PurposeConfig("MODEL_CONCEPTS", "fast", inherits="MODEL_TOPICS"),
    "requote_concepts": PurposeConfig("MODEL_CONCEPTS", "fast", inherits="MODEL_TOPICS"),
    "link_concepts": PurposeConfig("MODEL_CONCEPTS", "fast", inherits="MODEL_TOPICS"),
    "warmup": PurposeConfig("MODEL_WARMUP", "main", inherits="MODEL_QUIZ"),
    "gap_explainer": PurposeConfig("MODEL_GAP_EXPLAINER", "main", inherits="MODEL_NOTES"),
    "review_items": PurposeConfig("MODEL_QUIZ", "main"),
    "router": PurposeConfig("MODEL_ROUTER", "fast"),
    "tutor": PurposeConfig("MODEL_TUTOR", "main"),
    "recall_grading": PurposeConfig("MODEL_RECALL_GRADING", "main"),
    "exam_style": PurposeConfig("MODEL_TOPICS", "fast", effort="low"),
    "chat": PurposeConfig("MODEL_CHAT", "main"),
    "voice": PurposeConfig("MODEL_VOICE", "fast"),
    "voice_drill": PurposeConfig("MODEL_VOICE", "fast"),
    "validate_material": PurposeConfig("MODEL_VALIDATION", "fast"),
    "order_units": PurposeConfig("MODEL_VALIDATION", "fast"),
}

MODEL_SETTINGS = tuple(sorted({config.setting for config in PURPOSES.values()}))


def tier_choice(tier: Tier) -> ModelChoice:
    """The fallback for a tier, from the ANTHROPIC_* settings."""
    if tier == "fast":
        return ModelChoice(settings.ANTHROPIC_FAST_MODEL, settings.ANTHROPIC_FAST_EFFORT or None)
    return ModelChoice(settings.ANTHROPIC_MODEL, settings.ANTHROPIC_EFFORT or None)


def resolve_model(purpose: str) -> ModelChoice:
    """The model and effort for a call. An unknown purpose is a bug in the caller."""
    config = PURPOSES.get(purpose)
    if config is None:
        raise ValueError(
            f"Unknown LLM purpose {purpose!r}: add it to PURPOSES in app/services/llm/models.py"
        )
    spec = getattr(settings, config.setting)
    if not spec and config.inherits:
        spec = getattr(settings, config.inherits)
    choice = parse_model_spec(spec, tier_choice(config.fallback_tier))
    if config.effort is not None:
        choice = ModelChoice(choice.model, config.effort)
    return choice


def check_model_prices() -> None:
    """Refuse to start when any model a purpose can resolve to has no price (usage.py): its calls would otherwise
    be billed from a guess. Names the setting to fix. Only the real provider matters: the mock and replay providers
    report made-up or recorded model names."""
    from app.services.llm.usage import has_price

    if settings.LLM_PROVIDER.strip().lower() != "anthropic":
        return
    problems = []
    for purpose, config in sorted(PURPOSES.items()):
        model = resolve_model(purpose).model
        if not has_price(model):
            source = config.setting if getattr(settings, config.setting) or config.inherits and getattr(settings, config.inherits) else (
                "ANTHROPIC_FAST_MODEL" if config.fallback_tier == "fast" else "ANTHROPIC_MODEL"
            )
            problems.append(f"{source} (purpose {purpose}) is {model!r}")
    if problems:
        raise RuntimeError(
            "These models have no price in app/services/llm/usage.py, so their cost cannot be counted: "
            + "; ".join(problems)
            + ". Add the price there or change the setting."
        )

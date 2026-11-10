"""Output caps (max_tokens) of the audited (v2) model calls, in one place (prompt audit R7, 2026-11-10).

On the 5.5 models thinking counts against max_tokens, so a cap set for the answer alone cuts the answer off once the
model thinks first. The v1 caps were set call by call before that; each v2 cap below is the v1 cap plus room for
thinking. A cap only bounds a reply (output is billed as used), so the headroom costs nothing unless it is used.

`output_cap(call, v1)` returns the v1 cap until the call's prompt area is on v2 (`PROMPTS_V2`), so a deploy with the
flag empty sends the same requests as before. A call whose cap is over STREAM_ABOVE is streamed by the provider: a
non-streamed request that long can run past the HTTP timeout. Each call's log line carries its cap and the share of it
the reply used, which the 1.9a watchdog reads.
"""
from typing import Dict, NamedTuple

from app.prompt_revision import prompts_v2

# Calls with a cap above this are streamed (anthropic_provider._create).
STREAM_ABOVE = 16000


class Cap(NamedTuple):
    area: str  # the PROMPTS_V2 area whose flag switches the call to its v2 cap
    tokens: int


OUTPUT_CAPS: Dict[str, Cap] = {
    # Generation: question sets and examples write long JSON; the support check reads them all at once.
    "quiz": Cap("generation", 24000),
    "review_items": Cap("generation", 24000),
    "warmup": Cap("generation", 12000),
    "solved_examples": Cap("generation", 24000),
    "interactive_examples": Cap("generation", 24000),
    "exam_questions": Cap("generation", 24000),
    "gap_explainer": Cap("generation", 12000),
    "exam_relevance": Cap("generation", 12000),
    "exam_style": Cap("generation", 8000),
    "support_check": Cap("support", 16000),
    # Tutors and graders: short replies, room to think before them.
    "practice_tutor": Cap("tutor", 4000),
    "reader_tutor": Cap("tutor", 4000),
    "recall_grader": Cap("tutor", 8000),
    "leak_judge": Cap("tutor", 3000),  # Ask's leak judge too: judge_leak takes the caller's v2 flag
    "short_answer_grader": Cap("grading", 6000),
    # Ask's own cap is CHAT_MAX_TOKENS_V2 (a setting); its router is here.
    "ask_router": Cap("ask", 2000),
    # Ingest.
    "course_plan": Cap("ingest", 32000),
    "unit_order": Cap("ingest", 4000),
    "concept_extraction": Cap("ingest", 24000),
    "concept_links": Cap("ingest", 16000),
    "upload_check": Cap("ingest", 4000),
    # Voice: the drill set (the turn's cap is VOICE_MAX_TOKENS, sent by the web app's turn engine).
    "voice_drill": Cap("voice", 12000),
}


def output_cap(call: str, v1: int) -> int:
    """The max_tokens for `call`: its v2 cap when its area is on v2, else `v1` (the cap the call always had)."""
    cap = OUTPUT_CAPS[call]
    return cap.tokens if prompts_v2(cap.area) else v1

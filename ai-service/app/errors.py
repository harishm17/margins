"""One mechanism for errors that leave the code: a code plus the public message for that code (SEC-L3, OPS-M6).

Raw exception text can hold a student's words, a model's reply, an answer key, a file path or a provider's wording. So
nothing that is stored (`processing_jobs.error_message`, material notes, ops events) or returned (job responses, NDJSON
error events, HTTP error bodies) is ever built from an exception's text. It is built from the error's `code`, and the
text for a code is fixed here. The same text is what the web app shows or can fall back to (frontend/src/lib/ai/messages.ts
has one entry for each of these codes; tests/test_error_text.py keeps the two tables in step).

What went wrong in detail goes to the log only, through the log filter (app/logging_utils.py), which writes any
exception as `ClassName(code)`. `describe_exception` is the same text for the places that store a note for the operator.
"""
from __future__ import annotations

from typing import Optional

# Shown when a code has no entry of its own.
GENERIC_MESSAGE = "Something went wrong. Try again in a moment."

PUBLIC_MESSAGES: dict[str, str] = {
    # The model could not be used, or did not answer usefully.
    "LLM_ERROR": GENERIC_MESSAGE,
    "LLM_NOT_CONFIGURED": "AI features are paused right now.",
    "LLM_AUTH_FAILED": "AI features are paused right now.",
    "LLM_CREDIT_EXHAUSTED": "AI features are paused right now.",
    "LLM_REQUEST_REJECTED": "The AI could not take this request.",
    "LLM_REFUSED": "The AI declined to write this from your material.",
    "LLM_RATE_LIMITED": "The AI is busy right now. Try again in a few minutes.",
    "LLM_UNAVAILABLE": "The AI is busy right now. Try again in a few minutes.",
    "LLM_BUSY": "Margins is busy right now. Try again in a moment.",
    "LLM_BAD_OUTPUT": "The AI returned an answer the app could not use.",
    "LLM_REPLAY_MISS": "No recorded answer exists for this request.",
    "LLM_DAILY_BUDGET": "You've used today's AI allowance.",
    # The voice prompt flag differs between the web app and this service (a deploy in progress, prompt audit R9).
    "PROMPTS_MISMATCH": "Voice is being updated. Try again in a few minutes.",
    "AI_UNREACHABLE": "AI features are paused right now.",
    # Jobs.
    "JOB_FAILED": GENERIC_MESSAGE,
    "INVALID_INPUT": "The request was not complete.",
    "ENQUEUE_FAILED": "The job could not be started.",
    "ENQUEUE_PERMANENT": "The job could not be started.",
    "JOB_DISPATCH_FAILED": "The job could not be started.",
    "JOB_LEASE_EXPIRED": "The work stopped before it finished.",
    "STORAGE_UNAVAILABLE": "Your files could not be read just now.",
    "NO_SOURCE_MATERIAL": "None of your uploaded material matched this topic.",
    "NO_CONTENT_MATERIALS": "Every material in this course is marked as a syllabus or a past exam.",
    "NO_CONTENT": "No readable text was found in this file.",
    "MATERIAL_UNREADABLE": "This file could not be read.",
    "MATERIAL_NOT_FOUND": "That file was removed before it could be read.",
    "SUBMISSION_NOT_FOUND": "That exam attempt could not be found.",
    "QUIZ_SUBMISSION_NOT_FOUND": "That quiz attempt could not be found.",
    "VALIDATION_FAILED": "We could not check this file.",
    "CHUNKING_FAILED": "We could not read the pages of this file.",
    "TOPIC_EXTRACTION_FAILED": "We could not find the topics in your files.",
    "CONTENT_GENERATION_FAILED": "The study content could not be written.",
    "CONCEPT_EXTRACTION_FAILED": "We could not find the concepts in this topic.",
    "CONCEPT_REQUOTE_FAILED": "We could not find some ideas again in your remaining files.",
    "CONCEPT_LINKING_FAILED": "We could not link the concepts in this topic.",
    "REVIEW_ITEMS_FAILED": "The review items could not be written.",
    "GAP_EXPLAINER_FAILED": "The explanation could not be written.",
    "EXAM_GENERATION_FAILED": "The mock exam could not be written.",
    "EXAM_GRADING_FAILED": "We could not finish grading this exam.",
    "QUIZ_GRADING_FAILED": "We could not finish grading this quiz.",
    "EXAM_PROFILE_FAILED": "We could not read the style of your past exams.",
    "EXAM_RELEVANCE_FAILED": "We could not match your past exams to your topics.",
    # Requests, chat and voice.
    "NOT_FOUND": "We could not find that.",
    "PROJECT_NOT_FOUND": "We could not find that course.",
    "ATTEMPT_NOT_FOUND": "We could not find that attempt.",
    "RETRIEVAL_FAILED": "The materials could not be searched just now.",
    "CHAT_FAILED": "The answer could not be written.",
    "VOICE_TURN_FAILED": "The coach could not reply.",
    "VALIDATION_ERROR": "The request was not valid.",
}

# What material.validation_notes says when the check itself could not run (validator.py): one fixed note per reason.
VALIDATION_NOTES = {
    "llm_unavailable": "Validation completed using structural checks only (the AI check was unavailable).",
    "unsupported_type": "This file type is not supported. Supported formats: .pdf, .docx, .pptx, .doc",
}


def public_message(code: Optional[str]) -> str:
    """The text for an error code. Unknown or missing codes get the generic text, never anything the code carried."""
    return PUBLIC_MESSAGES.get(code or "", GENERIC_MESSAGE)


def exception_code(exc: BaseException) -> Optional[str]:
    """The code an exception carries: our own `code`, a database error's SQLSTATE, or an HTTP status. Nothing else
    about the exception is read, because everything else can hold text a student wrote."""
    for name in ("code", "sqlstate", "status_code"):
        value = getattr(exc, name, None)
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip():
            text = str(value)
            if len(text) <= 60 and text.replace("_", "").replace("-", "").isalnum():
                return text
    return None


def describe_exception(exc: BaseException) -> str:
    """`ClassName(code)`, or `ClassName` when the exception has no code: what logs and operator notes say about it."""
    code = exception_code(exc)
    name = type(exc).__name__
    return f"{name}({code})" if code else name


def error_body(code: str, retryable: bool = False, **extra: object) -> dict:
    """The JSON body of an error response: the code and its public message, the one shape every route returns."""
    return {"detail": public_message(code), "error_code": code, "retryable": retryable, **extra}

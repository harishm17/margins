"""No exception text reaches a log, a stored error or a response (SEC-L3, OPS-M6, contract C5).

A sentinel string stands for what a failure can carry: a student's answer, an answer key, a provider's echo of the
request. It is put into the exception of each failure path, and must come out nowhere: not in the captured log (written
by a real handler with the real filter), not in the job row, not in the HTTP body or stream event.
"""
import io
import logging
import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api.routes.voice import VoiceTurnRequest, stream_voice_turn
from app.errors import PUBLIC_MESSAGES, describe_exception, public_message
from app.logging_utils import LogScrubFilter, configure_logging
from app.main import app
from app.models.jobs import JobPayload
from app.services import dispatch as dispatch_module
from app.services.document_processor import validator
from app.services.document_processor.parse_types import ExtractedDocument, ExtractedPage
from app.services.job_runner import job_handler, JobOutcome
from app.services.llm.base import LLMMessage, LLMRequestError, LLMUnavailableError
from app.services.llm.factory import LLMFactory
from tests.db_helpers import get_job, seed_job, seed_user

SENTINEL = "SENTINEL-4f9c1e7a-answer-key"
WEB_MESSAGES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "ai" / "messages.ts"
JOBS_ROUTES = Path(__file__).resolve().parents[1] / "app" / "api" / "routes" / "jobs.py"


@pytest.fixture
def log():
    """A real stderr-style handler on the root logger with the app's filter installed the way production installs it."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    previous_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    configure_logging()
    assert any(isinstance(f, LogScrubFilter) for f in handler.filters)
    yield stream
    root.removeHandler(handler)
    root.setLevel(previous_level)


def test_every_code_the_web_table_knows_has_a_public_message_here():
    web_codes = set(re.findall(r"^  ([A-Z][A-Z_]+):", WEB_MESSAGES.read_text(), flags=re.MULTILINE))
    assert web_codes, "the web table could not be read"
    assert sorted(web_codes - set(PUBLIC_MESSAGES)) == []


def test_every_job_default_code_has_a_public_message():
    codes = set(re.findall(r'default_error_code="([A-Z_]+)"', JOBS_ROUTES.read_text()))
    codes |= set(re.findall(r'PermanentJobError\([^)]*?"([A-Z_]{6,})"\)', JOBS_ROUTES.read_text()))
    assert codes and sorted(codes - set(PUBLIC_MESSAGES)) == []


class TestLogFilter:
    def test_an_exception_argument_is_written_as_class_and_code(self, log):
        logging.getLogger("app.test").warning("failed: %s", LLMRequestError(detail=SENTINEL))
        logging.getLogger("app.test").warning("failed again: %s", ValueError(SENTINEL))
        text = log.getvalue()
        assert SENTINEL not in text
        assert "LLMRequestError(LLM_REQUEST_REJECTED)" in text and "ValueError" in text

    def test_a_traceback_keeps_its_frames_and_loses_the_message(self, log):
        def inner():
            raise KeyError(SENTINEL)

        try:
            try:
                inner()
            except KeyError as exc:
                raise RuntimeError(SENTINEL) from exc
        except RuntimeError:
            logging.getLogger("app.test").exception("it broke")
        text = log.getvalue()
        assert SENTINEL not in text
        assert "in inner" in text and "KeyError" in text and "RuntimeError" in text

    def test_secrets_are_still_redacted(self, log, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "tok-" + SENTINEL)
        logging.getLogger("app.test").warning("header %s", "tok-" + SENTINEL)
        assert SENTINEL not in log.getvalue() and "[REDACTED]" in log.getvalue()

    def test_a_record_from_a_child_logger_is_scrubbed(self, log):
        # The old filter sat on loggers and never saw records propagated from children.
        logging.getLogger("app.services.deep.child").error("boom %s", RuntimeError(SENTINEL))
        assert SENTINEL not in log.getvalue()


class TestJobFailure:
    @pytest.mark.parametrize("error", [RuntimeError(SENTINEL), LLMUnavailableError("slow", detail=SENTINEL), LLMRequestError(SENTINEL)])
    async def test_the_job_row_the_response_and_the_log_carry_no_exception_text(self, db, log, error):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id)

        @job_handler(job_type="generate_content", label="Test job", default_error_code="CONTENT_GENERATION_FAILED")
        async def handler(payload, job):
            raise error

        with pytest.raises(HTTPException) as raised:
            await handler(JobPayload(jobId=job_id, jobType="generate_content", data={}))

        job = await get_job(db, job_id)
        assert SENTINEL not in str(raised.value.detail) and SENTINEL not in log.getvalue()
        assert SENTINEL not in str(dict(job))
        assert job["error_message"] == public_message(job["error_code"])


class TestDispatchFailure:
    async def test_a_response_body_and_a_network_error_are_not_stored_or_logged(self, db, log, monkeypatch):
        user_id = await seed_user(db)
        job_id = await seed_job(db, user_id)
        await db.execute("UPDATE processing_jobs SET status = 'pending', started_at = NULL WHERE id = $1", job_id)

        class Http:
            answers = [httpx.Response(500, text=SENTINEL), httpx.ConnectError(SENTINEL), httpx.Response(502, text=SENTINEL)]

            def __call__(self, *args, **kwargs):
                return self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, *args, **kwargs):
                answer = self.answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer

        async def no_sleep(_):
            return None

        monkeypatch.setattr(dispatch_module.asyncio, "sleep", no_sleep)
        monkeypatch.setattr(dispatch_module.httpx, "AsyncClient", Http())
        await dispatch_module._post_with_retries("/jobs/generate-content", {"jobId": job_id})

        job = await get_job(db, job_id)
        assert job["error_code"] == "ENQUEUE_FAILED" and job["error_message"] == public_message("ENQUEUE_FAILED")
        events = await db.fetch("SELECT detail FROM ops_events")
        assert SENTINEL not in str([dict(e) for e in events]) and SENTINEL not in log.getvalue()


class TestRoutes:
    def test_a_422_names_the_field_and_never_the_value(self):
        client = TestClient(app)
        response = client.post(
            "/voice/turn",
            json={"user_id": "u", "project_id": "p", "session_id": "s", "system": SENTINEL, "messages": SENTINEL},
        )
        assert response.status_code == 422
        assert SENTINEL not in response.text
        body = response.json()
        assert body["error_code"] == "VALIDATION_ERROR"
        assert {"loc", "type", "msg"} == set(body["detail"][0])

    def test_the_llm_error_handler_returns_the_public_message(self):
        from app.main import llm_error_handler
        import asyncio

        response = asyncio.run(llm_error_handler(None, LLMRequestError(SENTINEL)))
        assert SENTINEL not in response.body.decode() and b"LLM_REQUEST_REJECTED" in response.body


class _Provider:
    def __init__(self, error):
        self.error = error

    async def stream_turn(self, **kwargs):
        raise self.error
        yield  # pragma: no cover


class TestStreamErrors:
    @pytest.mark.parametrize("error", [RuntimeError(SENTINEL), LLMUnavailableError(SENTINEL, detail=SENTINEL)])
    async def test_a_voice_turn_error_event_has_the_code_and_the_public_message(self, log, error):
        payload = VoiceTurnRequest(user_id="u", project_id="p", session_id="s", system="x", messages=[{"role": "user", "content": "hi"}])
        events = [event async for event in stream_voice_turn(_Provider(error), payload)]
        assert [event["type"] for event in events] == ["error"]
        assert SENTINEL not in str(events) and SENTINEL not in log.getvalue()
        assert events[0]["message"] == public_message(events[0]["code"])

    async def test_a_chat_error_event_has_the_code_and_the_public_message(self, log):
        from app.services import chat as chat_service

        class Provider:
            def stream_cited_answer(self, **kwargs):
                async def gen():
                    raise LLMUnavailableError(SENTINEL, detail=SENTINEL)
                    yield  # pragma: no cover

                return gen()

        events = [
            event
            async for event in chat_service.stream_answer(
                Provider(), [{"id": "c1", "chunk_text": "t", "filename": "f", "page_start": 1, "page_end": 1}], "q", [],
                None, chat_service.TutorParams(),
            )
        ]
        errors = [event for event in events if event["type"] == "error"]
        assert errors and SENTINEL not in str(events) and SENTINEL not in log.getvalue()
        assert errors[0]["message"] == public_message(errors[0]["code"])


class TestValidatorNote:
    async def test_an_llm_error_in_the_check_leaves_a_fixed_note(self, log, monkeypatch):
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def local_copy(path):
            yield "unused"

        async def parse(path, filename, markdown=False):
            return ExtractedDocument(pages=[ExtractedPage(number=1, text="word " * 200)], extension=".pdf", page_count=1)

        class Provider:
            async def generate_structured(self, *args, **kwargs):
                raise LLMUnavailableError(SENTINEL, detail=SENTINEL)

        monkeypatch.setattr(validator, "local_copy", local_copy)
        monkeypatch.setattr(validator, "parse_document", parse)
        monkeypatch.setattr(LLMFactory, "_instance", Provider())

        result = await validator.validate_material("m1", "local://x.pdf", "x.pdf", "lecture_notes")

        assert result.status == "valid"
        assert SENTINEL not in result.notes and SENTINEL not in log.getvalue()
        assert result.notes.startswith("Validation completed using structural checks only")

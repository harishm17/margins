"""The billing scope: no model call is made, or free, without an account behind it.

Every route that can reach the model is listed here with a request that does. A new route that is in neither list
fails `test_every_route_is_billed_or_says_why_not`, so it cannot ship unbilled by omission.
"""
import ast
import asyncio
import pathlib

import httpx
import pytest

from app.api.routes.jobs import router as jobs_router
from app.config import settings
from app.main import app
from app.services import budget as budget_module
from app.services.billing import BillingProvider, UnbilledModelCall, billed, current_scope, unbilled
from app.services.budget import DailyBudgetExceeded
from app.services.llm.base import LLMMessage, LLMProvider, LLMUnavailableError, LLMUsage
from app.services.llm.factory import LLMFactory
from app.services.llm.mock_provider import MockProvider
from app.services.llm.usage import record_usage
from tests.billing_helpers import UsageProvider, install_billed
from tests.db_helpers import seed_voice_session, seed_project, seed_usage, seed_user
from tests.test_grading_waits import SHORT
from tests.test_tutor_practice import request as practice_request
from tests.test_tutor_reader import request as reader_request

pytestmark = pytest.mark.asyncio

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app"


class Spy(LLMProvider):
    """Remembers the scope each call was made in, then fails as an unreachable model would."""

    def __init__(self):
        self.scopes = []

    def _seen(self):
        self.scopes.append(current_scope())
        raise LLMUnavailableError("spy")

    async def generate_text(self, messages, *, purpose, max_tokens=16000):
        self._seen()

    async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
        self._seen()

    async def stream_cited_answer(self, **kwargs):
        self._seen()
        yield

    async def stream_turn(self, **kwargs):
        self._seen()
        yield


async def seed_student(db):
    """The user and project the route bodies name."""
    await seed_user(db, "u1")
    await db.execute("INSERT INTO projects (id, user_id, name, updated_at) VALUES ('p1', 'u1', 'P', NOW())")
    await seed_voice_session(db, "u1", "p1", session_id="s1")


async def post(path, body):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(path, json=body)


# ---- the provider

async def test_a_model_call_outside_any_scope_raises(monkeypatch):
    inner = Spy()
    with pytest.raises(UnbilledModelCall):
        await BillingProvider(inner).generate_text([], purpose="x")
    assert inner.scopes == []
    # The provider the factory hands out is the strict one.
    monkeypatch.setattr(settings, "LLM_PROVIDER", "mock")
    LLMFactory.reset()
    try:
        with pytest.raises(UnbilledModelCall):
            await LLMFactory.get_provider().generate_text([], purpose="x")
    finally:
        LLMFactory.reset()


async def test_each_call_in_a_scope_is_one_row_and_unbilled_scopes_write_none(db, monkeypatch):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    usage = LLMUsage(model="claude-haiku-5-5", input_tokens=1000, output_tokens=100)
    provider = install_billed(monkeypatch, UsageProvider(usage, usage, usage))

    async with billed(user_id, project_id, "tutor", "s1"):
        await provider.generate_text([], purpose="a")
        await provider.generate_text([], purpose="b")
    with unbilled("eval"):
        await provider.generate_text([], purpose="c")

    rows = await db.fetch("SELECT user_id, project_id, source, source_id, input_tokens FROM llm_usage_events")
    assert [(r["user_id"], r["project_id"], r["source"], r["source_id"], r["input_tokens"]) for r in rows] == [
        (user_id, project_id, "tutor", "s1", 1000)
    ] * 2


async def test_a_call_over_the_allowance_is_refused_before_the_model_and_an_unbilled_one_is_not(db, monkeypatch):
    monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.0)
    user_id = await seed_user(db)
    await seed_usage(db, user_id, 1.5)
    inner = Spy()
    provider = BillingProvider(inner)

    async with billed(user_id, None, "chat"):
        with pytest.raises(DailyBudgetExceeded) as raised:
            await provider.generate_text([], purpose="x")
    assert raised.value.reason == "user" and inner.scopes == []
    with unbilled("eval"), pytest.raises(LLMUnavailableError):
        await provider.generate_text([], purpose="x")
    assert len(inner.scopes) == 1


async def test_a_stream_the_reader_drops_is_billed_for_what_it_reported(db, monkeypatch):
    user_id = await seed_user(db)

    class Streams(Spy):
        async def stream_turn(self, **kwargs):
            record_usage(LLMUsage(model="claude-haiku-5-5", input_tokens=700, output_tokens=0))
            yield "first"
            yield "never read"

    provider = BillingProvider(Streams())
    async with billed(user_id, None, "voice", "s1"):
        stream = provider.stream_turn()
        assert await stream.__anext__() == "first"
        await stream.aclose()
    assert await db.fetchval("SELECT SUM(input_tokens) FROM llm_usage_events WHERE user_id = $1", user_id) == 700


@pytest.mark.parametrize("kind", ["structured", "stream"])
async def test_a_call_cancelled_before_it_returns_is_billed_for_its_input(db, kind):
    """Review of PR 1.8-1.9b: a tutor or drill call cut off by a dropped request wrote no row, so repeated aborts
    spent money outside the allowance. A stream cancelled before its first event (which carries the input tokens) too."""
    user_id = await seed_user(db)
    started = asyncio.Event()

    class Slow(Spy):
        def model_for(self, purpose):
            return "claude-haiku-5-5"

        async def generate_structured(self, messages, schema, *, purpose, max_tokens=16000):
            started.set()
            await asyncio.sleep(60)

        async def stream_turn(self, **kwargs):
            started.set()
            await asyncio.sleep(60)
            yield "never"

    provider = BillingProvider(Slow())

    async def call():
        async with billed(user_id, None, "drill", "t1"):
            if kind == "structured":
                await provider.generate_structured([LLMMessage(role="user", content="x" * 4000)], object, purpose="drill")
            else:
                async for _ in provider.stream_turn(system="", messages=[{"content": "x" * 4000}], tools=[], purpose="voice"):
                    pass

    task = asyncio.create_task(call())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    row = await db.fetchrow("SELECT input_tokens, cost_usd FROM llm_usage_events WHERE user_id = $1", user_id)
    # About 4 characters a token: the 4000-character input, plus a few short fields (the role, the purpose).
    assert 1000 <= row["input_tokens"] <= 1005 and row["cost_usd"] > 0


# ---- the routes

FILES = [{"id": "c1", "text": "t", "page": 1}]
MODEL_ROUTES = {
    # path: (body, source of its ledger rows, can the spy reach the model with this body)
    "/tutor/practice": (practice_request().model_dump(mode="json"), "tutor", True),
    "/tutor/reader": (reader_request().model_dump(mode="json"), "tutor", True),
    "/grade/quiz": ({"user_id": "u1", "project_id": "p1", "questions": [SHORT], "answers": {"0": "x"}}, "quiz", True),
    "/grade/recall": (
        {"user_id": "u1", "project_id": "p1", "prompt": "Explain", "answer": "A hash table maps keys to buckets with a hash function",
         "claims": [{"id": "k1", "text": "A claim"}]},
        "recall", True,
    ),
    "/voice/generate-drill": ({"user_id": "u1", "project_id": "p1", "notes": "notes", "count": 3}, "drill", True),
    "/voice/turn": (
        {"user_id": "u1", "project_id": "p1", "session_id": "s1", "system": "s",
         "messages": [{"role": "user", "content": "hi"}], "tools": []},
        "voice", True,
    ),
    # Needs a project and retrieval to get as far as the model: its scope is covered in test_chat.py.
    "/chat/answer": ({"user_id": "u1", "project_id": "p1", "question": "What?", "history": []}, "chat", False),
}
NO_MODEL_ROUTES = {
    "/chat/exam-guard": "a pattern check, no model",
    "/voice/retention": "deletes old transcripts",
    "/jobs/reap": "SQL only",
}


async def test_every_route_is_billed_or_says_why_not():
    for path, item in app.openapi()["paths"].items():
        if "post" not in item:
            continue
        if path.startswith("/jobs/") and path not in NO_MODEL_ROUTES:
            route = next(r for r in jobs_router.routes if r.path == path)
            assert hasattr(route.endpoint, "__wrapped__"), f"{path} is not a @job_handler, which opens the job's scope"
        else:
            assert path in MODEL_ROUTES or path in NO_MODEL_ROUTES, f"{path} is not in test_billing.py"


@pytest.mark.parametrize("prompts", ["", "all"])  # the audited prompts (PROMPTS_V2) take the same billed path
@pytest.mark.parametrize("path", [p for p, (_, _, reachable) in MODEL_ROUTES.items() if reachable])
async def test_a_model_call_made_for_a_route_carries_the_students_account(path, prompts, db, monkeypatch):
    body, source, _ = MODEL_ROUTES[path]
    monkeypatch.setattr(settings, "PROMPTS_V2", prompts)
    await seed_student(db)
    spy = Spy()
    monkeypatch.setattr(LLMFactory, "_instance", BillingProvider(spy))
    # The spy sits behind the real billing provider, which reads the allowance: let that read pass.
    async def open_allowance(user_id):
        return budget_module.Allowance(None, 0.0, budget_module.ai_status.next_reset_utc())

    monkeypatch.setattr("app.services.billing.allowance_today", open_allowance)
    monkeypatch.setattr("app.api.routes.voice.allowance_today", open_allowance)
    await post(path, body)
    assert spy.scopes, f"{path} never reached the model"
    assert (spy.scopes[0].user_id, spy.scopes[0].project_id, spy.scopes[0].source) == ("u1", "p1", source)


@pytest.mark.parametrize("path", list(MODEL_ROUTES))
async def test_a_student_who_has_spent_the_allowance_gets_a_429_on_every_model_route(path, db, monkeypatch):
    body, _, _ = MODEL_ROUTES[path]
    monkeypatch.setattr(settings, "DAILY_LLM_BUDGET_USD", 1.0)
    await seed_student(db)
    await seed_usage(db, "u1", 1.5)
    spy = Spy()
    monkeypatch.setattr(LLMFactory, "_instance", BillingProvider(spy))

    response = await post(path, body)

    assert response.status_code == 429
    assert response.json()["error_code"] == "LLM_DAILY_BUDGET" and response.json()["budget_reason"] == "user"
    assert spy.scopes == []


async def test_nothing_under_app_opens_an_unbilled_scope():
    for path in APP_DIR.rglob("*.py"):
        if path.name == "billing.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", None)) == "unbilled":
                pytest.fail(f"{path.name}:{node.lineno} opens unbilled(): only evals, scripts and tests may")

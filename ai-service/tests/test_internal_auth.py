"""Every AI-service route except health checks requires the shared internal token."""
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

PUBLIC_PATHS = {"/", "/health", "/health/dependencies"}
HEADER = "x-ai-internal-token"


def _protected_routes():
    # The OpenAPI schema lists every route, including those of included routers
    # (FastAPI 0.150+ no longer flattens them into app.routes).
    for path, operations in app.openapi()["paths"].items():
        if path not in PUBLIC_PATHS:
            for method in operations:
                yield method.upper(), path


PROTECTED = sorted(_protected_routes())


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def token(monkeypatch):
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "s3cret-token")
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    return "s3cret-token"


def test_job_and_voice_routes_are_all_listed():
    paths = {path for _, path in PROTECTED}
    assert "/jobs/grade-exam" in paths
    assert "/voice/turn" in paths
    assert "/voice/realtime/token" not in paths
    assert "/grade/quiz" in paths
    assert "/jobs/reap" in paths
    assert "/chat/answer" in paths
    assert {"/jobs/profile-exam", "/jobs/exam-relevance"} <= paths
    assert "/status/ai" in paths
    assert len(PROTECTED) == 14


@pytest.mark.parametrize("method,path", PROTECTED)
def test_missing_token_is_refused(client, token, method, path):
    resp = client.request(method, path, json={})
    assert resp.status_code == 401


@pytest.mark.parametrize("method,path", PROTECTED)
def test_wrong_token_is_refused(client, token, method, path):
    resp = client.request(method, path, json={}, headers={HEADER: "s3cret-tokeX"})
    assert resp.status_code == 401


# /jobs/reap and /status/ai take no body, so there is no validation step to stop at.
BODY_ROUTES = [route for route in PROTECTED if route[1] not in {"/jobs/reap", "/status/ai"}]


def test_right_token_reaches_the_reaper(client, token, monkeypatch):
    from app.api.routes import jobs

    async def reap():
        return {"failed": 0, "redispatched": 0}

    monkeypatch.setattr(jobs, "reap_expired_jobs", reap)
    resp = client.post("/jobs/reap", headers={HEADER: token})
    assert resp.status_code == 200
    assert resp.json() == {"failed": 0, "redispatched": 0}


@pytest.mark.parametrize("method,path", BODY_ROUTES)
def test_right_token_reaches_request_validation(client, token, method, path):
    # A list body fails validation (422) only after the token check has passed, so the
    # handler never runs and nothing calls a model or the database.
    resp = client.request(method, path, json=[], headers={HEADER: token})
    assert resp.status_code == 422


@pytest.mark.parametrize("environment", ["production", "staging", "test"])
@pytest.mark.parametrize("method,path", PROTECTED)
def test_unset_token_outside_development_fails_closed(
    client, monkeypatch, environment, method, path
):
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "")
    monkeypatch.setattr(settings, "ENVIRONMENT", environment)
    resp = client.request(method, path, json={})
    assert resp.status_code == 503


def test_unset_token_in_development_is_allowed(client, monkeypatch):
    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "")
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    resp = client.post("/jobs/grade-exam", json=[])
    assert resp.status_code == 422


def test_health_needs_no_token(client, token):
    assert client.get("/health").status_code == 200
    assert client.get("/").status_code == 200


@pytest.mark.asyncio
async def test_self_calls_send_the_token(monkeypatch):
    from app.services import dispatch

    sent = {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None, headers=None, timeout=None):
            sent["headers"] = headers

            class Resp:
                status_code = 200
                text = "ok"

            return Resp()

    monkeypatch.setattr(settings, "AI_INTERNAL_TOKEN", "s3cret-token")
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(dispatch.httpx, "AsyncClient", lambda *a, **k: FakeClient())
    await dispatch.enqueue_task("/jobs/extract-topics", {"jobId": "j1", "data": {}})
    await dispatch.wait_for_background_tasks()
    assert sent["headers"][HEADER] == "s3cret-token"

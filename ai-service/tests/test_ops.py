"""How alerts are posted, and that recording a failure never raises (app/services/ops.py)."""
import asyncio
import json

import pytest

from app.config import settings
from app.services import ops


class FakeClient:
    posts: list = []
    gets: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        FakeClient.posts.append((url, kwargs))
        return type("Response", (), {"status_code": 204})()

    async def get(self, url, **kwargs):
        FakeClient.gets.append(url)
        return type("Response", (), {"status_code": 200})()


@pytest.fixture
def client(monkeypatch):
    FakeClient.posts, FakeClient.gets = [], []
    monkeypatch.setattr(ops.httpx, "AsyncClient", FakeClient)
    return FakeClient


def test_ntfy_gets_the_title_header_and_the_text_as_body(client, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://ntfy.sh/margins-ops")
    asyncio.run(ops.post("backup missing", "No backup in 40 h."))
    _, kwargs = client.posts[0]
    assert kwargs["content"] == b"No backup in 40 h."
    assert kwargs["headers"]["Title"] == "Margins: backup missing"


def test_discord_and_slack_get_one_json_message(client, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://discord.example.test/api/webhooks/1")
    asyncio.run(ops.post("AI", "down"))
    body = client.posts[0][1]["json"]
    assert body == {"content": "Margins: AI. down", "text": "Margins: AI. down"}
    assert json.dumps(body)


def test_no_webhook_posts_nothing(client, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "")
    asyncio.run(ops.post("AI", "down"))
    assert client.posts == []


def test_the_dead_man_is_a_get_when_set(client, monkeypatch):
    monkeypatch.setattr(settings, "OPS_DEADMAN_URL", "")
    asyncio.run(ops.ping_deadman())
    monkeypatch.setattr(settings, "OPS_DEADMAN_URL", "https://hc-ping.example.test/abc")
    asyncio.run(ops.ping_deadman())
    assert client.gets == ["https://hc-ping.example.test/abc"]


def test_note_never_raises_and_keeps_the_count_when_the_database_fails(monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    ops.reset_local_state()
    monkeypatch.setattr(ops, "execute_update", broken)
    asyncio.run(ops.note("ledger_write_failed", "x"))
    asyncio.run(ops.note("ledger_write_failed", "y"))
    assert ops.take_unrecorded() == {"ledger_write_failed": 2}
    assert ops.take_unrecorded() == {}


def test_without_the_cooldown_table_the_cooldown_is_kept_in_process(client, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    ops.reset_local_state()
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://ntfy.sh/margins-ops")
    monkeypatch.setattr(ops, "execute_one", broken)
    assert asyncio.run(ops.alert("database", "database down", "x")) is True
    assert asyncio.run(ops.alert("database", "database down", "x")) is False
    assert len(client.posts) == 1
    ops.reset_local_state()


@pytest.mark.parametrize("failure", ["status", "raise"])
def test_a_post_that_fails_reports_it(client, monkeypatch, failure):
    async def failing(self, url, **kwargs):
        if failure == "raise":
            raise ConnectionError("unreachable")
        return type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://ntfy.sh/margins-ops")
    monkeypatch.setattr(FakeClient, "post", failing)
    assert asyncio.run(ops.post("AI", "down")) is False


def test_a_successful_post_reports_it(client, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://ntfy.sh/margins-ops")
    assert asyncio.run(ops.post("AI", "down")) is True


def test_an_alert_the_webhook_did_not_take_keeps_no_cooldown_in_process(client, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    results = iter([False, True])

    async def post(title, text):
        return next(results)

    ops.reset_local_state()
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://ntfy.sh/margins-ops")
    monkeypatch.setattr(ops, "execute_one", broken)
    monkeypatch.setattr(ops, "post", post)
    assert asyncio.run(ops.alert("database", "database down", "x")) is False
    assert asyncio.run(ops.alert("database", "database down", "x")) is True
    ops.reset_local_state()

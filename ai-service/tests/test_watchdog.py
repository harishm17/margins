"""The watchdog reads failure state and alerts once per kind (OPS-H2, OPS-M5).

Each test seeds one kind of state in a real database, runs the watchdog, and checks exactly one alert of that kind
goes out, and that a second run inside the cooldown sends nothing more.
"""
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.config import settings
from app.services import ops, watchdog
from tests.db_helpers import (
    seed_job,
    seed_material,
    seed_project,
    seed_topic,
    seed_usage,
    seed_user,
)

NOW = datetime.now(UTC)


@pytest.fixture
def posts(monkeypatch):
    sent = []

    async def post(title, text):
        sent.append((title, text))
        return True

    monkeypatch.setattr(ops, "post", post)
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "https://ntfy.sh/margins-test")
    monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 40.0)
    monkeypatch.setattr(settings, "BACKUPS_EXPECTED", False)
    monkeypatch.setattr(settings, "S3_BUCKET", "")
    watchdog.error_counter.take()
    return sent


async def kinds_after_two_runs(posts):
    first = await watchdog.run_watchdog(NOW)
    sent_first = len(posts)
    await watchdog.run_watchdog(NOW + timedelta(minutes=5))
    assert len(posts) == sent_first, "a second run inside the cooldown sends nothing"
    return {finding.kind for finding in first}


def test_the_evidence_limit_matches_the_web_app():
    source = (Path(__file__).resolve().parents[2] / "frontend/src/lib/learning/evidence-retry-budget.ts").read_text()
    assert int(re.search(r"EVIDENCE_MAX_ATTEMPTS = (\d+)", source).group(1)) == watchdog.EVIDENCE_MAX_ATTEMPTS


@pytest.mark.asyncio
async def test_a_quiet_system_sends_nothing_and_records_the_run(db, posts):
    assert await watchdog.run_watchdog(NOW) == []
    assert posts == []
    assert await ops.get_state("watchdog_last_run") == NOW.isoformat()
    assert await ops.get_state("embedding_model") == settings.EMBEDDING_MODEL


@pytest.mark.asyncio
async def test_failed_jobs_alert_once_per_code_over_the_rate(db, posts, monkeypatch):
    monkeypatch.setattr(settings, "WATCHDOG_FAILED_JOBS_PER_HOUR", 3)
    user_id = await seed_user(db)
    for _ in range(3):
        await seed_job(db, user_id, status="failed", error_code="LLM_OUTPUT_INVALID",
                       completed_at="SQL:(NOW() AT TIME ZONE 'UTC')")
    for _ in range(2):  # under the rate
        await seed_job(db, user_id, status="failed", error_code="NO_CONTENT",
                       completed_at="SQL:(NOW() AT TIME ZONE 'UTC')")
    await seed_job(db, user_id, status="failed", error_code="NO_CONTENT",
                   completed_at="SQL:(NOW() AT TIME ZONE 'UTC') - interval '2 hours'")

    assert await kinds_after_two_runs(posts) == {"jobs_failed:LLM_OUTPUT_INVALID"}
    assert len(posts) == 1 and "3 jobs failed with LLM_OUTPUT_INVALID" in posts[0][1]


@pytest.mark.asyncio
async def test_the_ai_status_row_is_read_directly(db, posts):
    await db.execute(
        "INSERT INTO ai_status (id, state, reason, since, checked_at) VALUES ('global', 'unavailable', "
        "'LLM_CREDIT_EXHAUSTED', (NOW() AT TIME ZONE 'UTC') - interval '3 hours', (NOW() AT TIME ZONE 'UTC') "
        "- interval '3 hours')"
    )
    # get_status would call this stale row "unknown, try again"; the watchdog still reports it.
    assert await kinds_after_two_runs(posts) == {"ai_unavailable"}
    assert "LLM_CREDIT_EXHAUSTED" in posts[0][1]


@pytest.mark.asyncio
async def test_spend_drill_with_a_one_cent_cap(db, posts, monkeypatch):
    monkeypatch.setattr(settings, "GLOBAL_DAILY_LLM_BUDGET_USD", 0.01)
    user_id = await seed_user(db)
    await seed_usage(db, user_id, 0.009)
    assert await kinds_after_two_runs(posts) == {"spend_80"}

    await seed_usage(db, user_id, 0.002)
    assert {f.kind for f in await watchdog.run_watchdog(NOW + timedelta(minutes=10))} == {"spend_100"}
    assert [title for title, _ in posts] == ["spend at 80%", "spend cap reached"]


@pytest.mark.asyncio
async def test_jobs_stuck_past_their_lease(db, posts):
    user_id = await seed_user(db)
    await seed_job(db, user_id, status="processing",
                   lease_until="SQL:(NOW() AT TIME ZONE 'UTC') - interval '20 minutes'")
    await seed_job(db, user_id, status="processing",
                   lease_until="SQL:(NOW() AT TIME ZONE 'UTC') - interval '5 minutes'")  # the reaper's to take
    assert await kinds_after_two_runs(posts) == {"leases"}
    assert posts[0][1].startswith("1 jobs")


@pytest.mark.asyncio
async def test_the_voice_purge_must_have_run(db, posts, monkeypatch):
    monkeypatch.setattr(settings, "VOICE_RETENTION_INTERVAL_SECONDS", 86400.0)
    monkeypatch.setattr(settings, "VOICE_RETENTION_DAYS", 180)
    await ops.set_state("voice_retention_last_run", (NOW - timedelta(hours=30)).isoformat())
    assert await watchdog.run_watchdog(NOW) == []

    await ops.set_state("voice_retention_last_run", (NOW - timedelta(hours=50)).isoformat())
    assert await kinds_after_two_runs(posts) == {"voice_retention"}
    assert "50 h ago" in posts[0][1]


@pytest.mark.asyncio
async def test_given_up_evidence(db, posts):
    user_id = await seed_user(db)
    topic_id = await seed_topic(db, await seed_project(db, user_id))
    for attempts in (5, 2):
        await db.execute(
            "INSERT INTO quiz_attempts (id, user_id, topic_id, answers, results, score, evidence_attempts, "
            "evidence_tried_at) VALUES (gen_random_uuid()::text, $1, $2, '{}', '{}', 50, $3, "
            "(NOW() AT TIME ZONE 'UTC'))",
            user_id, topic_id, attempts,
        )
    assert await kinds_after_two_runs(posts) == {"lost_evidence"}
    assert "1 quiz attempts and 0 exams" in posts[0][1]


@pytest.mark.asyncio
async def test_backup_freshness_when_backups_are_expected(db, posts, monkeypatch):
    assert await watchdog.run_watchdog(NOW) == []  # not expected: nothing to say

    monkeypatch.setattr(settings, "BACKUPS_EXPECTED", True)
    assert [f.kind for f in await watchdog.run_watchdog(NOW)] == ["backup"]
    assert "No backup has ever" in posts[-1][1]

    await ops.set_state("backup_last_success", (NOW - timedelta(hours=20)).isoformat())
    await db.execute("DELETE FROM ops_alerts")
    assert await watchdog.run_watchdog(NOW) == []

    await ops.set_state("backup_last_success", (NOW - timedelta(hours=40)).isoformat())
    assert [f.kind for f in await watchdog.run_watchdog(NOW)] == ["backup"]
    assert "40 h old" in posts[-1][1]


@pytest.mark.asyncio
async def test_vectors_from_another_embedding_model(db, posts):
    await ops.set_state("embedding_model", "some/other-model")
    assert await kinds_after_two_runs(posts) == {"embedding_model"}
    assert settings.EMBEDDING_MODEL in posts[0][1]


@pytest.mark.asyncio
async def test_orphaned_files_are_found_once_a_day(db, posts, monkeypatch, caplog):
    from app.services.document_processor import storage

    monkeypatch.setattr(settings, "S3_BUCKET", "uploads")
    project_id = await seed_project(db, await seed_user(db))
    await seed_material(db, project_id, gcs_path="s3://uploads/u/p/kept.pdf")
    old = NOW - timedelta(days=2)
    listed = [("u/p/kept.pdf", old), ("u/p/lost.pdf", old), ("u/p/new.pdf", NOW), ("ops/deletions/u.json", old)]

    async def list_objects():
        return listed

    monkeypatch.setattr(storage, "list_bucket_objects", list_objects)
    assert await kinds_after_two_runs(posts) == {"storage_orphans"}
    assert "1 files" in posts[0][1] and "u/p/lost.pdf" not in posts[0][1]
    assert "u/p/lost.pdf" in caplog.text

    # Not scanned again within the day, even with the alert's cooldown cleared.
    await db.execute("DELETE FROM ops_alerts")
    assert await watchdog.run_watchdog(NOW + timedelta(hours=2)) == []


@pytest.mark.asyncio
async def test_handled_failures_counted_where_they_happen(db, posts, caplog):
    await ops.note("ledger_write_failed", "grade_quiz $0.0100 not in the ledger")
    for _ in range(4):  # under the dispatch threshold
        await ops.note("dispatch_failed", "job x")
    assert await kinds_after_two_runs(posts) == {"event:ledger_write_failed"}
    assert "grade_quiz" not in posts[0][1] and "grade_quiz" in caplog.text


@pytest.mark.asyncio
async def test_web_app_failures_count_too(db, posts, caplog):
    await db.execute("INSERT INTO ops_events (kind, source, detail) VALUES ('storage_delete_failed', 'web', 'u/p/x')")
    assert await kinds_after_two_runs(posts) == {"event:storage_delete_failed"}
    assert "1 × storage_delete_failed" in posts[0][1]
    # Paths and ids name users and their files: they stay in the log, not in the third-party alert.
    assert "u/p/x" not in posts[0][1] and "web: u/p/x" in caplog.text


@pytest.mark.asyncio
async def test_a_failure_the_database_could_not_hold_is_still_reported(db, posts, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr(ops, "execute_update", broken)
    await ops.note("ledger_write_failed")
    assert ops._unrecorded["ledger_write_failed"] == 1


@pytest.mark.asyncio
async def test_unrecorded_failures_reach_the_alert(db, posts):
    ops._unrecorded["ledger_write_failed"] += 2
    kinds = {f.kind for f in await watchdog.run_watchdog(NOW)}
    assert kinds == {"event:ledger_write_failed"}
    assert ops.take_unrecorded() == {}


@pytest.mark.asyncio
async def test_many_logged_errors_alert(db, posts, caplog):
    import logging

    for _ in range(watchdog.ERRORS_PER_INTERVAL):
        watchdog.error_counter.emit(logging.makeLogRecord({"name": "app.x", "msg": "boom", "levelno": 40}))
    assert {f.kind for f in await watchdog.run_watchdog(NOW)} == {"errors_logged"}
    assert "boom" not in posts[0][1] and "app.x: boom" in caplog.text


@pytest.mark.asyncio
async def test_a_check_that_raises_is_itself_a_finding(db, posts, monkeypatch, caplog):
    async def broken():
        raise RuntimeError("column does not exist")

    monkeypatch.setattr(watchdog, "check_leases", broken)
    assert {f.kind for f in await watchdog.run_watchdog(NOW)} == {"check_failed:leases"}
    assert "RuntimeError" in posts[0][1] and "column does not exist" not in posts[0][1]
    assert "column does not exist" in caplog.text


@pytest.mark.asyncio
async def test_the_cooldown_ends(db, posts, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_COOLDOWN_SECONDS", 3600.0)
    await ops.set_state("embedding_model", "some/other-model")
    await watchdog.run_watchdog(NOW)
    await db.execute("UPDATE ops_alerts SET last_sent_at = last_sent_at - interval '2 hours'")
    await watchdog.run_watchdog(NOW)
    assert len(posts) == 2


@pytest.mark.asyncio
async def test_two_processes_send_one_alert(db, posts):
    import asyncio

    results = await asyncio.gather(*[ops.alert("same", "t", "x") for _ in range(5)])
    assert sum(results) == 1 and len(posts) == 1


@pytest.mark.asyncio
async def test_old_events_are_pruned(db, posts):
    await db.execute("INSERT INTO ops_events (kind, source, created_at) VALUES ('x', 'ai', "
                     "(NOW() AT TIME ZONE 'UTC') - interval '40 days')")
    await watchdog.run_watchdog(NOW)
    assert await db.fetchval("SELECT count(*) FROM ops_events") == 0


@pytest.mark.asyncio
async def test_the_dead_man_is_pinged_every_run(db, posts, monkeypatch):
    pinged = []

    async def ping():
        pinged.append(True)

    monkeypatch.setattr(ops, "ping_deadman", ping)
    await watchdog.run_watchdog(NOW)
    await watchdog.run_watchdog(NOW)
    assert len(pinged) == 2


@pytest.mark.asyncio
async def test_without_a_webhook_nothing_is_posted(db, posts, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_WEBHOOK_URL", "")
    await ops.set_state("embedding_model", "some/other-model")
    assert [f.kind for f in await watchdog.run_watchdog(NOW)] == ["embedding_model"]
    assert posts == []


@pytest.mark.asyncio
async def test_an_alert_the_webhook_did_not_take_is_sent_on_the_next_run(db, posts, monkeypatch):
    results = iter([False, True])

    async def post(title, text):
        posts.append((title, text))
        return next(results)

    monkeypatch.setattr(ops, "post", post)
    await ops.set_state("embedding_model", "some/other-model")
    await watchdog.run_watchdog(NOW)
    await watchdog.run_watchdog(NOW + timedelta(minutes=5))
    assert len(posts) == 2, "the failed post left no cooldown, so the next run tried again"
    await watchdog.run_watchdog(NOW + timedelta(minutes=10))
    assert len(posts) == 2, "the delivered one did"


@pytest.mark.asyncio
async def test_a_failed_orphan_scan_is_tried_again_on_the_next_run(db, posts, monkeypatch):
    from app.services.document_processor import storage

    monkeypatch.setattr(settings, "S3_BUCKET", "uploads")
    calls = []

    async def list_objects():
        calls.append(1)
        raise RuntimeError("bucket unreachable")

    monkeypatch.setattr(storage, "list_bucket_objects", list_objects)
    await watchdog.run_watchdog(NOW)
    await watchdog.run_watchdog(NOW + timedelta(minutes=5))
    assert len(calls) == 2

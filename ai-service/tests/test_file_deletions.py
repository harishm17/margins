"""The queue of stored files to delete (app/services/file_deletions.py)."""
from app.db.connection import UTC_NOW
from app.services import file_deletions
from app.services.document_processor import storage


async def test_a_failed_delete_is_retried_after_its_wait_and_then_done(db, monkeypatch):
    calls = []
    failing = {"on": True}

    async def delete_stored(path):
        calls.append(path)
        if failing["on"]:
            raise RuntimeError("storage is down")

    monkeypatch.setattr(storage, "delete_stored", delete_stored)
    await db.execute("INSERT INTO pending_file_deletions (path, reason) VALUES ('s3://uploads/u/p/a.pdf', 'test')")

    assert await file_deletions.drain_pending_deletions() == {"done": 0, "failed": 1}
    # Inside the wait nothing is tried again.
    assert await file_deletions.drain_pending_deletions() == {"done": 0, "failed": 0}
    row = await db.fetchrow("SELECT attempts, done_at FROM pending_file_deletions")
    assert row["attempts"] == 1 and row["done_at"] is None

    failing["on"] = False
    await db.execute(f"UPDATE pending_file_deletions SET last_attempt_at = {UTC_NOW} - interval '2 minutes'")
    # A row an older version marked done (they were kept for good, with the deleted account's folder in the path).
    await db.execute(f"INSERT INTO pending_file_deletions (path, reason, done_at) VALUES ('s3://uploads/u/old/', 'test', {UTC_NOW})")
    assert await file_deletions.drain_pending_deletions() == {"done": 1, "failed": 0}
    assert await db.fetchval("SELECT count(*) FROM pending_file_deletions") == 0
    assert len(calls) == 2
    assert await file_deletions.drain_pending_deletions() == {"done": 0, "failed": 0}

"""The queue of stored files to delete (OPS-L4).

The web app deletes a material or a project and, in the same transaction, inserts the paths of the files that row
pointed to into `pending_file_deletions` (frontend/src/lib/storage/pending-deletions.ts). Deleting the row and
promising the file's removal therefore commit together, and a storage error or a crash afterwards loses nothing.
`drain_pending_deletions` runs from the reaper loop: it takes a batch of rows that are due, deletes the objects, and
removes their rows. A row's path names the account and the course the file belonged to, so a finished row is not kept:
deleting an account leaves nothing that names it. A failure is retried with a growing wait (a minute, then two, four, ... up to six hours), and the
watchdog alerts on rows that failed FILE_DELETION_ALERT_ATTEMPTS times (kind `file_deletions`).

A path ending in `/` is a folder: everything under it goes.
"""
import logging

from app.config import settings
from app.db.connection import UTC_NOW, execute_one, execute_query, execute_update
from app.services.document_processor import storage

logger = logging.getLogger(__name__)

BATCH_SIZE = 50
BACKOFF_BASE_SECONDS = 60.0
BACKOFF_MAX_SECONDS = 6 * 3600.0


async def drain_pending_deletions() -> dict[str, int]:
    """Delete the queued files that are due. Returns {"done": n, "failed": n}."""
    await forget_finished()
    # Claiming a row counts the attempt and starts its wait, so two reapers never take the same row, and a crash
    # mid-delete costs one backoff, not a hot loop.
    due = await execute_query(
        f"""
        UPDATE pending_file_deletions
        SET attempts = attempts + 1, last_attempt_at = {UTC_NOW}
        WHERE id IN (
            SELECT id FROM pending_file_deletions
            WHERE done_at IS NULL
              AND (last_attempt_at IS NULL
                   OR last_attempt_at < {UTC_NOW}
                      - make_interval(secs => LEAST($2::float8 * power(2, attempts - 1), $3::float8)))
            ORDER BY created_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, path
        """,
        BATCH_SIZE,
        BACKOFF_BASE_SECONDS,
        BACKOFF_MAX_SECONDS,
    )
    counts = {"done": 0, "failed": 0}
    for row in due:
        try:
            await storage.delete_stored(row["path"])
        except Exception as exc:
            counts["failed"] += 1
            logger.warning("Could not delete queued file (will retry): %s", exc)
            continue
        await execute_update("DELETE FROM pending_file_deletions WHERE id = $1", row["id"])
        counts["done"] += 1
    if due:
        logger.info("File deletion queue: %s", counts)
    return counts


async def count_stuck() -> int:
    """Queued deletions that failed FILE_DELETION_ALERT_ATTEMPTS times and are still not done."""
    row = await execute_one(
        "SELECT count(*)::int AS n FROM pending_file_deletions WHERE done_at IS NULL AND attempts >= $1",
        settings.FILE_DELETION_ALERT_ATTEMPTS,
    )
    return int(row["n"]) if row else 0


async def forget_finished() -> None:
    """Remove rows marked done instead of deleted: every finished row from before 2026-11-11, and any a web instance
    still on the older code marks during a deploy. Nothing removed them before, so they kept deleted accounts' paths."""
    await execute_update("DELETE FROM pending_file_deletions WHERE done_at IS NOT NULL")

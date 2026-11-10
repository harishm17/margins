"""The watchdog: one reader of failure state, so the operator hears about it (OPS-H2, OPS-M5).

Failures are recorded where they happen (a failed job's row, the AI status row, the spend ledger, `ops_events`), and
before this nothing read that state back: the one alert was the AI status change, sent from one path in one process.
The watchdog runs from the reaper loop every WATCHDOG_INTERVAL_SECONDS, reads the state below, and sends each kind of
finding through ops.alert, which sends it once per cooldown however many processes see it.

  failed jobs     WATCHDOG_FAILED_JOBS_PER_HOUR or more failed jobs with one error code in the last hour
  ai_unavailable  the AI status row says unavailable (read directly: a database error here is itself a finding)
  spend_80        spend today (UTC) at 80% of GLOBAL_DAILY_LLM_BUDGET_USD; spend_100 at the cap
  leases          jobs still `processing` 15 minutes after their lease ran out: the reaper is not keeping up
  voice_retention the voice purge has not run in two intervals and an hour (the privacy page promises it)
  lost_evidence   quiz or exam evidence given up on in the last day (EVIDENCE_MAX_ATTEMPTS failed writes)
  backup          no successful backup within BACKUP_MAX_AGE_HOURS, when BACKUPS_EXPECTED
  embedding_model the stored vectors were made by another model than EMBEDDING_MODEL (retrieval would be garbage)
  storage_orphans files in the bucket that no material points to (swept weekly; dry run by default), and
                  storage_sweep_refused when too many look orphaned to delete
  file_deletions  queued file deletions (pending_file_deletions) that failed FILE_DELETION_ALERT_ATTEMPTS times
  ops events      failures counted by ops.note in the last interval, by kind (ledger writes, status writes,
                  storage deletes, dispatches, the reaper), and errors logged by this process
  check_failed    a check above raised: the watchdog says so rather than going quiet

Each run also records `watchdog_last_run` (the web app's /api/health/ready fails when it is stale, so an external
uptime check sees a dead watchdog or a dead AI service) and pings OPS_DEADMAN_URL. What each alert means and what to do
is the table in docs/deployment/RAILWAY.md.
"""
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.errors import describe_exception
from app.config import settings
from app.db.connection import UTC_NOW, execute_one, execute_query, execute_update
from app.services import ops

logger = logging.getLogger(__name__)

# The web app gives up writing a quiz's or exam's evidence after this many failed tries
# (frontend/src/lib/learning/evidence-retry-budget.ts; a test keeps the two equal).
EVIDENCE_MAX_ATTEMPTS = 5
# ops_events kinds and how many in one interval make an alert. A kind not listed alerts at 1.
EVENT_THRESHOLDS = {"dispatch_failed": 5, "lease_renewal_failed": 5}
# Errors logged by this process in one interval that make an alert (each kind above is also logged).
ERRORS_PER_INTERVAL = 20
ORPHAN_SCAN_EVERY = timedelta(days=7)
# A file younger than this is never swept: an upload stores it before its row exists.
ORPHAN_MIN_AGE = timedelta(hours=1)
EVENTS_KEPT = timedelta(days=30)
# Storage prefixes that hold no materials (ops/deletions/, the account-deletion records: writeDeletionRecord in frontend/src/lib/storage/files.ts).
NON_MATERIAL_PREFIXES = ("ops/",)


@dataclass
class Finding:
    """One problem. `text` goes to the alert webhook, a third party: counts, kinds and codes only. `detail` (user ids,
    file paths, error text) goes only to the log."""

    kind: str
    title: str
    text: str
    detail: str = ""


class ErrorCounter(logging.Handler):
    """Counts ERROR records from the whole process between watchdog runs."""

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)
        self.count = 0
        self.sample: str | None = None

    def emit(self, record: logging.LogRecord) -> None:
        self.count += 1
        if self.sample is None:
            self.sample = f"{record.name}: {record.getMessage()[:200]}"

    def take(self) -> tuple:
        count, sample = self.count, self.sample
        self.count, self.sample = 0, None
        return count, sample


error_counter = ErrorCounter()
_started = time.monotonic()


def install_error_counter() -> None:
    root = logging.getLogger()
    if error_counter not in root.handlers:
        root.addHandler(error_counter)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return _utc(datetime.fromisoformat(value))
    except ValueError:
        return None


def _age_text(then: datetime, now: datetime) -> str:
    hours = (now - then).total_seconds() / 3600
    return f"{hours:.0f} h" if hours >= 2 else f"{hours * 60:.0f} min"


async def check_failed_jobs() -> list[Finding]:
    rows = await execute_query(
        f"""
        SELECT COALESCE(error_code, 'UNKNOWN') AS code, count(*)::int AS n, max(job_type) AS job_type
        FROM processing_jobs
        WHERE status = 'failed' AND completed_at > {UTC_NOW} - interval '1 hour'
        GROUP BY 1
        HAVING count(*) >= $1
        """,
        settings.WATCHDOG_FAILED_JOBS_PER_HOUR,
    )
    return [
        Finding(
            f"jobs_failed:{row['code']}",
            "jobs failing",
            f"{row['n']} jobs failed with {row['code']} in the last hour (e.g. {row['job_type']}).",
        )
        for row in rows
    ]


async def check_ai_status() -> list[Finding]:
    row = await execute_one("SELECT state, reason, since FROM ai_status WHERE id = 'global'")
    if row is None or row["state"] != "unavailable":
        return []
    since = _utc(row["since"])
    when = f" since {since:%Y-%m-%d %H:%M} UTC" if since else ""
    return [Finding("ai_unavailable", "AI unavailable", f"The AI is marked unavailable ({row['reason']}){when}.")]


async def check_spend() -> list[Finding]:
    from app.services.budget import global_spent_today_usd

    cap = settings.GLOBAL_DAILY_LLM_BUDGET_USD
    if cap <= 0:
        return []
    spent = await global_spent_today_usd()
    if spent >= cap:
        return [Finding("spend_100", "spend cap reached",
                        f"${spent:.2f} of the ${cap:.2f} daily cap is spent: every model call is refused until "
                        "midnight UTC.")]
    if spent >= 0.8 * cap:
        return [Finding("spend_80", "spend at 80%", f"${spent:.2f} of the ${cap:.2f} daily cap is spent (UTC day).")]
    return []


async def check_leases() -> list[Finding]:
    row = await execute_one(
        f"""
        SELECT count(*)::int AS n FROM processing_jobs
        WHERE status = 'processing' AND lease_until < {UTC_NOW} - interval '15 minutes'
        """
    )
    if not row or not row["n"]:
        return []
    return [Finding("leases", "jobs stuck",
                    f"{row['n']} jobs are still processing 15 minutes after their lease ran out: the job reaper is "
                    "not running or keeps failing.")]


async def check_voice_retention(now: datetime) -> list[Finding]:
    interval = settings.VOICE_RETENTION_INTERVAL_SECONDS
    if interval <= 0 or settings.VOICE_RETENTION_DAYS <= 0:
        return []
    allowed = timedelta(seconds=2 * interval + 3600)
    last = _parse_time(await ops.get_state("voice_retention_last_run"))
    if last is None:
        # Never recorded: only a finding once this process has been up long enough to have run it.
        if time.monotonic() - _started < allowed.total_seconds():
            return []
        text = "The voice transcript purge has never recorded a run."
    elif now - last > allowed:
        text = f"The voice transcript purge last ran {_age_text(last, now)} ago."
    else:
        return []
    return [Finding("voice_retention", "voice purge not running",
                    text + " The privacy page promises transcripts are deleted after "
                    f"{settings.VOICE_RETENTION_DAYS} days.")]


async def check_lost_evidence() -> list[Finding]:
    row = await execute_one(
        f"""
        SELECT
          (SELECT count(*) FROM quiz_attempts
            WHERE evidence_recorded_at IS NULL AND evidence_attempts >= $1
              AND evidence_tried_at > {UTC_NOW} - interval '1 day')::int AS quizzes,
          (SELECT count(*) FROM exam_submissions
            WHERE evidence_recorded_at IS NULL AND evidence_attempts >= $1
              AND evidence_tried_at > {UTC_NOW} - interval '1 day')::int AS exams
        """,
        EVIDENCE_MAX_ATTEMPTS,
    )
    if not row or not (row["quizzes"] or row["exams"]):
        return []
    return [Finding("lost_evidence", "evidence lost",
                    f"Concept evidence was given up on in the last day for {row['quizzes']} quiz attempts and "
                    f"{row['exams']} exams: those results do not reach mastery.")]


async def check_backup(now: datetime) -> list[Finding]:
    if not settings.BACKUPS_EXPECTED:
        return []
    last = _parse_time(await ops.get_state("backup_last_success"))
    limit = timedelta(hours=settings.BACKUP_MAX_AGE_HOURS)
    if last is None:
        text = "No backup has ever been recorded as successful."
    elif now - last > limit:
        text = f"The newest successful backup is {_age_text(last, now)} old."
    else:
        return []
    return [Finding("backup", "backup missing", text + " Check the backup service's last run on Railway.")]


async def check_embedding_model() -> list[Finding]:
    stored = await ops.get_state("embedding_model")
    if stored is None:
        await ops.set_state("embedding_model", settings.EMBEDDING_MODEL)
        return []
    if stored == settings.EMBEDDING_MODEL:
        return []
    return [Finding("embedding_model", "embedding model mismatch",
                    f"Stored vectors were made by {stored} but EMBEDDING_MODEL is {settings.EMBEDDING_MODEL}: "
                    "search results are wrong until the chunks are re-embedded (scripts/reembed_chunks.py) and "
                    "ops_state.embedding_model is updated.")]


async def check_storage_orphans(now: datetime) -> list[Finding]:
    """The weekly sweep of bucket files that no material points to (OPS-L3).

    The deletion queue is what removes files in normal operation; this catches what slipped past it (an upload that
    died after the file was stored, a bug). It is built not to do harm: files younger than an hour are never touched
    (an upload stores the file before its row exists), it refuses and alerts when the orphans are more than
    STORAGE_SWEEP_MAX_SHARE of the bucket or more than STORAGE_SWEEP_MAX_FILES files (a wrong listing or an empty
    materials table would otherwise delete everything), and while STORAGE_SWEEP_DRY_RUN is on it only reports.
    """
    from app.services.document_processor import storage

    if not settings.S3_BUCKET:
        return []
    last = _parse_time(await ops.get_state("orphan_scan_at"))
    if last is not None and now - last < ORPHAN_SCAN_EVERY:
        return []
    rows = await execute_query("SELECT gcs_path FROM materials WHERE gcs_path LIKE 's3://%'")
    known = {path.split("/", 3)[3] for path in (row["gcs_path"] for row in rows) if path.count("/") >= 3}
    cutoff = now - ORPHAN_MIN_AGE
    objects = [
        (key, modified)
        for key, modified in await storage.list_bucket_objects()
        if not key.startswith(NON_MATERIAL_PREFIXES)
    ]
    orphans = [key for key, modified in objects if key not in known and _utc(modified) < cutoff]
    # Recorded only after a scan that finished, so a failed one is tried again on the next run.
    await ops.set_state("orphan_scan_at", now.isoformat())
    if not orphans:
        return []
    share = len(orphans) / len(objects)
    detail = f"e.g. {', '.join(orphans[:5])}"
    if share > settings.STORAGE_SWEEP_MAX_SHARE or len(orphans) > settings.STORAGE_SWEEP_MAX_FILES:
        return [Finding("storage_sweep_refused", "orphan sweep refused",
                        f"{len(orphans)} of {len(objects)} files in the bucket look orphaned ({share:.0%}), more than "
                        "the sweep is allowed to delete. Nothing was deleted: check that the materials table and the "
                        "bucket listing are right, then raise STORAGE_SWEEP_MAX_SHARE or delete by hand.",
                        detail=detail)]
    if settings.STORAGE_SWEEP_DRY_RUN:
        return [Finding("storage_orphans", "orphaned files",
                        f"{len(orphans)} files in the bucket belong to no material (dry run: nothing deleted). The "
                        "watchdog log names some. Set STORAGE_SWEEP_DRY_RUN=false once they look right.",
                        detail=detail)]
    await storage.delete_bucket_objects(orphans)
    return [Finding("storage_orphans", "orphaned files deleted",
                    f"Deleted {len(orphans)} files from the bucket that belonged to no material.", detail=detail)]


async def check_file_deletions() -> list[Finding]:
    from app.services import file_deletions

    stuck = await file_deletions.count_stuck()
    if not stuck:
        return []
    return [Finding("file_deletions", "file deletions stuck",
                    f"{stuck} queued file deletions failed {settings.FILE_DELETION_ALERT_ATTEMPTS} times or more: "
                    "the storage is refusing deletes. The rows are in pending_file_deletions; the log has the errors.")]


async def check_ops_events(since: datetime) -> list[Finding]:
    rows = await execute_query(
        "SELECT kind, source, count(*)::int AS n, max(detail) AS sample FROM ops_events "
        "WHERE created_at > $1 GROUP BY kind, source",
        since.replace(tzinfo=None),
    )
    counts: dict[str, int] = {}
    samples: dict[str, str] = {}
    for row in rows:
        counts[row["kind"]] = counts.get(row["kind"], 0) + row["n"]
        if row["sample"]:
            samples.setdefault(row["kind"], f"{row['source']}: {row['sample']}")
    return _event_findings(counts, samples)


def _event_findings(counts: dict[str, int], samples: dict[str, str]) -> list[Finding]:
    findings = []
    for kind, n in sorted(counts.items()):
        if n < EVENT_THRESHOLDS.get(kind, 1):
            continue
        findings.append(Finding(f"event:{kind}", kind.replace("_", " "),
                                f"{n} × {kind} since the last watchdog run.",
                                detail=f"Latest: {samples[kind][:200]}" if kind in samples else ""))
    return findings


def check_logged_errors() -> list[Finding]:
    count, sample = error_counter.take()
    if count < ERRORS_PER_INTERVAL:
        return []
    return [Finding("errors_logged", "errors logged",
                    f"The AI service logged {count} errors since the last watchdog run.",
                    detail=f"First: {sample}")]


async def run_watchdog(now: datetime | None = None) -> list[Finding]:
    """Run every check, alert on what it finds, record the run. Never raises."""
    now = now or datetime.now(UTC)
    last_run = None
    try:
        last_run = _parse_time(await ops.get_state("watchdog_last_run"))
    except Exception as exc:
        logger.error("Watchdog could not read its last run: %s", exc)
    since = last_run or now - timedelta(seconds=max(settings.WATCHDOG_INTERVAL_SECONDS, 60))

    checks: list[tuple] = [
        ("failed_jobs", check_failed_jobs),
        ("ai_status", check_ai_status),
        ("spend", check_spend),
        ("leases", check_leases),
        ("voice_retention", lambda: check_voice_retention(now)),
        ("lost_evidence", check_lost_evidence),
        ("backup", lambda: check_backup(now)),
        ("embedding_model", check_embedding_model),
        ("storage_orphans", lambda: check_storage_orphans(now)),
        ("file_deletions", check_file_deletions),
        ("ops_events", lambda: check_ops_events(since)),
    ]
    findings: list[Finding] = []
    for name, check in checks:
        findings.extend(await _run_check(name, check))
    findings.extend(_event_findings(ops.take_unrecorded(), {}))
    findings.extend(check_logged_errors())

    for finding in findings:
        logger.warning("Watchdog: %s: %s %s", finding.kind, finding.text, finding.detail)
        await ops.alert(finding.kind, finding.title, finding.text)

    try:
        await ops.set_state("watchdog_last_run", now.isoformat())
        await execute_update(
            "DELETE FROM ops_events WHERE created_at < $1", (now - EVENTS_KEPT).replace(tzinfo=None)
        )
    except Exception as exc:
        logger.error("Watchdog could not record its run: %s", exc)
    await ops.ping_deadman()
    return findings


async def _run_check(name: str, check: Callable[[], Awaitable[list[Finding]]]) -> list[Finding]:
    try:
        return await check()
    except Exception as exc:
        logger.warning("Watchdog check %s failed: %s", name, exc)
        return [Finding(f"check_failed:{name}", "watchdog check failed",
                        f"The {name} check could not run: {type(exc).__name__}.",
                        detail=describe_exception(exc))]

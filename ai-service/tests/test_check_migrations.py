"""The migration rules CI enforces (scripts/check_migrations.py)."""
import importlib.util
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("check_migrations", ROOT / "scripts" / "check_migrations.py")
check_migrations = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_migrations)


def test_the_repository_passes():
    assert check_migrations.check(ROOT) == []


@pytest.mark.parametrize(
    "sql, problem",
    [
        ('ALTER TABLE "jobs" DROP COLUMN "result";', "drops"),
        ('DROP TABLE "old_things";', "drops"),
        ('ALTER TABLE "jobs" RENAME COLUMN "a" TO "b";', "renames"),
        ('ALTER TABLE "jobs" ALTER COLUMN "x" SET NOT NULL;', "makes a column NOT NULL"),
        ('ALTER TABLE "jobs" ALTER COLUMN "x" TYPE BIGINT;', "changes a column type"),
        ('ALTER TABLE "jobs" ADD COLUMN "flag" BOOLEAN NOT NULL;', 'adds NOT NULL column "flag" without a DEFAULT'),
    ],
)
def test_changes_that_break_the_other_service_are_caught(sql, problem):
    assert check_migrations.unsafe_changes(sql) == [problem]


@pytest.mark.parametrize(
    "sql",
    [
        'CREATE TABLE "ops_state" ("key" TEXT NOT NULL, CONSTRAINT "ops_state_pkey" PRIMARY KEY ("key"));',
        'ALTER TABLE "jobs" ADD COLUMN "flag" BOOLEAN NOT NULL DEFAULT false;',
        'ALTER TABLE "jobs" ADD COLUMN "note" TEXT;',
        'CREATE INDEX "jobs_kind_idx" ON "jobs"("kind");',
        "-- a comment may say DROP COLUMN without dropping anything\nSELECT 1;",
    ],
)
def test_additive_changes_pass(sql):
    assert check_migrations.unsafe_changes(sql) == []


def test_the_marker_allows_a_planned_contract_step():
    sql = '-- expand-contract: both services stopped reading "result" in #90\nALTER TABLE "jobs" DROP COLUMN "result";'
    assert check_migrations.unsafe_changes(sql) == []


def test_an_empty_marker_does_not_count():
    assert check_migrations.unsafe_changes('-- expand-contract:\nDROP TABLE "x";') == ["drops"]


def _copy_layout(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "frontend" / "prisma" / "migrations", tmp_path / "frontend" / "prisma" / "migrations")
    (tmp_path / "ai-service" / "app" / "db").mkdir(parents=True)
    shutil.copy(ROOT / "ai-service" / "app" / "db" / "schema_version.py", tmp_path / "ai-service" / "app" / "db")
    return tmp_path


def test_a_new_migration_the_ai_service_does_not_name_fails(tmp_path):
    root = _copy_layout(tmp_path)
    new = root / "frontend" / "prisma" / "migrations" / "29990101000000_later"
    new.mkdir()
    (new / "migration.sql").write_text('ALTER TABLE "jobs" ADD COLUMN "note" TEXT;')
    problems = check_migrations.check(root)
    assert len(problems) == 1 and "REQUIRED_MIGRATION" in problems[0]


def test_a_destructive_migration_after_the_baseline_fails(tmp_path):
    root = _copy_layout(tmp_path)
    new = root / "frontend" / "prisma" / "migrations" / "29990101000000_later"
    new.mkdir()
    (new / "migration.sql").write_text('ALTER TABLE "jobs" DROP COLUMN "result";')
    version = root / "ai-service" / "app" / "db" / "schema_version.py"
    version.write_text('REQUIRED_MIGRATION = "29990101000000_later"\n')
    problems = check_migrations.check(root)
    assert problems and problems[0].startswith("29990101000000_later: drops")

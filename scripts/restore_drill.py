#!/usr/bin/env python3
"""Restore a Margins backup and check it (OPS-H1). Run once a quarter on the box; docs/deployment/RESTORE.md.

The drill fetches the newest nightly backup from R2 (backup/backup.sh writes it), restores it into a scratch
database, and checks it:

- every table's row count equals the manifest's (the counts and the dump come from one snapshot);
- the newest applied migration and the embedding model equal the manifest's, and the model is the one the AI
  service's code uses (vectors from another model would be searched as if they were comparable);
- a nearest-neighbour query over the stored vectors returns the vector it started from;
- sampled material files exist in the uploads mirror;
- accounts deleted since the backup (ops/deletions/ in the mirror) are deleted again.

Then it drops the scratch database and prints the line for RAILWAY.md. For a real restore, `--into URL` restores into
that (empty) database and keeps it.

Reads the R2 settings from ~/.config/margins/r2-backups.env and the passphrase from ~/.config/margins/backup-passphrase
(or R2_* and BACKUP_PASSPHRASE in the environment). Needs rclone, pg_restore and psql (Postgres 18 client). Prints no
secrets.
"""
import argparse
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path.home() / ".config" / "margins"
DRILL_DB = "margins_restore_drill"
COUNTS_SQL = """SELECT json_object_agg(table_name, n ORDER BY table_name) FROM (
  SELECT table_name,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true,
                '')))[1]::text::bigint AS n
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') t"""


class DrillFailed(Exception):
    pass


def read_env_file(path: Path) -> dict[str, str]:
    values = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def rclone_env(safe_remote: str | None) -> dict[str, str]:
    """rclone remotes like backup.sh's: `safe` is the encrypted view of the R2 bucket (or of `safe_remote`)."""
    settings = {**read_env_file(CONFIG / "r2-backups.env"), **os.environ}
    passphrase = settings.get("BACKUP_PASSPHRASE")
    passphrase_file = CONFIG / "backup-passphrase"
    if not passphrase and passphrase_file.is_file():
        passphrase = passphrase_file.read_text().strip()
    if not passphrase:
        raise DrillFailed(f"No BACKUP_PASSPHRASE and no {passphrase_file}")
    env = dict(os.environ)
    if safe_remote is None:
        for name in ("R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
            if not settings.get(name):
                raise DrillFailed(f"{name} is not set (expected in {CONFIG / 'r2-backups.env'})")
        env.update(
            RCLONE_CONFIG_R2_TYPE="s3",
            RCLONE_CONFIG_R2_PROVIDER="Cloudflare",
            RCLONE_CONFIG_R2_ENDPOINT=settings["R2_ENDPOINT"],
            RCLONE_CONFIG_R2_ACCESS_KEY_ID=settings["R2_ACCESS_KEY_ID"],
            RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=settings["R2_SECRET_ACCESS_KEY"],
            RCLONE_CONFIG_R2_NO_CHECK_BUCKET="true",
        )
        safe_remote = f"r2:{settings['R2_BUCKET']}"
    obscured = subprocess.run(
        ["rclone", "obscure", "-"], input=passphrase, capture_output=True, text=True, check=True
    ).stdout.strip()
    env.update(
        RCLONE_CONFIG_SAFE_TYPE="crypt",
        RCLONE_CONFIG_SAFE_REMOTE=safe_remote,
        RCLONE_CONFIG_SAFE_FILENAME_ENCRYPTION="off",
        RCLONE_CONFIG_SAFE_DIRECTORY_NAME_ENCRYPTION="false",
        RCLONE_CONFIG_SAFE_PASSWORD=obscured,
    )
    return env


def run(cmd: list[str], env: dict[str, str] | None = None, stdin: str | None = None) -> str:
    result = subprocess.run(cmd, check=False, env=env, input=stdin, capture_output=True, text=True)
    if result.returncode != 0:
        raise DrillFailed(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''} failed: {result.stderr.strip()[-800:]}")
    return result.stdout


def psql(url: str, sql: str) -> str:
    return run(["psql", "-qAtX", "-v", "ON_ERROR_STOP=1", url], stdin=sql).strip()


def with_database(url: str, name: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{name}"))


def code_embedding_model() -> str | None:
    found = re.search(r'^\s*EMBEDDING_MODEL:\s*str\s*=\s*"([^"]+)"', (ROOT / "ai-service/app/config.py").read_text(),
                      re.MULTILINE)
    return found.group(1) if found else None


def drill(args) -> list[str]:
    env = rclone_env(args.safe_remote)
    report: list[str] = []
    problems: list[str] = []

    # A run that died after its dump has no manifest: it is not a backup. The manifest is written last.
    listed = run(["rclone", "lsf", "-R", "--files-only", "--include", "*/manifest.json", "safe:daily"], env)
    backups = sorted(line.split("/")[0] for line in listed.split())
    if not backups and not args.backup:
        raise DrillFailed("No complete backups under daily/")
    name = args.backup or f"daily/{backups[-1]}"
    report.append(f"backup {name} (newest of {len(backups)} complete daily)")

    with tempfile.TemporaryDirectory(prefix="margins-restore-") as tmp:
        dump, manifest_path = Path(tmp) / "db.dump", Path(tmp) / "manifest.json"
        run(["rclone", "copyto", f"safe:{name}/db.dump", str(dump)], env)
        run(["rclone", "copyto", f"safe:{name}/manifest.json", str(manifest_path)], env)
        manifest = json.loads(manifest_path.read_text())
        if hashlib.sha256(dump.read_bytes()).hexdigest() != manifest["dump_sha256"]:
            raise DrillFailed("The dump's checksum does not match the manifest")

        if args.into:
            target = args.into
        else:
            psql(args.admin_url, f"DROP DATABASE IF EXISTS {DRILL_DB}; CREATE DATABASE {DRILL_DB};")
            target = with_database(args.admin_url, DRILL_DB)
        try:
            run(["pg_restore", "--no-owner", "--no-privileges", "--exit-on-error", "-d", target, str(dump)])

            counts = json.loads(psql(target, COUNTS_SQL) or "{}")
            expected = manifest["row_counts"]
            differ = sorted(t for t in set(expected) | set(counts) if counts.get(t) != expected.get(t))
            if differ:
                problems.append("row counts differ: " + ", ".join(
                    f"{t} {counts.get(t)} != {expected.get(t)}" for t in differ[:10]))
            report.append(f"{len(counts)} tables, {sum(counts.values())} rows, counts match: {not differ}")

            migration = psql(target, "SELECT coalesce(max(migration_name), '') FROM _prisma_migrations "
                                     "WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
            if migration != manifest["migration"]:
                problems.append(f"migration {migration} != manifest {manifest['migration']}")
            report.append(f"newest migration {migration}")

            model = psql(target, "SELECT coalesce((SELECT value FROM ops_state WHERE key = 'embedding_model'), '')")
            code_model = code_embedding_model()
            if model != manifest["embedding_model"]:
                problems.append(f"embedding model {model!r} != manifest {manifest['embedding_model']!r}")
            if model and code_model and model != code_model:
                problems.append(f"stored vectors are from {model}, the code uses {code_model}: re-embed before use")
            report.append(f"embedding model {model or '(not recorded)'}")

            vectors = int(psql(target, "SELECT count(*) FROM material_chunks WHERE chunk_embedding IS NOT NULL"))
            if vectors:
                hit = psql(target, """
                    WITH probe AS (SELECT id, chunk_embedding FROM material_chunks
                                   WHERE chunk_embedding IS NOT NULL ORDER BY id LIMIT 1)
                    SELECT (SELECT c.id FROM material_chunks c WHERE c.chunk_embedding IS NOT NULL
                            ORDER BY c.chunk_embedding <=> probe.chunk_embedding LIMIT 1) = probe.id FROM probe""")
                if hit != "t":
                    problems.append("the nearest-neighbour query did not return its own vector")
            report.append(f"vector query over {vectors} vectors: {'ok' if vectors else 'no vectors stored'}")

            paths = [p for p in psql(target, "SELECT gcs_path FROM materials").splitlines() if p.startswith("s3://")]
            sample = random.sample(paths, min(args.samples, len(paths)))
            mirrored = set(run(["rclone", "lsf", "-R", "--files-only", "--fast-list", "safe:uploads/current"],
                               env).splitlines())
            # A file deleted after the dump was taken left the mirror for uploads/deleted/<run time>/.
            deleted = {line.split("/", 1)[1] for line in run(
                ["rclone", "lsf", "-R", "--files-only", "--fast-list", "safe:uploads/deleted"], env).splitlines()
                if "/" in line}
            keys = [path.split("/", 3)[3] for path in sample]
            missing = [key for key in keys if key not in mirrored and key not in deleted]
            only_deleted = sum(1 for key in keys if key not in mirrored and key in deleted)
            if missing:
                problems.append(f"{len(missing)} of {len(sample)} sampled files missing from the mirror: {missing[:3]}")
            report.append(f"files: {len(sample) - len(missing)} of {len(sample)} sampled found "
                          f"({only_deleted} among the deleted copies; {len(paths)} in the bucket)")

            records = run(["rclone", "lsf", "--files-only", "safe:uploads/current/ops/deletions"], env).split()
            ids = [r.removesuffix(".json") for r in records if re.fullmatch(r"[A-Za-z0-9-]+\.json", r)]
            replayed = 0
            for user_id in ids:
                if psql(target, f"SELECT delete_user_account('{user_id}')") == "t":
                    replayed += 1
            report.append(f"deletions: {len(ids)} recorded, {replayed} account(s) deleted again")
        finally:
            if not args.into and not args.keep:
                psql(args.admin_url, f"DROP DATABASE IF EXISTS {DRILL_DB}")

    if problems:
        raise DrillFailed("; ".join(problems) + "\n" + "\n".join(report))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    parser.add_argument("--admin-url", default=os.environ.get("RESTORE_ADMIN_URL",
                                                              "postgresql://postgres@127.0.0.1:5544/postgres"),
                        help="a Postgres 18 server with pgvector where the scratch database is made")
    parser.add_argument("--into", help="restore into this empty database and keep it (a real restore)")
    parser.add_argument("--backup", help="daily/<run time> or weekly/<run time>, as listed in R2 (default: the newest complete daily)")
    parser.add_argument("--samples", type=int, default=20, help="material files to look for in the mirror")
    parser.add_argument("--keep", action="store_true", help="keep the scratch database")
    parser.add_argument("--safe-remote", help=argparse.SUPPRESS)  # tests: a local folder instead of R2
    args = parser.parse_args()
    try:
        report = drill(args)
    except DrillFailed as exc:
        print(f"RESTORE DRILL FAILED: {exc}")
        return 1
    print("\n".join(report))
    today = datetime.now(UTC).date().isoformat()
    print(f"\nFor docs/deployment/RAILWAY.md:\n- {today}: restore drill passed ({report[0]}; {report[1]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check the Prisma migrations before they reach production (CI runs this; OPS-H3).

Two rules:

1. The AI service's REQUIRED_MIGRATION (ai-service/app/db/schema_version.py) is the newest migration. The AI service
   reports itself unready until that migration is applied, so a new migration that it does not name would let the
   service take traffic against a schema it was not tested with.

2. A migration after BASELINE only adds. The web app and the AI service deploy separately and both run against the
   database while the other is still on its old code, so a migration that drops, renames or tightens something breaks
   whichever service has not deployed yet. Such a change is done in steps (expand, move both services over, then
   contract), and the migration that contracts says so with a line `-- expand-contract: <why it is safe now>`.

Usage: scripts/check_migrations.py [repo root]. Exits 1 and lists the problems if either rule is broken.
"""
import re
import sys
from pathlib import Path

# Migrations up to and including this one predate the rule.
BASELINE = "20261206000000_ledger_cache_tokens"
MARKER = re.compile(r"^\s*--\s*expand-contract:[ \t]*\S", re.MULTILINE | re.IGNORECASE)
UNSAFE = [
    (re.compile(r"\bDROP\s+(COLUMN|TABLE|TYPE|INDEX|CONSTRAINT)\b", re.IGNORECASE), "drops"),
    (re.compile(r"\bRENAME\b", re.IGNORECASE), "renames"),
    (re.compile(r"\bSET\s+NOT\s+NULL\b", re.IGNORECASE), "makes a column NOT NULL"),
    (re.compile(r"\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b", re.IGNORECASE), "changes a column type"),
]
ADD_COLUMN = re.compile(
    r"\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\"?\w+\"?)((?:\([^)]*\)|[^,;(])*)", re.IGNORECASE
)  # the rest of the column: up to a comma or semicolon outside parentheses, as in NUMERIC(10,2)
REQUIRED = re.compile(r'^REQUIRED_MIGRATION\s*=\s*"([^"]+)"', re.MULTILINE)


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", sql)


def unsafe_changes(sql: str) -> list[str]:
    """What in `sql` is not additive, unless the file carries the expand-contract marker."""
    if MARKER.search(sql):
        return []
    body = _strip_comments(sql)
    problems = [label for pattern, label in UNSAFE if pattern.search(body)]
    for match in ADD_COLUMN.finditer(body):
        column, rest = match.group(1), match.group(2)
        if re.search(r"\bNOT\s+NULL\b", rest, re.IGNORECASE) and not re.search(r"\bDEFAULT\b", rest, re.IGNORECASE):
            problems.append(f"adds NOT NULL column {column} without a DEFAULT")
    return problems


def check(root: Path) -> list[str]:
    migrations_dir = root / "frontend" / "prisma" / "migrations"
    names = sorted(p.name for p in migrations_dir.iterdir() if (p / "migration.sql").is_file())
    problems = []

    version_file = root / "ai-service" / "app" / "db" / "schema_version.py"
    found = REQUIRED.search(version_file.read_text())
    required = found.group(1) if found else None
    if required != names[-1]:
        problems.append(
            f"{version_file.relative_to(root)}: REQUIRED_MIGRATION is {required!r} but the newest migration is "
            f"{names[-1]!r}; set it to the newest"
        )

    for name in names:
        if name <= BASELINE:
            continue
        for problem in unsafe_changes((migrations_dir / name / "migration.sql").read_text()):
            problems.append(
                f"{name}: {problem}. Split it into expand and contract steps, or mark the contract step with "
                f"'-- expand-contract: <why it is safe now>'"
            )
    return problems


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    problems = check(root)
    for problem in problems:
        print(problem)
    if not problems:
        print("Migrations OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

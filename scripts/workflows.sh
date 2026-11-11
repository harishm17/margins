#!/usr/bin/env bash
# The workflow suite (frontend/tests/workflows, see its README): the whole app driven through a browser on
# real course files, with the AI service replaying recorded model answers, so a run costs nothing.
#
#   scripts/workflows.sh [playwright arguments]     e.g. scripts/workflows.sh -g WF2
#
# Each run starts clean: it stops a stack left from an earlier run, recreates the database, migrates it,
# starts the stack (scripts/e2e-stack.sh) on replay, runs the suite, prints the checks report and stops.
# The web app is the production build in frontend/.next, built first when a source of it changed since the last build.
#
# Settings:
#   WF_FILES_DIR     the course files (required; made by scripts/workflow-files.py)
#   WF_CASSETTE_DIR  the recordings (required; kept outside the repository: they hold the course's text)
#   WF_RECORD=1      a request with no recording calls the real model and is recorded (costs money; the
#                    report says how much). Without it such a request fails the step that made it.
#   WF_DB_ADMIN_URL  a Postgres server with pgvector, as a URL to its postgres database
#                    (postgresql://dev:devpass@localhost:5432/postgres)
#   WF_DATABASE (margins_wf)  WF_WEB_PORT (3460)  WF_AI_PORT (8460)  WF_RUN_DIR (/tmp/margins-wf)
#   WF_RESULTS_DIR   where each workflow writes its checks (frontend/test-results/workflows)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WF_FILES_DIR:?set WF_FILES_DIR to the course files (scripts/workflow-files.py makes them)}"
: "${WF_CASSETTE_DIR:?set WF_CASSETTE_DIR to the folder of recordings}"
ADMIN_URL="${WF_DB_ADMIN_URL:-postgresql://dev:devpass@localhost:5432/postgres}"
DB="${WF_DATABASE:-margins_wf}"

export DATABASE_URL="${ADMIN_URL%/*}/$DB"
export E2E_WEB_PORT="${WF_WEB_PORT:-3460}"
export E2E_AI_PORT="${WF_AI_PORT:-8460}"
export E2E_RUN_DIR="${WF_RUN_DIR:-/tmp/margins-wf}"
export E2E_LLM_PROVIDER=replay
export E2E_CASSETTE_DIR="$WF_CASSETTE_DIR"
if [ "${WF_RECORD:-}" = 1 ]; then export E2E_REPLAY_MISS=record; else export E2E_REPLAY_MISS=error; fi
# Each workflow is a new student, and a replayed call counts its recorded cost: the whole suite in one day
# would pass the shared daily cap. Each student's own allowance (DAILY_LLM_BUDGET_USD) stays as it is.
export GLOBAL_DAILY_LLM_BUDGET_USD=100000
# A workflow student is minutes old, so the first-day allowance ($4) would apply; WF9 works up to the full
# DAILY_LLM_BUDGET_USD (harness/allowance.ts DAILY_LIMIT_USD). The first-day rule has its own tests in ai-service.
export FIRST_DAY_LLM_BUDGET_USD=0
export WF_FILES_DIR WF_CASSETTE_DIR
export WF_RESULTS_DIR="${WF_RESULTS_DIR:-$ROOT/frontend/test-results/workflows}"

stack() { "$ROOT/scripts/e2e-stack.sh" "$@"; }

stack stop
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\""
(cd "$ROOT/frontend" && npx prisma migrate deploy >/dev/null)
mkdir -p "$E2E_RUN_DIR" "$WF_CASSETTE_DIR" "$WF_RESULTS_DIR"
rm -rf "$E2E_RUN_DIR/uploads" "$E2E_RUN_DIR/hold"
rm -f "$WF_RESULTS_DIR"/*.json
started="$(date +%s)"
trap 'stack stop' EXIT
stack build
stack start

status=0
(cd "$ROOT/frontend" && PLAYWRIGHT_BASE_URL="http://localhost:$E2E_WEB_PORT" npx playwright test -c playwright.workflows.config.ts "$@") || status=$?

(cd "$ROOT/frontend" && npx tsx tests/workflows/report.ts "$WF_RESULTS_DIR") || status=1
misses="$(grep -c "No recording for" "$E2E_RUN_DIR/ai.log" || true)"
echo "Requests with no recording: $misses (the AI service's log: $E2E_RUN_DIR/ai.log)"
if [ "$E2E_REPLAY_MISS" = record ]; then
  echo "Recorded this run (real model calls, priced at list rates):"
  (cd "$ROOT/ai-service" && ENVIRONMENT=development uv run python -m app.services.llm.replay_provider "$WF_CASSETTE_DIR" "$started")
fi
exit "$status"

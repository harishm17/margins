#!/usr/bin/env bash
# The stack the Playwright specs run against: the web app (a production build) and the AI service
# with the mock LLM (no API calls, no cost), both on the database in DATABASE_URL. CI uses this
# script, and so can a laptop.
#
#   scripts/e2e-stack.sh start    start both in the background and wait until they answer
#   scripts/e2e-stack.sh stop     stop them
#
# Before `start`: the database is migrated (cd frontend && npx prisma migrate deploy), the web app is
# built (cd frontend && npm run build) and the AI service has its dependencies (cd ai-service && uv sync).
# The web app runs with ENABLE_TEST_LOGIN=true, the local-only test sign-in the specs use (students sign in
# with Google only, which a test cannot do; frontend/src/lib/auth/test-login.ts), and with a made-up Google
# client so the sign-in page shows its Google button. NEXTAUTH_URL is on localhost, which the test sign-in needs.
# It reads the AI status uncached (AI_STATUS_CACHE_MS=0), so a spec that marks AI unavailable sees it at once,
# and the AI service reaps every 5 seconds, so a job that waited for the AI is sent again soon after it is back.
# Use a database of its own for the stack and the specs (for example margins_e2e, migrated): the AI service's reaper
# sends any pending job in its database, so a database shared with `npm test` or a dev server lets their jobs, and
# the shared AI status, leak into the specs. Export the same E2E_RUN_DIR to the stack and to Playwright.
# Settings, all optional except DATABASE_URL:
#   E2E_WEB_PORT (3000)  E2E_AI_PORT (8000)  E2E_RUN_DIR (.e2e in the repo: logs, pids, uploads)
# The web app also gets E2E_HOLD_DIR=$RUN/hold, which lets a spec hold the app's own job before it is sent (src/lib/tasks/dispatch.ts).
# The web app allows 1000 voice turns a minute (VOICE_TURNS_PER_MINUTE; 30 in production): the voice specs all sign in as one account
# and together send more than 30 turns in a minute, which the turn limiter answers with "You're going a little fast".
# Then run the specs with PLAYWRIGHT_BASE_URL=http://localhost:$E2E_WEB_PORT and the same DATABASE_URL.
# The model behind the AI service, E2E_LLM_PROVIDER:
#   mock (the default)  canned answers, no API key, no cost: CI and the Playwright specs
#   replay              recorded answers from E2E_CASSETTE_DIR (the workflow suite, frontend/tests/workflows);
#                       E2E_REPLAY_MISS=record calls the real model for a request with no recording and stores it
#                       (it needs ANTHROPIC_API_KEY, from the shell or ai-service/.env, and costs money)
#   anthropic           the real model on every call (costs money)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT="${E2E_WEB_PORT:-3000}"
AI_PORT="${E2E_AI_PORT:-8000}"
RUN="${E2E_RUN_DIR:-$ROOT/.e2e}"
TOKEN="e2e-internal-token"
PROVIDER="${E2E_LLM_PROVIDER:-mock}"

# The AI service's model settings, as `env` arguments (no spaces inside a value).
llm_env() {
  case "$PROVIDER" in
    mock) echo "-u ANTHROPIC_API_KEY LLM_PROVIDER=mock" ;;
    replay)
      : "${E2E_CASSETTE_DIR:?E2E_LLM_PROVIDER=replay needs E2E_CASSETTE_DIR, the folder of recordings}"
      case "${E2E_REPLAY_MISS:-error}" in
        error) echo "-u ANTHROPIC_API_KEY LLM_PROVIDER=replay LLM_CASSETTE_DIR=$E2E_CASSETTE_DIR LLM_REPLAY_MISS=error" ;;
        record) echo "LLM_PROVIDER=replay LLM_CASSETTE_DIR=$E2E_CASSETTE_DIR LLM_REPLAY_MISS=record" ;;
        *) echo "E2E_REPLAY_MISS must be error or record, not $E2E_REPLAY_MISS" >&2; return 2 ;;
      esac ;;
    anthropic) echo "LLM_PROVIDER=anthropic" ;;
    *) echo "E2E_LLM_PROVIDER must be mock, replay or anthropic, not $PROVIDER" >&2; return 2 ;;
  esac
}

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

wait_http() {
  local name="$1" url="$2" log="$3"
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null --max-time 2 "$url"; then
      echo "$name is up ($url)"
      return 0
    fi
    sleep 1
  done
  echo "$name did not answer at $url; last lines of $log:" >&2
  tail -n 40 "$log" >&2 || true
  return 1
}

start() {
  : "${DATABASE_URL:?set DATABASE_URL to the migrated e2e database}"
  mkdir -p "$RUN/uploads" "$RUN/hold"
  local model_env
  model_env="$(llm_env)"

  if alive "$RUN/ai.pid"; then
    echo "AI service already running"
  else
    (
      cd "$ROOT/ai-service"
      # Word splitting is wanted: the model settings are several env arguments.
      # shellcheck disable=SC2086
      exec setsid env $model_env \
        AI_INTERNAL_TOKEN="$TOKEN" \
        ENVIRONMENT=development \
        JOB_REAPER_INTERVAL_SECONDS=5 \
        LOCAL_UPLOADS_DIR="$RUN/uploads" \
        FRONTEND_URL="http://localhost:$WEB_PORT" \
        AI_SERVICE_URL="http://127.0.0.1:$AI_PORT" \
        uv run uvicorn app.main:app --port "$AI_PORT" \
        >"$RUN/ai.log" 2>&1
    ) &
    echo $! >"$RUN/ai.pid"
  fi

  if alive "$RUN/web.pid"; then
    echo "web app already running"
  else
    (
      cd "$ROOT/frontend"
      exec setsid env \
        AI_SERVICE_URL="http://127.0.0.1:$AI_PORT" \
        AI_INTERNAL_TOKEN="$TOKEN" \
        NEXTAUTH_URL="http://localhost:$WEB_PORT" \
        NEXTAUTH_SECRET="e2e-secret-e2e-secret-e2e-secret-32" \
        ENABLE_TEST_LOGIN=true \
        GOOGLE_OAUTH_CLIENT_ID="e2e-not-a-real-client.apps.googleusercontent.com" \
        GOOGLE_OAUTH_CLIENT_SECRET="e2e-not-a-real-google-secret" \
        AI_STATUS_CACHE_MS=0 \
        LOCAL_UPLOADS_DIR="$RUN/uploads" \
        E2E_HOLD_DIR="$RUN/hold" \
        VOICE_TURNS_PER_MINUTE=1000 \
        NEXT_TELEMETRY_DISABLED=1 \
        npx next start --port "$WEB_PORT" \
        >"$RUN/web.log" 2>&1
    ) &
    echo $! >"$RUN/web.pid"
  fi

  wait_http "AI service" "http://127.0.0.1:$AI_PORT/health" "$RUN/ai.log"
  wait_http "web app" "http://127.0.0.1:$WEB_PORT/login" "$RUN/web.log"
}

stop_one() {
  local name="$1" file="$RUN/$1.pid"
  if alive "$file"; then
    local pid
    pid="$(cat "$file")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
    echo "stopped $name"
  fi
  rm -f "$file"
}

case "${1:-}" in
  start) start ;;
  stop) stop_one web; stop_one ai ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac

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
# Settings, all optional except DATABASE_URL:
#   E2E_WEB_PORT (3000)  E2E_AI_PORT (8000)  E2E_RUN_DIR (.e2e in the repo: logs, pids, uploads)
# Then run the specs with PLAYWRIGHT_BASE_URL=http://localhost:$E2E_WEB_PORT and the same DATABASE_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT="${E2E_WEB_PORT:-3000}"
AI_PORT="${E2E_AI_PORT:-8000}"
RUN="${E2E_RUN_DIR:-$ROOT/.e2e}"
TOKEN="e2e-internal-token"

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
  mkdir -p "$RUN/uploads"

  if alive "$RUN/ai.pid"; then
    echo "AI service already running"
  else
    (
      cd "$ROOT/ai-service"
      exec setsid env -u ANTHROPIC_API_KEY \
        LLM_PROVIDER=mock \
        AI_INTERNAL_TOKEN="$TOKEN" \
        ENVIRONMENT=development \
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
        ENABLE_GCS_STORAGE=false \
        ENABLE_TEST_LOGIN=true \
        GOOGLE_OAUTH_CLIENT_ID="e2e-not-a-real-client.apps.googleusercontent.com" \
        GOOGLE_OAUTH_CLIENT_SECRET="e2e-not-a-real-google-secret" \
        LOCAL_UPLOADS_DIR="$RUN/uploads" \
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

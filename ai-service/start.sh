#!/bin/sh
set -e

# Get PORT from environment variable, default to 8000 for local/docker.
# Railway injects its own PORT.
PORT=${PORT:-8000}
HOST=${HOST:-0.0.0.0}

echo "Starting the Margins AI service..."
echo "Environment: ${ENVIRONMENT:-not set (the service will refuse to start)}"
echo "Listening on port: ${PORT}"

# Start uvicorn with the PORT environment variable
# Using exec to replace shell process with uvicorn for proper signal handling
WORKERS=${UVICORN_WORKERS:-1}
# Running jobs get JOB_SHUTDOWN_GRACE_SECONDS (default 20) to finish on SIGTERM before they are cancelled and their
# leases released. Open requests get the same window first (uvicorn's graceful shutdown), so keep the deploy platform's
# drain time (RAILWAY_DEPLOYMENT_DRAINING_SECONDS) longer than twice this.
GRACE=${JOB_SHUTDOWN_GRACE_SECONDS:-20}
exec uvicorn app.main:app --host "$HOST" --port "$PORT" --workers "$WORKERS" --timeout-graceful-shutdown "${GRACE%.*}"

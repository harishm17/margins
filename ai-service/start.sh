#!/bin/sh
set -e

# Get PORT from environment variable, default to 8000 for local/docker.
# Railway injects its own PORT.
PORT=${PORT:-8000}
HOST=${HOST:-0.0.0.0}

echo "Starting the Margins AI service..."
echo "Environment: ${ENVIRONMENT:-development}"
echo "Listening on port: ${PORT}"

# Start uvicorn with the PORT environment variable
# Using exec to replace shell process with uvicorn for proper signal handling
WORKERS=${UVICORN_WORKERS:-1}
exec uvicorn app.main:app --host "$HOST" --port "$PORT" --workers "$WORKERS"

#!/bin/sh
set -eu

if [ "${LLMINGRESS_FIXTURE_MODE:-}" = "fail-gateway" ] && [ "${1:-}" = "gateway" ]; then
  exit 42
fi

if [ "${LLMINGRESS_FIXTURE_MODE:-}" = "slow-migrate" ] && [ "${1:-}" = "migrate" ]; then
  sleep 60
fi

exec /app/docker-entrypoint.sh "$@"

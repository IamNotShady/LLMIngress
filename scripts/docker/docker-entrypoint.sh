#!/bin/sh
set -eu

role="${1:-gateway}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$role" in
  gateway)
    exec node /app/gateway/main.mjs "$@"
    ;;
  console)
    exec node /app/console/apps/console/server.js "$@"
    ;;
  worker)
    exec node /app/worker/main.mjs "$@"
    ;;
  migrate)
    exec node /app/migrate/main.mjs "$@"
    ;;
  version)
    printf '%s\n' "${LLMINGRESS_VERSION:-dev}"
    ;;
  *)
    printf 'Unknown LLMIngress role: %s\n' "$role" >&2
    exit 64
    ;;
esac

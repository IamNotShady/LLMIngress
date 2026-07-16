#!/bin/sh
set -eu

role="${1:-all}"
if [ "$#" -gt 0 ]; then
  shift
fi

stop_children() {
  for pid in $child_pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in $child_pids; do
    wait "$pid" 2>/dev/null || true
  done
}

run_all() {
  node /app/migrate/main.mjs

  child_pids=""
  node /app/gateway/main.mjs &
  child_pids="$child_pids $!"
  node /app/console/apps/console/server.js &
  child_pids="$child_pids $!"
  node /app/worker/main.mjs &
  child_pids="$child_pids $!"

  trap 'stop_children; exit 143' TERM INT

  exit_code=0
  while [ -n "$child_pids" ]; do
    next_pids=""
    alive=0
    for pid in $child_pids; do
      if kill -0 "$pid" 2>/dev/null; then
        next_pids="$next_pids $pid"
        alive=1
      else
        wait "$pid" || exit_code=$?
        stop_children
        exit "$exit_code"
      fi
    done
    child_pids="$next_pids"
    if [ "$alive" -eq 0 ]; then
      break
    fi
    sleep 1
  done
  exit "$exit_code"
}

case "$role" in
  all)
    run_all
    ;;
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

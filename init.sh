#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to start LLMIngress." >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  pnpm install
fi

export GATEWAY_PORT="${GATEWAY_PORT:-4000}"
export CONSOLE_PORT="${CONSOLE_PORT:-3000}"
export WORKER_HEARTBEAT_MS="${WORKER_HEARTBEAT_MS:-30000}"

pids=()

cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}

trap cleanup INT TERM EXIT

echo "Starting LLMIngress gateway on http://localhost:${GATEWAY_PORT}"
pnpm --filter @llmingress/gateway dev &
pids+=("$!")

echo "Starting LLMIngress console on http://localhost:${CONSOLE_PORT}"
pnpm --filter @llmingress/console dev &
pids+=("$!")

echo "Starting LLMIngress worker"
pnpm --filter @llmingress/worker dev &
pids+=("$!")

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid"
      exit "$?"
    fi
  done

  sleep 1
done

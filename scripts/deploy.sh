#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! grep -q '^MASTER_KEY=' .env 2>/dev/null; then
  echo "MASTER_KEY=$(openssl rand -base64 32)" >> .env
fi

if [ "${1:-}" = "--ensure-env" ]; then
  exit 0
fi

exec docker compose up --build "$@"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! grep -q '^ENCRYPTION_KEY=' .env 2>/dev/null; then
  echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
fi

if [ "${1:-}" = "--ensure-env" ]; then
  exit 0
fi

branch_name="$(git branch --show-current)"
if [ -z "$branch_name" ]; then
  echo "Cannot deploy from a detached HEAD; check out a branch first." >&2
  exit 1
fi

if [ "$branch_name" = "main" ]; then
  compose_project_name="llmingress"
else
  normalized_branch_name="$(
    printf '%s' "$branch_name" \
      | tr '[:upper:]' '[:lower:]' \
      | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//'
  )"
  if [ -z "$normalized_branch_name" ]; then
    echo "Branch name does not contain a usable Docker Compose project name." >&2
    exit 1
  fi
  compose_project_name="llmingress-$normalized_branch_name"
fi

exec docker compose \
  --project-name "$compose_project_name" \
  up --build --force-recreate --remove-orphans "$@"

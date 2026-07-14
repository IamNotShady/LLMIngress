# Docker Deployment

## Install and upgrade

Published LLMIngress releases support Linux Docker servers on amd64 and arm64. Docker Engine 26 or
newer and `curl` are required; the installer uses the current Docker context and never installs
Docker or invokes `sudo`.

```bash
curl -fsSL https://github.com/IamNotShady/LLMIngress/releases/latest/download/install.sh | bash
```

The command is non-interactive. On first use it creates the `default` instance. Later runs keep the
saved configuration, repair missing containers, or upgrade to the release that supplied the script.
Use the exact release URL when a deployment must stay on a specific version.

Supported options are:

```text
--instance NAME
--bind-address IPV4
--console-port PORT
--gateway-port PORT
--console-origin URL
--gateway-url URL
--backup-retention COUNT
--help
```

The default ports are Console `3000` and Gateway `4000`, both bound to `127.0.0.1`. Keep that
default when using an SSH tunnel or a reverse proxy. Setting `--bind-address 0.0.0.0` exposes the
plain HTTP ports; TLS and reverse-proxy configuration remain the operator's responsibility.

For instance `default`, the installer owns containers named `llmingress-default-postgres`,
`llmingress-default-gateway`, `llmingress-default-console`, and `llmingress-default-worker`, plus a
short-lived `llmingress-default-migrate` container. It owns one private network and these volumes:

- `llmingress-default-postgres` — PostgreSQL data
- `llmingress-default-config` — generated secrets, runtime configuration, installed release, and
  upgrade journal
- `llmingress-default-backups` — verified upgrade snapshots, retaining the latest five by default

All owned resources carry `io.llmingress.managed=true` and an instance label. The installer refuses
to delete or adopt an existing resource without those labels. PostgreSQL is not published to the
host. Inspect service output with `docker logs llmingress-default-gateway` and the corresponding
Console, Worker, or PostgreSQL container name.

An upgrade never changes the PostgreSQL major version. It stops the application containers, creates
a custom-format dump and SHA-256 checksum, runs migrations, then starts and checks the target image.
If migration or health verification fails, the installer restores the dump and previous image. A
subsequent command recovers an upgrade interrupted after its journal was written. Downgrades are
refused.

## Cut over an existing Compose instance

Existing repository Compose deployments are not adopted automatically. The following manual path
is only for a current PostgreSQL 18.4 database created from `0001_core_baseline.sql`. Recreate older
development migration chains instead of importing them.

Keep the original `MASTER_KEY`: Provider credentials in the database were encrypted with it.

```bash
# In the old checkout, stop application writes but keep PostgreSQL running.
docker compose stop gateway console worker
docker compose exec -T postgres \
  pg_dump -U postgres -d postgres --format=custom --no-owner --no-privileges \
  > llmingress-cutover.dump

# Deploy the separately named managed instance.
curl -fsSL https://github.com/IamNotShady/LLMIngress/releases/latest/download/install.sh | bash
docker stop llmingress-default-gateway llmingress-default-console llmingress-default-worker

# Preserve the old encryption key in the managed config volume.
test -n "${MASTER_KEY:-}"
printf '%s' "$MASTER_KEY" | docker run --rm -i --user 0 --entrypoint sh \
  -v llmingress-default-config:/state postgres:18.4-alpine \
  -c 'cat > /state/master-key && chown 1001:1001 /state/master-key && chmod 0400 /state/master-key'

# Replace the new empty database with the old baseline database.
docker cp llmingress-cutover.dump llmingress-default-postgres:/tmp/llmingress-cutover.dump
docker exec llmingress-default-postgres dropdb -U postgres --if-exists --force llmingress
docker exec llmingress-default-postgres createdb -U postgres llmingress
docker exec llmingress-default-postgres pg_restore -U postgres -d llmingress \
  --no-owner --no-privileges /tmp/llmingress-cutover.dump
docker exec llmingress-default-postgres rm /tmp/llmingress-cutover.dump

docker start llmingress-default-gateway llmingress-default-console llmingress-default-worker
curl -fsS http://127.0.0.1:4000/health/ready
```

Keep the old Compose volume and the host dump until the Console and Gateway have been checked. This
cutover procedure is not a general backup/restore interface and is intentionally not performed by
the installer.

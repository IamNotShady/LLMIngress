# LLMIngress

## Docker Compose

Run the local stack, including Postgres:

```bash
export MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
export POSTGRES_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
export CONSOLE_SETUP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
docker compose up --build
```

Compose builds one shared `llmingress:local` app image, runs migrations once,
then starts Gateway on `http://localhost:4000`, Console on
`http://localhost:3000`, and Worker against the `postgres` service.

`MASTER_KEY`, `POSTGRES_PASSWORD`, and `CONSOLE_SETUP_TOKEN` are required for
Compose. They intentionally have no public defaults. Production startup rejects
the old public default `MASTER_KEY=test-master-key-change-me`; the temporary
compatibility switch is `LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY=true`, and
should only be used long enough to migrate a legacy deployment.

If local Postgres already uses port `55432`, override only the host port:

```bash
POSTGRES_PORT=55433 docker compose up --build
```

Compose binds host-published ports to `127.0.0.1` by default. To expose one
service, set only that service's publish host, for example
`CONSOLE_PUBLISH_HOST=0.0.0.0`; exposing Console does not also expose Postgres.

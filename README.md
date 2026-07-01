# LLMIngress

## Docker Compose

Run the local stack, including Postgres:

```bash
docker compose up --build
```

Compose builds one shared `llmingress:local` app image, runs migrations once,
then starts Gateway on `http://localhost:4000`, Console on
`http://localhost:3000`, and Worker against the `postgres` service.

Use a real secret key for persistent data:

```bash
MASTER_KEY='replace-me-with-a-long-secret' docker compose up --build
```

If local Postgres already uses port `55432`, override only the host port:

```bash
POSTGRES_PORT=55433 docker compose up --build
```

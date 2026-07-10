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

When exposing Console through a reverse proxy or any browser-facing origin other
than the request URL seen by the Node process, set `CONSOLE_PUBLIC_BASE_URL` to
the exact public origin, for example `https://console.example.com`. Console
mutating requests require an exact `Origin` match and do not infer the public
origin from forwarded headers.

If local Postgres already uses port `55432`, override only the host port:

```bash
POSTGRES_PORT=55433 docker compose up --build
```

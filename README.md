<p align="center">
  <img src="apps/console/public/llmingress-icon.svg" alt="LLMIngress" width="96" />
</p>

<h1 align="center">LLMIngress</h1>

<p align="center">Self-hosted ingress for routing AI Agent traffic across model providers.</p>

## Install

Docker Compose starts PostgreSQL, applies the baseline migration, then starts Console, Gateway,
and Worker:

```bash
git clone https://github.com/IamNotShady/LLMIngress.git
cd LLMIngress

export MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
export POSTGRES_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"

docker compose up --build
```

Published ports bind to `127.0.0.1` by default. Runtime and port overrides are documented in
[`.env.example`](.env.example).

## First request

Open [http://localhost:3000](http://localhost:3000), create the administrator password, then add a
Provider, create a Virtual Model, and create an Agent allowed to use that model. Copy the Agent's
one-time `llmi_` API key and send:

```bash
curl http://localhost:4000/v1/chat/completions \
  --header "Authorization: Bearer llmi_your_agent_key" \
  --header "Content-Type: application/json" \
  --data '{
    "model": "your-virtual-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Public endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/embeddings` | OpenAI Embeddings |
| `GET` | `/v1/models` | Authorized Virtual Model discovery |
| `GET` | `/health/live` | Gateway process liveness |
| `GET` | `/health/ready` | Database and configuration readiness |
| `GET` | `/health` | Readiness-compatible alias |

Agent endpoints are served by Gateway at [http://localhost:4000](http://localhost:4000) and require
the Agent API key except for health checks.

## User entry points

- Console: [http://localhost:3000](http://localhost:3000)
- Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, and Playground are the
  supported Console pages.
- Gateway: [http://localhost:4000](http://localhost:4000)
- PostgreSQL: `postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:55432/postgres`

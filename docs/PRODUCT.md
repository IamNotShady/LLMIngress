# LLMIngress Product Scope

This document is the V1 support boundary. A surface not listed as supported is not part of the
release unless it is added here with code and verification.

## Supported

### Gateway protocols

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`

Each API key carries a dedicated `llmi_` secret and may access only its granted Virtual
Models. Provider payloads remain protocol-native; Gateway replaces the Virtual Model name with
the selected Provider model and does not log prompts, successful responses, or tool arguments.
Provider response headers are preserved. For browser requests, Gateway appends its own entries to
the Provider's `Access-Control-Expose-Headers` value instead of replacing it.

### Providers and models

Supported Provider types are API Key, Subscription OAuth, and Local. Current templates are:

- Subscription: OpenAI Codex, Claude Code, MiniMax Coding Plan, Grok
- API Key: Google Gemini, OpenRouter, DeepSeek, AWS Bedrock, xAI, Qwen, Moonshot/Kimi, MiniMax, Z.ai, GLM Coding Plan, Qwen Token Plan, Kimi Coding Plan, Command Code, ClinePass, BytePlus ModelArk, NousResearch, Groq, Cerebras, Fireworks AI, Mistral, NVIDIA NIM, Xiaomi MiMo, Ollama Cloud, OpenCode Go, Xiaomi MiMo Token Plan, Mistral Vibe
- Local: Ollama, LM Studio, llama.cpp

Coding-plan templates come in two shapes. GLM/Qwen/Kimi/Command Code/ClinePass/BytePlus ModelArk
are paste-key (`api_key`) providers that connect the same way as any API key; MiniMax Coding Plan
is the one **subscription-type** coding plan, authorized through a device/user-code OAuth flow
rather than a pasted key — do not confuse it with the paste-key coding plans (`byteplus_coding`
shares the `_coding` suffix but is paste-key, unlike the subscription `minimax_coding`).
NousResearch is a plain paste-key inference API. All of them are distinct from the similarly named
base templates by base path and/or protocol:

- GLM Coding Plan (`glm_coding`) — OpenAI Chat Completions at `https://api.z.ai/api/coding/paas/v4`, versus Z.ai (`zai`) at `https://api.z.ai/api/paas/v4` (`/coding/` segment differs). Upstream quota is reported (it reuses Z.ai's monitor endpoint).
- Qwen Token Plan (`qwen_token_plan`) — OpenAI Chat Completions at `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, versus Qwen (`qwen`) at `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (different host). No Chat Completions Responses endpoint; upstream quota is not reported.
- Kimi Coding Plan (`kimi_coding`) — Anthropic Messages protocol with `x-api-key` at `https://api.kimi.com/coding/v1`, versus Moonshot/Kimi (`moonshot`) which is OpenAI Chat Completions at `https://api.moonshot.ai/v1`. Upstream quota is reported from a separate `Bearer`-authenticated usage endpoint.
- MiniMax Coding Plan (`minimax_coding`) — the subscription-type exception: Anthropic Messages at `https://api.minimax.io/anthropic/v1`, authorized by a device/user-code OAuth flow (show a code, open the verification page, poll to completion). It is distinct from the API Key MiniMax (`minimax`), which is an OpenAI Chat Completions paste-key provider at `https://api.minimax.io/v1` with a `token_plan` quota endpoint; the coding plan uses OAuth and a `coding_plan` quota endpoint.
- Command Code (`command_code`) — the first paste-key provider with two routable faces from one base at `https://api.commandcode.ai/provider/v1`: OpenAI Chat Completions with a `Bearer` key, and Anthropic Messages where the upstream authenticates with a bare `x-api-key` and an `anthropic-version` header. Model discovery and connectivity use the default `Bearer` Chat Completions path. Upstream quota is not reported. Keys are typically the `user_` prefix; the prefix is not validated.
- ClinePass (`cline_pass`) — OpenAI Chat Completions at `https://api.cline.bot/api/v1` with a `Bearer` key. Upstream quota is not reported. Keys are typically the `sk_` prefix; the prefix is not validated. Prices sync automatically from its catalog section (the channel's own resale prices).
- BytePlus ModelArk (`byteplus_coding`) — OpenAI Chat Completions at `https://ark.ap-southeast.bytepluses.com/api/coding/v3` with a `Bearer` key. It carries the `_coding` suffix but is paste-key (`api_key`), unlike the subscription `minimax_coding`. It is pinned Chat Completions only; the upstream Anthropic-protocol endpoint sits under a different base path segment and is out of scope. Upstream quota is not reported.
- NousResearch (`nous`) — OpenAI Chat Completions at `https://inference-api.nousresearch.com/v1` with a `Bearer` key. Upstream quota is not reported.

Batch 4 adds seven pay-as-you-go inference clouds, all pure OpenAI Chat Completions paste-key (`api_key`) providers with a `Bearer` key and default connectivity/model discovery. Six sync prices automatically from models.dev; `ollama_cloud` does not (it is subscription-billed and carries no per-token price). Upstream quota is not reported for any of them except Fireworks AI, which reports its monthly spend budget.

- Groq (`groq`) — OpenAI Chat Completions at `https://api.groq.com/openai/v1`. Keys are typically the `gsk_` prefix; the prefix is not validated. Prices sync automatically.
- Cerebras (`cerebras`) — OpenAI Chat Completions at `https://api.cerebras.ai/v1`. No fixed key prefix. Prices sync automatically.
- Fireworks AI (`fireworks`) — OpenAI Chat Completions at `https://api.fireworks.ai/inference/v1`. Keys are typically the `fw_` prefix; the prefix is not validated. Prices sync automatically (models.dev names the section `fireworks-ai`, aliased to `fireworks`). Upstream quota is reported: the probe resolves the key's control-plane account (`GET /v1/accounts` on the same `api.fireworks.ai` origin), reads the `monthly-spend-usd` quota (monthly budget plus month-to-date spend) from the account quotas endpoint, and renders it as a Monthly budget utilization window. Accounts without a spend budget (Enterprise) report no quota limits; the prepaid credit balance has no public endpoint and is not shown.
- Mistral (`mistral`) — OpenAI Chat Completions at `https://api.mistral.ai/v1`. No fixed key prefix. Prices sync automatically. Its Admin usage/spend API exists but is Enterprise-only and needs a separate Admin credential, so upstream quota is treated as requires-separate-credential (not reported).
- NVIDIA NIM (`nvidia`) — OpenAI Chat Completions at `https://integrate.api.nvidia.com/v1`. Keys are typically the `nvapi-` prefix; the prefix is not validated. Prices sync automatically.
- Xiaomi MiMo (`xiaomi`) — OpenAI Chat Completions at `https://api.xiaomimimo.com/v1`. Keys are typically the `sk-` prefix; the prefix is not validated. Prices sync automatically.
- Ollama Cloud (`ollama_cloud`) — OpenAI Chat Completions at `https://ollama.com/v1` with any key format. It is a distinct remote `api_key` provider, independent from the Local `ollama` daemon (different provider type and base handling). It is subscription-billed, so prices are not synced (its catalog section carries no per-token cost).

Batch 5 adds three subscription-plan providers that connect by pasting a token, all paste-key (`api_key`) providers with a `Bearer` chat key and default connectivity/model discovery. None sync prices (a subscription plan has no per-token list price) and none report upstream quota.

- OpenCode Go (`opencode_go`) — a paste-key provider with two routable faces from one base at `https://opencode.ai/zen/go/v1`: OpenAI Chat Completions with a `Bearer` key, and Anthropic Messages where the upstream authenticates with a bare `x-api-key`. Model discovery and connectivity use the default `Bearer` Chat Completions path. It is a monthly subscription with USD-quota rate limiting tracked in the OpenCode console, so upstream quota is not reported. No fixed key prefix.
- Xiaomi MiMo Token Plan (`xiaomi_token_plan`) — OpenAI Chat Completions, default base `https://token-plan-sgp.xiaomimimo.com/v1` (the Singapore region). The upstream also serves `https://token-plan-cn.xiaomimimo.com/v1` (mainland China) and `https://token-plan-ams.xiaomimimo.com/v1` (Amsterdam); the base is editable in the Add Provider dialog, so pick the closest region there. It is distinct from Xiaomi MiMo (`xiaomi`) at `https://api.xiaomimimo.com/v1`. Keys are typically the `tp-` prefix; the prefix is not validated. Upstream quota is not reported (Token Plan usage lives in the plan-manage console).
- Mistral Vibe (`mistral_vibe`) — OpenAI Chat Completions at `https://api.mistral.ai/v1`, the same base as the standard Mistral (`mistral`) but a distinct paste-key template: use Mistral for a standard API key and Mistral Vibe for a Vibe subscription key. Upstream quota is treated as requires-separate-credential (the Admin usage API is Enterprise-only, like Mistral). Its `mistral-vibe-cli-latest` model has no models.dev or LiteLLM entry, so metadata shows as Unknown until set manually via the Console override.

Batch 7 adds AWS Bedrock as a paste-key (`api_key`) OpenAI Chat Completions provider on AWS's documented OpenAI-compatible mantle face. Prices sync automatically; upstream quota is not reported from the ABSK key.

- AWS Bedrock (`bedrock`) — OpenAI Chat Completions at the default mantle base `https://bedrock-mantle.us-east-1.api.aws/v1` (us-east-1). Fourteen mantle regions are available (`us-east-1`, `us-east-2`, `us-west-2`, `ap-southeast-3`, `ap-south-1`, `ap-southeast-2`, `ap-northeast-1`, `eu-central-1`, `eu-west-1`, `eu-west-2`, `eu-south-1`, `eu-north-1`, `sa-east-1`, `us-gov-west-1`); the base is editable in the Add Provider dialog, including the bedrock-runtime variant `https://bedrock-runtime.{region}.amazonaws.com/v1` for runtime-only models. Mantle is a model subset relative to bedrock-runtime (for example GPT-5.x/Grok on mantle; older Claude/Llama may require the runtime base). Paste an ABSK long-term key or a short-lived `bedrock-api-key-` key as a `Bearer` credential; key prefixes are not validated (AWS recommends long-term ABSK keys for exploration only; short-lived keys are region-bound and expire in about 12 hours). Prices sync automatically from the models.dev `amazon-bedrock` catalog (aliased to `bedrock`). Upstream quota is treated as requires-separate-credential — usage lives in CloudWatch and quotas in Service Quotas, both reachable only with a separate SigV4 IAM credential, not the ABSK key.

Batch 8 adds **Grok** (`grok`) as the fourth subscription-type provider — a SuperGrok plan used through OAuth as an API — and the first subscription provider to route the OpenAI Chat Completions face. It authorizes through a popup authorization-code flow (open the authorization page at `auth.x.ai`, paste the callback URL back), reusing the same OAuth engine and Console dialog as Claude Code; there is no pasted key.

- Grok (`grok`) — dual OpenAI faces from the official inference proxy base `https://cli-chat-proxy.grok.com/v1`: Chat Completions and Responses (the upstream's `grok-*-multi-agent*` variants are Responses-only, so both faces ride the same base). This is the OAuth inference-proxy path and is distinct from the API Key xAI (`xai`) template at `https://api.x.ai/v1`, which is the pay-as-you-go direct API path; the two coexist and use separate credentials. Egress carries the OAuth `Bearer` plus the upstream client's identity headers (`X-XAI-Token-Auth`, a versioned `grok-shell` `User-Agent`), which the proxy requires. Upstream quota is reported: a `/billing` probe surfaces two windows — a rolling period-usage window and a legacy monthly-limit window. **403 gate:** xAI allowlists accounts for OAuth API usage, so some otherwise-valid SuperGrok accounts connect successfully but have every request rejected with 403 (an upstream account policy, not a configuration error) — if that happens, switch to the xAI API key template (`xai`), which is pay-as-you-go and unaffected. A 402 means the plan's credits are exhausted.

Console supports Provider lifecycle, multiple API keys, OAuth, model refresh, dependency-protected
deletion, and connection checks. Model metadata may be merged from Provider APIs, models.dev,
OpenRouter, LiteLLM, and Vercel; missing values remain unknown and manual values take precedence.
Known embedding-only models remain stored as Provider metadata but are hidden from Console model
catalogs and cannot be selected for Gateway routes.

Health belongs to a Provider connection: each API key or OAuth token is independent, while a Local
Provider has one logical connection. Worker probes up to three chat models. The sparse
`provider_health_summary` contains only unhealthy connections; recovery deletes the row.

### Virtual Model routing

A Virtual Model is created atomically with one Route Policy and at least one candidate. Supported
strategies are `fixed`, `cost_first`, `load_balance`, and `tag`. `cost_first` orders by input price plus
output price and places unknown prices last. The candidate picker filters only by endpoint protocol,
so capability differences remain selectable; saving rejects differences between known capability
values and reports every conflicting field with both candidate names and values. Unknown values
remain allowed and skip the corresponding request pre-check.

A `tag` route mixes deliberately unequal candidates: every candidate carries its own tags, exactly
one carries `default`, and a request names a tag through the `x-llmingress-route-tag` header. No
tag, an unknown tag, or a failed tagged candidate is served by the default candidate, and nothing
past it. Saving skips the shared capability agreement; a default candidate that cannot absorb a
tagged one is reported as a warning on the Virtual Model detail, and each request is
capability-checked against the candidate it selected.

Before the first client byte, Gateway may try another credential or candidate. After streaming
starts, it never replays the request. Confirmed unhealthy connections are filtered; models and
Providers do not have independent health state.

### API keys, limits, and accounting

API key creation atomically stores its secret, Virtual Model grants, optional default model, Limits
switch, and initial rules. Disabling an API key preserves its configuration. Disabling Limits
preserves rules and skips all limit reads and enforcement.

Supported rules are budget, RPM, TPM, concurrency, and per-request token limits. Supported
operational records are request metadata, latency, status, token usage, actual or estimated cost,
fallback attempts, and Provider-connection health history.

### Console, Worker, and health

Supported Console pages are Overview, API Keys, Providers, Virtual Models, Activity, Usage, Limits,
and Playground. Playground keeps its Virtual Model selector empty until an API key is pasted, then
populates it only from the key-scoped Gateway `GET /v1/models` response. Its HEADERS editor adds one
row per request header, each a picker over the Gateway's CORS request-header allowlist minus the
names the form or the Gateway's own auth already owns, beside a box for the value; a row with no value, a value outside printable
ASCII, or a header a row above already carries is marked in red and blocks the send. Rows are added
and removed without leaving the page. The form generates a unique `x-request-id` for every send so
each response resolves only its own Activity trace. The Route trace names the tag a tag-routed
request asked for and whether it matched or fell back to the default candidate. Password setup,
session authentication, stable operation errors, and secret encryption are required. URL-driven filter
controls always reflect the current query state; clearing filters restores their documented
defaults, including Activity's Last 24h window. Selecting a different Provider starts a fresh
Provider-scoped view: errors, dialogs, credential and OAuth drafts, and model filters from the
previous Provider are not carried forward. Failures from button-only idempotent actions such as
Refresh models and Re-check use the shared four-second Toast in a red error state; form validation
and mutation refusals that require user correction stay beside their fields. Provider Edit,
Enable/Disable, Delete, and Refresh models actions share one unbroken toolbar row.
The masthead remembers each URL-driven module's durable view choices independently, so switching
modules and returning restores that module's selected window, filters, paging, and primary row.
Transient dialogs, drawers, mutation drafts, OAuth callback values, Toasts, and Playground secrets
are excluded; clearing a module updates its remembered state to that module's defaults.
Providers, API Keys, Virtual Models, Limits, and Activity list newly created records first, with a
stable record-id tie-breaker when creation timestamps match.

Persistent Worker jobs are exactly `model_refresh`, `provider_connection_probe`, `price_sync`, and
`provider_quota_probe`.
Retention and stale-concurrency repair run directly under PostgreSQL advisory locks and do not
create jobs.

Gateway exposes `/health/live`, `/health/ready`, and the readiness-compatible `/health` alias.

Self-hosted beta deployments use repository Docker Compose: one app container (multi-role image)
plus one PostgreSQL 18.4 container.

## Unsupported

V1 does not include:

- Runtime, Settings, or standalone Routing pages
- notifications, alerts, Webhook delivery, or external exports
- database backup or restore workflows
- one-command remote installer or managed upgrade snapshots
- billing reconciliation or savings/baseline-cost reporting
- Prometheus metrics or OpenTelemetry tracing
- persisted runtime heartbeat, status, or error products
- `quality_first`, legacy route rules, API key modes, or request-logging switches
- configuration import/export or Route Preview APIs

The project is pre-release. `packages/db/migrations/` is authoritative: `0001_core_baseline.sql`
plus incremental migrations applied in order. Databases from development chains older than the
baseline squash are recreated rather than upgraded in place.

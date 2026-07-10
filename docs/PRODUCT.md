# LLMIngress Product Design

> LLMIngress is an AI Gateway for AI Agents. Agents connect to one unified
> LLMIngress endpoint, while LLMIngress connects to multiple providers and
> models behind the scenes and automatically chooses suitable models from the
> request parameters, context, and usage scenario.

## 1. Product Positioning

LLMIngress is a user-deployed model ingress layer for AI Agents. Users connect
Codex, Claude Code, Cursor, OpenCode, Hermes, and other agents to LLMIngress.
LLMIngress then centralizes provider access, model selection, fallback, cost
recording, and usage control.

Core goals:

- Unified AI Agent ingress: Codex, Claude Code, Cursor, OpenCode, Hermes, and
  other agents connect to one LLMIngress Gateway.
- Automatic model matching: select the real provider and model from request
  parameters, context length, task type, tool usage, model capability, and usage
  scenario.
- Unified provider and model management: manage API keys, subscription quota,
  and local models in one place so multiple agents can reuse the same model
  resources.
- AI Agent focused routing policies: model routing around common agent
  scenarios such as coding, repository understanding, terminal and shell work,
  long context, reasoning, and tool calling.
- Higher request reliability: automatically switch to fallback models when a
  provider is rate limited, fails, times out, or a model is unavailable.
- Agent-level observability: view requests, selected models, tokens, costs,
  failure reasons, fallback behavior, and latency by Agent and Virtual Model
  Name.
- Lower setup cost: provide each Agent with a clear Gateway URL, API key,
  Virtual Model Name, and configuration examples.
- User-owned deployment and data: run on a personal computer, local server, or
  cloud server while the user controls provider keys, model configuration,
  request logs, and data storage location.

## 2. Product Scope

### 2.1 Core Scope

- AI Agent unified ingress: provide one Gateway endpoint, one unique API key per
  Agent, and the Virtual Model Names each Agent may use.
- Automatic model routing: route through Virtual Model Name and Route Policy
  using request parameters, context length, task type, tool usage, model
  capability, and usage scenario.
- Provider and model resource management: manage API keys, subscription quota,
  local models, and provider model lists.
- Agent scenario routing: support common AI Agent scenarios such as coding,
  repository understanding, terminal and shell work, long context, reasoning,
  and tool calling.
- Reliability and fallback: switch to backup models when a provider is rate
  limited, fails, times out, or a model is unavailable.
- Agent-level observability: record requests, selected models, tokens, costs,
  failure reasons, fallback behavior, and latency by Agent and Virtual Model
  Name.
- Onboarding guidance: provide Gateway URL, API key, Virtual Model Name, and
  configuration examples for different agents.
- User-owned deployment and data: support local machines, local servers, and
  cloud servers while the user controls provider keys, model configuration,
  request logs, and data storage.

## 3. Target Users

### 3.1 Primary User

Personal developers, AI power users, independent developers, and heavy AI Agent
users.

Typical traits:

- Uses multiple AI coding agents or desktop agents at the same time.
- Has multiple model accounts or subscriptions such as OpenAI, Claude, Gemini,
  Copilot, or local models.
- Frequently switches models or providers.
- Wants to understand how much each Agent costs, how many tokens it uses, and
  how often it fails.
- Wants simple requests to use cheap models and complex tasks to use stronger
  models.

### 3.2 Typical Agents

Priority agents:

- Codex.
- Claude Code.
- Cursor.
- OpenCode.
- Hermes.
- OpenClaw.
- GitHub Copilot.
- Other agents that can configure an OpenAI-compatible endpoint.

Initial support depends on each Agent's actual endpoint configuration surface.
If a closed-source Agent cannot configure a custom Gateway, LLMIngress only
supports the model request paths that the Agent exposes.

## 4. Core User Stories

### 4.1 Connect Multiple AI Agents Through One Gateway

As a personal AI Agent user, I want Codex, Claude Code, Cursor, OpenCode,
Hermes, OpenClaw, GitHub Copilot, and similar agents to connect to one Gateway,
so that real providers, provider API keys, and real models only need to be
maintained inside LLMIngress. Each Agent only needs a Gateway URL, the Agent's
unique API key, and a `model` value that uses an exposed Virtual Model Name.

### 4.2 Manage Model Resources In One Place

As a personal AI Agent user, I want to configure OpenAI, Anthropic, Google,
OpenRouter, GitHub Copilot, and local Ollama in one place, so all agents can
reuse the same model resources, subscription quota, and local model capability.

### 4.3 Choose Models Based On Task Context

As a personal AI Agent user, I want LLMIngress to automatically select a
suitable real model from task complexity, context length, tool usage, quality
requirements, and usage scenario, so I do not need to manually decide which
model to use every time.

### 4.4 Optimize Cost

As a personal AI Agent user, I want simple tasks, small edits, and low-risk
requests to prefer low-cost models, local models, or models covered by existing
subscriptions. More complex reasoning, long-context analysis, and critical code
changes should use stronger models, so I avoid sending every request to the
most expensive model.

### 4.5 Keep Quality With Automatic Fallback

As a personal AI Agent user, I want requests to switch to a better backup model
when routing rules decide the cheaper model is not suitable, or when a request
fails, a provider is rate limited, or a model is unavailable. This keeps the
Agent workflow from being interrupted and improves reliability for important
tasks.

V1 does not promise automatic quality judging after a response has already been
generated. Quality-driven upgrade can be a V2 feature behind an explicit judge
or retry policy.

### 4.6 Understand Selection Reasons And Savings

As a personal AI Agent user, I want to see the selected model, selection reason,
tokens, cost, fallback behavior, and savings compared with a fixed expensive
baseline model by Agent, so I can understand how LLMIngress balances quality and
cost.

### 4.7 Control Budgets

As a personal AI Agent user, I want to set cost or token limits for each Agent
and choose the Virtual Model Names it may use, so a loop, misconfiguration, or
overuse of expensive models cannot cause uncontrolled spend.

## 5. Product Information Architecture

LLMIngress has two top-level product modules:

- Gateway Service: the runtime gateway that receives AI Agent requests, applies
  routing policies, forwards requests to real providers, and returns provider
  responses to the Agent.
- Console: the management UI for Agent onboarding, provider configuration,
  model management, route policies, request observability, cost analysis, and
  budget control.

### 5.1 Gateway Service

Gateway Service is the LLMIngress runtime module and the data plane that
actually handles Agent requests. It can run on a personal computer, local
server, or cloud server and exposes one unified Gateway endpoint.

Gateway Service capabilities:

- Receive requests from different AI Agents, with OpenAI-compatible API support
  as the priority.
- Identify the requesting Agent and validate that Agent's API key.
- Normalize different Agent request protocols and forward them to backend
  providers.
- Match Route Policies by Agent, Virtual Model Name, task type, complexity,
  context length, tool usage, and cost preference.
- Select a real provider and real model for each request.
- Forward requests to OpenAI, Anthropic, Google, OpenRouter, GitHub Copilot,
  and Ollama.
- Support streaming responses and forward provider output back to the original
  Agent.
- Automatically switch to a backup model when a provider fails, is rate limited,
  times out, or a model is unavailable.
- Record Agent, Agent key prefix, Virtual Model Name or Route Policy, selected
  provider, selected model, tokens, cost, latency, failure reason, and fallback
  path.
- Enforce Agent-level token limits, cost limits, rate limits, and budget
  policies.
- Apply Console configuration changes to new requests after Gateway hot reload
  succeeds.
- Expose Gateway health, provider connectivity, runtime address, version, and
  recent errors.

### 5.2 Console

Console is the LLMIngress control plane. It does not handle Agent model traffic.
It manages the configuration Gateway needs and displays runtime data generated
by Gateway.

Top-level Console modules:

- Overview: Gateway status, today's requests, today's cost, failure rate,
  savings, and active Agents.
- Agents: Agent type, Gateway URL, unique API key, Allowed Virtual Model Names,
  Budget and Limit settings, and onboarding instructions.
- Providers: OpenAI, Anthropic, Google, OpenRouter, GitHub Copilot, and Ollama
  configuration.
- Models: available models, capabilities, context length, pricing, provider
  ownership, and routing eligibility.
- Virtual Models / Routes: global Virtual Model Names and their Route Policies,
  provider scope, model scope, Fallback Chain, and cost preference.
- Activity: each request's Agent, Agent key prefix, Virtual Model Name,
  provider, selected model, latency, tokens, cost, failure reason, and fallback
  path.
- Usage & Cost: tokens, cost, model distribution, and savings by Agent, Virtual
  Model Name, provider, model, and time range.
- Limits: Agent-level token limits, cost limits, hourly/daily/weekly/monthly
  budgets, RPM, TPM, concurrency, and over-limit behavior.
- Gateway Runtime: Gateway address, version, health check, config load state,
  and migration status. Provider connectivity is shown on the Providers page.
- Playground: live test requests through the Gateway Public API, including the
  selected provider/model and selection reason.
- Settings: Console preferences, security hints, and notification channels.
  Config import/export remains an authenticated Console API capability and is
  not shown as a Settings page feature.

### 5.3 Module Relationships

- The user creates an Agent in Console and receives the Gateway URL, unique
  Agent API key, and allowed Virtual Model Names.
- The AI Agent sends model requests to Gateway Service.
- Gateway first uses the Agent-owned API key to identify the Agent, permissions,
  and budget limits. It then uses the request `model` field to resolve the
  Virtual Model Name or Route Policy.
- Gateway uses Console-configured Providers, Models, Virtual Models / Routes,
  and Limits to execute request forwarding.
- The provider response is returned to the original AI Agent.
- Gateway records request logs, usage, costs, and errors. Console displays and
  analyzes that data.

### 5.4 Core Configuration Relationships

LLMIngress core configuration:

```text
User
|-- AI Agent
|   |-- unique API key
|   |-- Budget / Limit
|   |-- Usage Attribution
|   `-- Allowed Virtual Model Names
|
`-- Virtual Model Name / Route Policy
    |-- Provider scope
    |-- Model scope
    |-- Cost preference
    |-- Task type rules
    |-- Complexity rules
    |-- Context length rules
    |-- Tool calling rules
    `-- Fallback Chain
```

Core rules:

- The Agent's unique API key identifies the caller. Permissions, usage
  attribution, Budget, and Limit belong to the Agent.
- Virtual Model Name selects the routing policy.
- Each Virtual Model Name maps to exactly one Route Policy.
- When the user creates a routing policy, the user creates or chooses the
  corresponding Virtual Model Name.
- The same Virtual Model Name always maps to the same Route Policy.
- One Agent can be authorized to use multiple Virtual Model Names.
- Multiple Agents can use the same Virtual Model Name.
- Fallback Chain is part of the Route Policy.
- Provider and Model are the resources selected and called by the Route Policy.

## 6. Agent Onboarding Capabilities

### 6.1 Agent Management

- Create Agent.
- Set Agent name.
- Set Agent type.
- Set Agent platform.
- View Agent list.
- View Agent status.
- Rename Agent.
- Delete Agent.
- Copy Agent configuration.
- Generate a dedicated API key when creating an Agent. The plaintext key is
  shown only once.
- Enable or disable Agent request recording.

### 6.2 Agent Types

Agent categories are based on AI Agent usage shape:

- Coding Agent.
- Desktop Agent.
- Terminal Agent.
- IDE Agent.
- Other Agent.

### 6.3 Initial Agent Targets

- Codex.
- Claude Code.
- Cursor.
- OpenCode.
- GitHub Copilot.
- Hermes.
- OpenClaw.
- Other agents that can configure an OpenAI-compatible endpoint.

### 6.4 Agent Onboarding Flow

Each Agent must configure:

- Gateway Base URL.
- Agent-specific API Key.
- One or more authorized Virtual Model Names.

The Agent API key identifies which Agent sent the request. That Agent owns
permissions, Budget, Limit, and usage attribution. The Virtual Model Name
selects the Route Policy for the request.

The Console must output onboarding instructions for different agents. After
Agent creation it shows the Gateway URL, Agent API key, and available Virtual
Model Names once. Later dashboard views only show the key prefix.

Capabilities:

- Copy configuration snippets.
- Check whether an Agent has successfully sent a request.
- View the Virtual Model Names the Agent may use.
- Set the Agent's default Virtual Model Name.

### 6.5 Agent Status

- Not configured.
- Created but not connected.
- Connected.
- Recently active.
- Recent request failed.
- Provider unavailable.
- Over budget.

## 7. Gateway Capabilities

### 7.1 Unified Ingress

- Provide an OpenAI-compatible endpoint.
- Support `POST /v1/chat/completions`.
- Support `POST /v1/responses`.
- Support `POST /v1/messages`.
- Support `POST /v1/embeddings`.
- Support `GET /v1/models`.
- Prioritize mainstream Agent access through OpenAI-compatible APIs.
- Anthropic-compatible `/v1/messages` is a core access capability for Claude
  Code support.
- `GET /v1/models` returns the Virtual Model Names authorized for the current
  Agent, not the real provider model list.
- `/v1/responses` supports a stateless V1 subset. Stateful chained calls such
  as `previous_response_id` and server-side `store` are not default cross-provider
  V1 capabilities.

### 7.2 Virtual Model Abstraction

- The Agent request `model` field contains a Virtual Model Name.
- Virtual Model Name is the user-visible name of a Route Policy.
- Each Virtual Model Name maps to exactly one Route Policy.
- Each Route Policy is exposed as one Virtual Model Name.
- The same Virtual Model Name always maps to the same Route Policy.
- Virtual Model Names must be unique within one LLMIngress instance.
- An Agent can be authorized to use multiple Virtual Model Names.
- Gateway identifies the Agent from the Agent-owned API key, then resolves the
  Route Policy from the Virtual Model Name.
- If the request does not specify `model`, Gateway may use the Agent's default
  Virtual Model Name.

### 7.3 Request Capabilities

- Plain text requests.
- Streaming responses.
- Tools and function calling passthrough.
- Common sampling parameter passthrough.
- `max_tokens`, `temperature`, `top_p`, and similar parameters.
- Provider-specific parameters.
- Request timeout control.
- Client-side request cancellation.

### 7.4 Response Metadata

Each request's routing path must be traceable. Response metadata and Activity
records show the selected model, route reason, tokens, and cost. Full API keys
are never returned, only key prefixes.

- Agent.
- Agent key prefix.
- Virtual Model Name.
- Route Policy.
- Selected provider.
- Selected model.
- Routing tier.
- Routing reason.
- Fallback result.
- Estimated input tokens.
- Estimated output tokens.
- Estimated cost.
- Request duration.

### 7.5 Gateway Authentication

- Each Agent uses an independent API key.
- API keys are only for LLMIngress Gateway.
- The API key identifies the Agent. Permissions, Budget, Limit, and usage
  attribution belong to the Agent.
- An Agent can be bound to an allowed Virtual Model Name list.
- Key prefixes should use `llmi_`.
- Dashboard shows the key prefix.
- V1 does not support key rotation or disablement. If a key is lost or leaked,
  delete and recreate the Agent.

### 7.6 Error Feedback

- Gateway returns errors in a unified format so the Agent can distinguish error
  categories.
- Error categories must include invalid key, unauthorized Virtual Model,
  over budget, over rate limit, upstream provider unavailable, all fallbacks
  failed, and request timeout.
- Each error includes a request id that can be used to find the Activity record.

### 7.7 Observability Export

- Prometheus metrics.
- OpenTelemetry traces.
- Webhook events.
- JSONL request logs.

## 8. Provider Capabilities

### 8.1 Provider Types

Provider sources common to AI Agents:

- API Key Provider.
- Subscription Provider.
- Local Provider.

### 8.2 API Key Provider

Users can enter their own model API keys:

- OpenAI.
- Anthropic.
- Google Gemini.
- OpenRouter.
- DeepSeek.
- xAI.
- Qwen.
- Moonshot / Kimi.
- MiniMax.
- Z.ai.

DeepSeek, xAI, Qwen, Moonshot, MiniMax, Z.ai, and similar OpenAI-compatible
providers can use the generic OpenAI-compatible adapter through built-in
allowlisted provider templates. V1 does not allow arbitrary user-defined custom
endpoints.

### 8.3 Subscription Provider

LLMIngress may reuse existing personal subscriptions or token plans:

- ChatGPT Plus / Pro / Team.
- Claude Pro / Max.
- GitHub Copilot.
- Gemini / Google sign-in.
- Kimi Coding Plan.
- GLM Coding Plan.
- OpenCode Go.

Subscription Provider and OAuth access remain in V1 scope but are treated as
high-risk capabilities. They are only exposed through built-in allowlisted
provider templates and Console must clearly label ToS, account, and protocol
change risks. For consumer subscriptions such as ChatGPT Plus / Pro, Claude Pro
/ Max, and GitHub Copilot, if the provider does not allow API forwarding or the
protocol cannot be maintained reliably, the template should be disabled and the
user should use an official API Key Provider or Local Provider instead.

### 8.4 Local Provider

Local or self-hosted model services:

- Ollama.
- LM Studio.
- llama.cpp.

### 8.5 Provider Management

- Add Provider.
- Delete Provider.
- Enable or disable Provider.
- Refresh model list.
- View available models for the Provider.
- View recent provider connectivity.
- Store multiple keys for the same Provider.
- Set labels for keys.
- Adjust key priority.
- Show key prefix without showing the full secret.

Multiple keys for one Provider:

- A Provider can store multiple keys and automatically switch by priority.
  Failed keys are skipped.
- Smarter key allocation, such as quota-based or load-based distribution, is a
  future enhancement.

### 8.6 Provider Dependency Checks

When users disable or delete a Provider, Provider Key, or Model, the system must
check dependencies first.

Dependency scope:

- Referenced by any Virtual Model Name or Route Policy.
- Present in any Route Policy Fallback Chain.
- Referenced by fixed-model routing.
- Included in candidate model sets for cost-first, local-first, or
  quality-first strategies.

If dependencies exist, the system must block direct disablement or deletion and
show the affected Virtual Model Names or Route Policies and the Agents
currently allowed to use those Virtual Model Names.

## 9. Model Discovery And Model Library

### 9.1 Model Discovery

- Fetch model lists automatically after connecting a Provider.
- Support manual model refresh.
- Support local model synchronization.
- Support manually adding metadata for models under supported providers.
- Show unavailable-model warnings.

### 9.2 Model Metadata

Each model should show as much of the following as possible:

- Provider.
- Model ID.
- Display name.
- Context window.
- Input price.
- Output price.
- Streaming support.
- Tools support.
- Coding suitability.
- Reasoning suitability.
- Multimodal input support.

### 9.3 Model Pricing

- Display model prices.
- Mark free models.
- Mark local model cost as zero.
- Estimate Agent spend from prices.
- Use prices in routing recommendations.
- Support built-in pricing tables.
- Support user price overrides.
- Support price synchronization from providers or model registries.
- Models with unknown prices do not participate in cost-optimized routing unless
  the user manually confirms their price.

## 10. Virtual Model / Routing Capabilities

### 10.1 Virtual Model Name

Virtual Model Name is the model name that Agents send in requests and the
user-visible entry point for a Route Policy.

Each Virtual Model Name has:

- One Route Policy.
- Available provider scope.
- Available model scope.
- Cost preference: save money, balanced, or quality first.
- Task type rules.
- Complexity rules.
- Context length rules.
- Tool calling rules.
- Fallback Chain.
- Enabled state.

### 10.2 Agent And Virtual Model Permissions

- Each Agent can be authorized to use multiple Virtual Model Names.
- The Agent API key determines identity. Permissions, Budget, Limit, and usage
  attribution belong to the Agent.
- The request `model` field determines which Route Policy to use.
- If the Virtual Model Name does not exist, is disabled, or the current API key
  is not authorized to use it, Gateway must reject the request with a clear
  error.
- If the Agent does not specify `model`, Gateway may use the Agent's default
  Virtual Model Name.

### 10.3 Route Policy

Route Policy contains the real routing rules behind a Virtual Model Name.

Route Policy supports:

- Select model by task complexity.
- Select model by context length.
- Select model by tool calling requirements.
- Select model by task type such as coding, reasoning, long context, terminal,
  or shell.
- Select low-cost, local, or subscription-covered models by cost priority.
- Pin to a provider or model.
- Configure backup providers or models.
- Configure request timeout, retry, and fallback behavior.

Route Policy does not own Budget or Limit. Budget and Limit are configured on
the Agent.

### 10.4 Routing Decision Mechanism

V1 routing uses a deterministic rule engine and does not call an extra LLM
classifier by default. V2 may add an optional task classifier or judge, but it
must display the additional latency and cost.

Signals:

- Agent type.
- Agent.
- Virtual Model Name.
- Request protocol.
- Input token estimate.
- Tools or function calling.
- Repository, terminal, shell, diff, test log, and similar features.
- User-configured task hint.
- Fixed rules in the Route Policy.

Cost preference semantics:

- Save money: prefer the lowest-cost model that satisfies the request's basic
  requirements such as context length and tool calling support.
- Balanced: consider capability, price, latency, and health status together.
- Quality first: prefer higher-capability models and only downgrade when cost
  or budget constraints require it.

Routing behavior commitments:

- A user-pinned model always takes precedence over automatic routing.
- Automatic routing never selects a model that cannot satisfy request
  requirements, such as insufficient context length or missing tool support.
- Each routing result includes a user-readable selection reason.
- V1 routing is deterministic: the same request and configuration produce the
  same route.

### 10.5 Runtime Flow

1. Request enters Gateway.
2. Gateway identifies the Agent from the API key.
3. Gateway checks whether the Agent is enabled and whether Budget, Limit, or
   Rate Limit would be exceeded.
4. Gateway reads the request `model` field.
5. Gateway resolves the Virtual Model Name and Route Policy from `model`.
6. Gateway checks whether the Agent is allowed to use this Virtual Model Name.
7. Gateway executes the Route Policy and selects a real provider and model.
8. Gateway calls the real provider.
9. Gateway records usage for the Agent and records the Virtual Model Name,
   Route Policy, selected provider, selected model, tokens, cost, latency,
   fallback behavior, and failure reason for this request.
10. Gateway returns the provider response to the original AI Agent.

## 11. Fallback Capabilities

### 11.1 Fallback Chain

- Fallback Chain is part of the Route Policy.
- Each Virtual Model Name / Route Policy can have its own Fallback Chain.
- Fallbacks are attempted in order.
- Each chain should have at most 5 backup models.
- A chain can mix API Key Providers, Subscription Providers, and local models.
- The fallback process records the original failed provider/model, the final
  successful provider/model, and each failure reason.

### 11.2 Trigger Conditions

Fallback automatically switches to a backup model only when failure happens
before the first response chunk. If streaming breaks after the first chunk, V1
does not replay the request because the Agent may receive duplicate or
conflicting content. The interruption is fully recorded in Activity so the user
can see that the failure happened mid-response.

Fallback triggers:

- Provider 5xx.
- Provider 429.
- Provider timeout.
- Provider authentication failure.
- Model unavailable.
- Request rejected by provider.
- Streaming failure before the first chunk.

Not V1 automatic fallback:

- Poor answer quality.
- User dissatisfaction with the output.
- Streaming failure after partial content has already been produced.

### 11.3 User-Visible Result

- Show the original failed model.
- Show the final successful model.
- Show fallback count.
- Show each failure reason.
- Record fallback events in Activity.

## 12. Usage And Budget

Cost statistics prefer provider actual billing data. When actual data is not
available, LLMIngress uses estimates and clearly labels them in the UI.

### 12.1 Agent Usage Statistics

- Requests, tokens, cost, failure rate, and average latency by Agent.
- Budget and Limit usage by Agent.
- Prompt caching, cached input tokens, and reasoning tokens recorded separately.

### 12.2 Virtual Model / Provider / Model Statistics

- Requests, tokens, cost, failure rate, and average latency by Virtual Model
  Name / Route Policy.
- Cost by selected provider.
- Cost by selected model.
- Most-used models.
- Most-expensive models.
- Models with the most failures.

### 12.3 Budget Limits

- Set token limits for a single Agent.
- Set cost limits for a single Agent.
- Support hourly, daily, weekly, and monthly periods.
- Notify when thresholds are reached.
- Block requests when thresholds are reached.
- Manually reset or modify limits.
- Limit which Virtual Model Names an Agent may use.

### 12.4 Rate Limiting

In addition to Budget and Token Limit, Agents support RPM, TPM, and concurrency
limits.

- RPM: requests per minute.
- TPM: estimated token consumption per minute.
- Concurrency: concurrent requests for the same Agent.
- Return rate-limit errors when limits are exceeded.
- Rate Limit is for quickly stopping Agent loops. Budget controls cost ceiling.

### 12.5 Cost Savings

- Estimate savings from auto routing compared with a user-selected baseline
  model.
- If the user does not specify a baseline model, use the quality-first default
  model for the Virtual Model Name as baseline and clearly show the baseline
  model on the Usage page.
- Show saved amount.
- Show saved percentage.
- Show low-cost model hit ratio.
- Show savings by Agent and Virtual Model Name.

## 13. Activity / Logs

### 13.1 Request Logs

- View all Agent requests.
- Filter by Agent.
- Filter by Virtual Model Name / Route Policy.
- Filter by selected provider.
- Filter by selected model.
- Filter by status.
- Filter by time range.
- Filter by cost range.
- Filter by routing tier or route reason.

### 13.2 Request Details

Details page:

- Agent.
- Agent key prefix.
- Virtual Model Name.
- Route Policy.
- Selected provider.
- Selected model.
- Routing tier.
- Routing reason.
- Fallback information.
- Tokens.
- Cost.
- Latency.
- Status.
- Error message.
- Request metadata.
- Response metadata.

### 13.3 Content Recording

- Metadata-only recording can be the default.
- Users can choose whether to record prompt and response content.
- Content recording can be toggled by Agent.
- A single record can be deleted.
- Records for one Agent can be cleared in one action.

## 14. Console Pages And Features

### 14.1 Home

- Gateway status.
- Recent requests.
- Today's cost.
- Today's tokens.
- Active Agents.
- Provider health.

### 14.2 Agents Page

- Agent list.
- Create Agent.
- Agent connection status.
- Agent API key.
- Agent Allowed Virtual Model Names.
- Agent Budget / Limit.
- Agent onboarding instructions.
- Agent usage summary.
- Agent settings entry point.

### 14.3 Providers Page

- Provider list.
- Add Provider.
- Provider Key management.
- Local model status.
- Model list refresh.
- Provider connectivity test.

### 14.4 Virtual Models / Routes Page

- Global Virtual Model Name list.
- Create Virtual Model Name.
- Bind or edit Route Policy.
- Configure save-money, balanced, and quality-first strategies.
- Configure task type rules.
- Configure complexity rules.
- Configure context length rules.
- Configure tool calling rules.
- Configure available provider scope.
- Configure available model scope.
- Configure Fallback Chain.
- Model picker.
- Provider picker.
- View request volume, cost, selected models, and failure rate for the Virtual
  Model Name.
- Check Provider and Model dependencies.
- Disable or delete Virtual Model Name.

### 14.5 Usage Page

- Token chart.
- Cost chart.
- Agent cost breakdown.
- Virtual Model Name cost breakdown.
- Model cost breakdown.
- Provider cost breakdown.
- Savings summary.

### 14.6 Activity Page

- Request list.
- Request details.
- Fallback events.
- Error events.
- Recording management.

### 14.7 Limits Page

- Agent limit rules.
- Cost limits.
- Token limits.
- RPM / TPM limits.
- Concurrency limits.
- Allowed Virtual Model Names.
- Notification configuration.
- Blocking strategy.

V1 notification channels:

- Webhook.

Desktop notifications and local system notifications are not included in V1. If
needed later, they should be specified separately.

Alert events:

- Consecutive provider failures.
- Fallback Chain exhausted.
- Budget nearing threshold.
- Frequent Rate Limit triggers.

### 14.8 Playground Page

- Test prompts in the browser through Gateway Public API.
- The user manually pastes an Agent API key. The key is only held in page
  memory and is not stored or proxied by the Console backend.
- Call `GET /v1/models` with the user-entered Agent API key to show the Virtual
  Model Names authorized for that Agent.
- Select a Virtual Model Name as the request `model`.
- View model response, routing metadata, request id, cost, and token
  information.
- Compare outputs from different Virtual Model Names / Route Policies. Each
  test is a live request, creates real provider cost, and counts toward that
  Agent's Budget, Rate Limit, and Usage.

Because Agent API keys are stored only as hashes, Console cannot directly reuse
existing plaintext keys in Playground. The user must copy and save the key when
creating an Agent. Later Playground tests require pasting the key again. If the
key is lost or leaked, V1 gets a new key by deleting and recreating the Agent.

## 15. Deployment And Data

### 15.1 Gateway Deployment

- LLMIngress can run on a personal computer, local server, or cloud server.
- Personal computer deployments listen on localhost by default. Server
  deployments can explicitly bind to LAN or public addresses when needed.
- Public exposure is disabled by default.
- Custom ports are supported.
- Start-on-boot is supported.
- V1 assumes one active Gateway process handles requests. Multiple Gateway
  instances are a future extension.

Deployment shapes:

- Local / single-node: for a personal computer or local server. It listens on
  `127.0.0.1` by default and needs PostgreSQL.
- Docker / server: for a local server or cloud server. Public exposure is not
  enabled by default.
- Single binary: for lightweight self-hosting, but it still needs external
  PostgreSQL or a PostgreSQL sidecar managed by a supervisor or compose. It is
  not a zero-dependency single-file database shape.

Open-source licensing, commercial licensing, and distribution model are defined
separately in README / LICENSE. PRODUCT.md does not make those commitments by
default.

### 15.2 Data Storage

- Agent configuration.
- Agent API key prefix/hash/default Virtual Model.
- Agent Allowed Virtual Model Names and Budget / Limit.
- Provider configuration.
- Virtual Model Name / Route Policy configuration.
- Model cache.
- Request metadata.
- Optional request content.
- Statistics.

### 15.3 Data Export And Cleanup

- Export request records.
- Export cost reports.
- Export Provider / Model / Route Policy configuration.
- Import configuration backups.
- Automatically back up the configuration database before upgrades.
- Provide data migration.
- Support log retention period and log rotation.
- Clear logs.
- Clear prompt / response content while keeping metadata.
- Delete Agent data.
- Delete Provider credentials.

## 16. Security And Privacy

### 16.1 Credential Protection

- Provider API keys are encrypted at rest.
- Subscription tokens are encrypted at rest.
- Agent API keys are stored as hashes.
- Plaintext Agent API keys are shown only once when creating an Agent.
  Playground tests require the user to paste the plaintext key again.
- Dashboard does not show full Provider keys by default.
- V1 does not provide Agent key rotate, disable, or history.

### 16.2 User-Owned Control

- Configuration and logs are stored in the deployment environment chosen by the
  user.
- Local model requests do not leave the local or self-hosted model service
  configured by the user.
- Users can choose whether to record prompt / response.
- Request content is not uploaded by default.

### 16.3 Network Security

- Personal computer deployments listen only on `127.0.0.1` by default. Server
  deployments can explicitly configure the listen address.
- LAN or public access is allowed only after explicit user configuration.
- Console mutating requests require an `Origin` header that exactly matches the
  configured public Console origin. Reverse proxy deployments must set
  `CONSOLE_PUBLIC_BASE_URL`; forwarded headers are not trusted to infer it.
- Cloud provider requests are sent only to providers configured by the user.

### 16.4 Console Authentication

Console must support access control, especially for server or public
deployments.

- Local localhost mode may allow passwordless first-run setup.
- Non-localhost listeners must enable Console login.
- Admin password setup is supported.
- Public access can be disabled.
- Setup, login, logout, and authenticated Console API mutations use the same
  Origin guard. Safe methods such as GET and HEAD do not perform CSRF checks.
- All Provider Key, Subscription Token, and Agent credential operations require
  authentication.

## 17. Non-Functional Requirements And Success Metrics

### 17.1 Non-Functional Requirements

- V1 routing decisions do not call an extra LLM.
- Gateway rule-routing added latency target: p95 under 100 ms, excluding
  upstream provider latency.
- Streaming first-chunk proxy added latency target: p95 under 200 ms, excluding
  upstream provider first-chunk time.
- Configuration changes take near-real-time effect for new requests after
  Gateway hot reload succeeds and do not affect in-flight requests.
- Server deployments must support Console authentication.
- Prompt / response content is not recorded by default.

### 17.2 Success Metrics

- Time to connect first Agent.
- Request success rate.
- Fallback success rate.
- Fallback Chain exhaustion rate.
- Route Policy hit explanation coverage.
- Cost savings ratio compared with baseline model.
- Budget / Rate Limit block count.
- Provider average latency and failure rate.

### 17.3 Version Implementation Plan

The version implementation plan has moved to [`docs/ROADMAP.md`](ROADMAP.md).
It splits scope, deliverables, and acceptance criteria across MVP, V1, V2, and
V3.

## 18. Product Boundaries

LLMIngress is a single-user AI Agent Gateway. It focuses on solving personal
developers' ingress, routing, fallback, cost control, and observability problems
across multiple AI Agents, providers, and models.

Product focus:

- Let AI Agents access model capability through one unified endpoint.
- Manage multiple providers and models behind the Gateway.
- Automatically match suitable models from request parameters, context, task
  type, tool usage, and model capability.
- Provide fallback, usage statistics, cost control, Rate Limit, and request
  observability for AI Agents.
- Keep data and credentials user-owned.

Non-goals:

- Team collaboration or multi-tenant permission systems.
- Prompt management platform.
- Fine-tuning platform.
- Model training or model hosting platform.
- Custom Provider or arbitrary custom endpoint support.
- Default proxying for image, audio, or video generation endpoints.
- Bypassing provider ToS or anti-abuse restrictions.
- Guaranteeing every native capability of every commercial Agent through the
  Gateway endpoint. Support depends on each Agent's configurable endpoint
  capability.

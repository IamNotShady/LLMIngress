import {
  calculateTokenCostUsd,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import { cookies } from "next/headers";
import {
  type ConsoleActivity,
  formatConsoleActivityCost,
  formatConsoleActivityFallbackAttempts,
  formatConsoleActivityRouteReason,
  formatConsoleActivityTokens,
  listConsoleActivities,
} from "../server/activity";
import {
  formatAgentApiKeyVirtualModelAccess,
  listAgentApiKeyMetadata,
  listAgentApiKeyVirtualModelAccess,
} from "../server/agent-api-keys";
import {
  type ConsoleAgentLimit,
  formatAgentLimitSummaries,
  listAgentLimits,
} from "../server/agent-limits";
import { listAgents } from "../server/agents";
import { getConsoleDatabaseUrl, readConsoleAuthState, sessionCookieName } from "../server/auth";
import { getManualPriceOverride } from "../server/price-overrides";
import { listProviderApiKeyMetadata } from "../server/provider-keys";
import {
  listOllamaProviderTemplates,
  listOpenAICompatibleProviderTemplates,
} from "../server/provider-templates";
import { listProviders } from "../server/providers";
import {
  listProviderModelOptions,
  listRoutePolicies,
  routePolicyStrategies,
} from "../server/route-policies";
import {
  formatGatewayHeartbeatStatus,
  formatRuntimeErrorEntry,
  formatRuntimeReloadResult,
  getConsoleRuntimeSnapshot,
} from "../server/runtime";
import {
  type ConsoleUsageBreakdown,
  formatConsoleUsageCost,
  formatConsoleUsageTokens,
  getConsoleUsageSummary,
  parseConsoleUsageWindow,
} from "../server/usage";
import { listVirtualModels } from "../server/virtual-models";
import { Playground } from "./playground";

const previewProviderKey = "openai";
const previewModelId = "gpt-4.1-mini";
const providerTemplates = listOpenAICompatibleProviderTemplates();
const localProviderTemplates = listOllamaProviderTemplates();

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps = {}) {
  const cookieStore = await cookies();
  const databaseUrl = getConsoleDatabaseUrl();
  const authState = await readConsoleAuthState(
    databaseUrl,
    cookieStore.get(sessionCookieName)?.value,
  );

  if (authState === "setup") {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="setup-title">
          <p className="eyebrow">LLMIngress</p>
          <h1 id="setup-title">First run setup</h1>
          <form className="form" action="/api/auth/setup" method="post">
            <label htmlFor="setup-password">Admin password</label>
            <input
              id="setup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <button type="submit">Create admin</button>
          </form>
        </section>
      </main>
    );
  }

  if (authState === "login") {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="login-title">
          <p className="eyebrow">LLMIngress</p>
          <h1 id="login-title">Sign in</h1>
          <form className="form" action="/api/auth/login" method="post">
            <label htmlFor="login-password">Admin password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button type="submit">Sign in</button>
          </form>
        </section>
      </main>
    );
  }

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const selectedActivityId = readSingleSearchParam(resolvedSearchParams.activityId);
  const modelRefreshProviderId = readSingleSearchParam(resolvedSearchParams.modelRefreshProviderId);
  const usageWindow = parseConsoleUsageWindow(
    readSingleSearchParam(resolvedSearchParams.usageWindow),
  );
  const runtimeSnapshot = await getConsoleRuntimeSnapshot(databaseUrl);
  const usageSummary = await getConsoleUsageSummary({ databaseUrl, window: usageWindow });
  const activities = await listConsoleActivities(databaseUrl);
  const selectedActivity =
    activities.find((activity) => activity.id === selectedActivityId) ?? activities[0] ?? null;
  const pricePanel = await getPricePanel(databaseUrl);
  const playgroundGatewayBaseUrl = getPlaygroundGatewayBaseUrl();
  const agents = await listAgents(databaseUrl);
  const agentApiKeys = await listAgentApiKeyMetadata(databaseUrl);
  const agentApiKeyVirtualModelAccess = await listAgentApiKeyVirtualModelAccess(databaseUrl);
  const agentLimits = await listAgentLimits(databaseUrl);
  const providers = await listProviders(databaseUrl);
  const providerKeys = await listProviderApiKeyMetadata(databaseUrl);
  const virtualModels = await listVirtualModels(databaseUrl);
  const routePolicies = await listRoutePolicies(databaseUrl);
  const providerModelOptions = await listProviderModelOptions(databaseUrl);
  const providerKeyByProviderId = new Map(
    providerKeys.map((providerKey) => [providerKey.providerId, providerKey]),
  );
  const modelRefreshProvider = providers.find((provider) => provider.id === modelRefreshProviderId);
  const agentApiKeysByAgentId = groupByAgentId(agentApiKeys);
  const agentApiKeyVirtualModelAccessById = new Map(
    agentApiKeyVirtualModelAccess.map((access) => [access.agentApiKeyId, access]),
  );
  const agentLimitsByApiKeyId = groupByAgentApiKeyId(agentLimits);
  const routedVirtualModelIds = new Set(
    routePolicies.map((routePolicy) => routePolicy.virtualModelId),
  );
  const virtualModelsWithoutRoutePolicy = virtualModels.filter(
    (virtualModel) => !routedVirtualModelIds.has(virtualModel.id),
  );

  return (
    <main className="console-page">
      <header className="topbar">
        <div>
          <p className="eyebrow">LLMIngress</p>
          <h1>Dashboard</h1>
        </div>
        <form action="/api/auth/logout" method="post">
          <button className="secondary-button" type="submit">
            Sign out
          </button>
        </form>
      </header>
      <section className="status-band" aria-label="Console status">
        <p>Signed in as admin</p>
      </section>
      <Playground defaultGatewayBaseUrl={playgroundGatewayBaseUrl} />
      <section className="providers-panel" id="runtime" aria-labelledby="runtime-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Gateway</p>
            <h2 id="runtime-title">Runtime</h2>
          </div>
        </div>
        {runtimeSnapshot.gateways.length === 0 ? (
          <p>No gateway runtime status recorded.</p>
        ) : (
          <div className="runtime-grid">
            {runtimeSnapshot.gateways.map((gateway) => (
              <article className="runtime-item" key={gateway.gatewayInstanceId}>
                <h3>Gateway: {gateway.gatewayInstanceId}</h3>
                <p>
                  Heartbeat: {formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt })}
                </p>
                <p>Gateway status: {gateway.status}</p>
                <p>Applied config version: {formatConfigVersion(gateway.appliedConfigVersion)}</p>
                <p>Target config version: {formatConfigVersion(gateway.targetConfigVersion)}</p>
                <p>{formatRuntimeReloadResult(gateway)}</p>
                {gateway.lastReloadError && gateway.lastReloadStatus !== "failed" ? (
                  <p>Reload error: {gateway.lastReloadError}</p>
                ) : null}
                <p>Last heartbeat: {formatNullableDateTime(gateway.heartbeatAt)}</p>
              </article>
            ))}
          </div>
        )}
        <div className="runtime-errors">
          <h3>Recent runtime errors</h3>
          {runtimeSnapshot.errors.length === 0 ? (
            <p>No runtime errors recorded.</p>
          ) : (
            <ul>
              {runtimeSnapshot.errors.map((error) => (
                <li
                  key={`${error.processType}:${error.processId}:${error.errorCode}:${error.createdAt.toISOString()}`}
                >
                  {formatRuntimeErrorEntry(error)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className="providers-panel" id="usage" aria-labelledby="usage-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Usage</p>
            <h2 id="usage-title">Usage & Cost</h2>
          </div>
        </div>
        <form className="usage-window-form" action="/" method="get">
          <label htmlFor="usage-window">Usage window</label>
          <select id="usage-window" name="usageWindow" defaultValue={usageSummary.window}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <button type="submit">Apply usage window</button>
        </form>
        <dl className="usage-summary-grid">
          <div>
            <dt>Requests</dt>
            <dd>Requests: {usageSummary.requestCount}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{formatConsoleUsageTokens(usageSummary)}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>Cost: {formatConsoleUsageCost(usageSummary.totalCostUsd)}</dd>
          </div>
        </dl>
        <div className="usage-breakdown-list">
          {usageSummary.breakdowns.length === 0 ? (
            <p>No usage recorded for this window.</p>
          ) : (
            usageSummary.breakdowns.map((breakdown) => (
              <article
                className="usage-breakdown-item"
                key={`${breakdown.providerId}:${breakdown.modelId}`}
              >
                <h3>
                  {breakdown.providerLabel} / {breakdown.modelLabel}
                </h3>
                <p>{formatUsageBreakdownStats(breakdown)}</p>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="providers-panel" id="activity" aria-labelledby="activity-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Requests</p>
            <h2 id="activity-title">Activity</h2>
          </div>
        </div>
        {activities.length === 0 ? (
          <p>No activity recorded.</p>
        ) : (
          <div className="activity-layout">
            <nav className="activity-list" aria-label="Recent requests">
              {activities.map((activity) => (
                <a
                  className={
                    selectedActivity?.id === activity.id
                      ? "activity-list-item activity-list-item-selected"
                      : "activity-list-item"
                  }
                  href={`/?activityId=${encodeURIComponent(activity.id)}#activity`}
                  key={activity.id}
                >
                  <span className="activity-request-id">{activity.requestId}</span>
                  <span>{formatActivityListStatus(activity)}</span>
                  <span>{formatActivityModelSummary(activity)}</span>
                </a>
              ))}
            </nav>
            {selectedActivity ? (
              <article className="activity-detail" aria-labelledby="activity-detail-title">
                <h2 id="activity-detail-title">{selectedActivity.requestId}</h2>
                <p>Provider: {formatActivityProviderLabel(selectedActivity)}</p>
                <p>Model hit: {formatActivityModelHitLabel(selectedActivity)}</p>
                <p>{formatConsoleActivityTokens(selectedActivity)}</p>
                <p>Cost: {formatConsoleActivityCost(selectedActivity.totalCostUsd)}</p>
                <p>
                  Route reason: {formatConsoleActivityRouteReason(selectedActivity.routeReason)}
                </p>
                <p>Error code: {selectedActivity.errorCode ?? "None"}</p>
                <div className="activity-fallbacks">
                  <p>Fallback attempts</p>
                  <ul>
                    {formatConsoleActivityFallbackAttempts(selectedActivity.fallbackAttempts).map(
                      (attempt) => (
                        <li key={attempt}>{attempt}</li>
                      ),
                    )}
                  </ul>
                </div>
              </article>
            ) : null}
          </div>
        )}
      </section>
      <section className="providers-panel" aria-labelledby="virtual-models-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Virtual Models</p>
            <h2 id="virtual-models-title">Virtual model names</h2>
          </div>
        </div>
        <form className="provider-create-form" action="/api/virtual-models" method="post">
          <input type="hidden" name="action" value="create" />
          <label htmlFor="virtual-model-name">Virtual model name</label>
          <input id="virtual-model-name" name="name" required />
          <label htmlFor="virtual-model-display-name">Virtual model display name</label>
          <input id="virtual-model-display-name" name="displayName" required />
          <button type="submit">Create virtual model</button>
        </form>
        <div className="provider-list">
          {virtualModels.length === 0 ? (
            <p>No virtual models configured.</p>
          ) : (
            virtualModels.map((virtualModel) => (
              <article className="provider-item" key={virtualModel.id}>
                <header className="provider-header">
                  <div>
                    <p className="eyebrow">{virtualModel.name}</p>
                    <h2>{virtualModel.displayName}</h2>
                  </div>
                  <p className={virtualModel.enabled ? "status-enabled" : "status-disabled"}>
                    {virtualModel.enabled ? "Enabled" : "Disabled"}
                  </p>
                </header>
                <form className="provider-edit-form" action="/api/virtual-models" method="post">
                  <input type="hidden" name="action" value="update" />
                  <input type="hidden" name="id" value={virtualModel.id} />
                  <label htmlFor={`virtual-model-name-${virtualModel.id}`}>
                    Edit virtual model name
                  </label>
                  <input
                    id={`virtual-model-name-${virtualModel.id}`}
                    name="name"
                    defaultValue={virtualModel.name}
                    required
                  />
                  <label htmlFor={`virtual-model-display-${virtualModel.id}`}>
                    Edit virtual model display name
                  </label>
                  <input
                    id={`virtual-model-display-${virtualModel.id}`}
                    name="displayName"
                    defaultValue={virtualModel.displayName}
                    required
                  />
                  <button type="submit">Save virtual model</button>
                </form>
                <p>Route policies: {virtualModel.routePolicyCount}</p>
                <p>Default Agent API keys: {virtualModel.defaultApiKeyCount}</p>
                <p>Allowed Agent API keys: {virtualModel.allowedApiKeyCount}</p>
                <form action="/api/virtual-models" method="post">
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="id" value={virtualModel.id} />
                  <button className="secondary-button" type="submit">
                    Delete virtual model
                  </button>
                </form>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="providers-panel" aria-labelledby="route-policies-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Routes</p>
            <h2 id="route-policies-title">Route policies</h2>
          </div>
        </div>
        {virtualModelsWithoutRoutePolicy.length === 0 ? (
          <p>No Virtual Models without route policies.</p>
        ) : providerModelOptions.length === 0 ? (
          <p>No provider models available.</p>
        ) : (
          <form className="provider-create-form" action="/api/route-policies" method="post">
            <input type="hidden" name="action" value="create" />
            <label htmlFor="route-policy-virtual-model">Route policy virtual model</label>
            <select id="route-policy-virtual-model" name="virtualModelId" required defaultValue="">
              <option value="" disabled>
                Select virtual model
              </option>
              {virtualModelsWithoutRoutePolicy.map((virtualModel) => (
                <option key={virtualModel.id} value={virtualModel.id}>
                  {virtualModel.displayName} ({virtualModel.name})
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-strategy">Route policy strategy</label>
            <select id="route-policy-strategy" name="strategy" required defaultValue="balanced">
              {routePolicyStrategies.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {strategy}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-primary-models">Primary provider models</label>
            <select
              id="route-policy-primary-models"
              name="primaryProviderModelIds"
              multiple
              required
              size={providerModelSelectSize(providerModelOptions.length)}
            >
              {providerModelOptions.map((providerModel) => (
                <option key={providerModel.id} value={providerModel.id}>
                  {providerModel.optionLabel}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-fallback-models">Fallback provider models</label>
            <select
              id="route-policy-fallback-models"
              name="fallbackProviderModelIds"
              multiple
              size={providerModelSelectSize(providerModelOptions.length)}
            >
              {providerModelOptions.map((providerModel) => (
                <option key={providerModel.id} value={providerModel.id}>
                  {providerModel.optionLabel}
                </option>
              ))}
            </select>
            <button type="submit">Create route policy</button>
          </form>
        )}
        <div className="provider-list">
          {routePolicies.length === 0 ? (
            <p>No route policies configured.</p>
          ) : (
            routePolicies.map((routePolicy) => (
              <article className="provider-item" key={routePolicy.id}>
                <header className="provider-header">
                  <div>
                    <p className="eyebrow">{routePolicy.virtualModelName}</p>
                    <h2>Route policy</h2>
                  </div>
                  <p className="status-enabled">Enabled</p>
                </header>
                <p>
                  Virtual Model: {routePolicy.virtualModelDisplayName} (
                  {routePolicy.virtualModelName})
                </p>
                <p>Strategy: {routePolicy.strategy}</p>
                <p>Route reason: {routePolicy.routeReason}</p>
                {routePolicy.routeWarnings.map((warning) => (
                  <p className="route-warning" key={warning}>
                    {warning}
                  </p>
                ))}
                <p>Primary: {formatRoutePolicyCandidateList(routePolicy.primaryCandidates)}</p>
                <p>Fallback: {formatRoutePolicyCandidateList(routePolicy.fallbackCandidates)}</p>
                <form className="provider-edit-form" action="/api/route-policies" method="post">
                  <input type="hidden" name="action" value="update" />
                  <input type="hidden" name="id" value={routePolicy.id} />
                  <input type="hidden" name="virtualModelId" value={routePolicy.virtualModelId} />
                  <label htmlFor={`route-policy-strategy-${routePolicy.id}`}>
                    Edit route policy strategy
                  </label>
                  <select
                    id={`route-policy-strategy-${routePolicy.id}`}
                    name="strategy"
                    defaultValue={routePolicy.strategy}
                    required
                  >
                    {routePolicyStrategies.map((strategy) => (
                      <option key={strategy} value={strategy}>
                        {strategy}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`route-policy-primary-models-${routePolicy.id}`}>
                    Edit primary provider models
                  </label>
                  <select
                    id={`route-policy-primary-models-${routePolicy.id}`}
                    name="primaryProviderModelIds"
                    defaultValue={routePolicy.primaryCandidates.map((candidate) => candidate.id)}
                    multiple
                    required
                    size={providerModelSelectSize(providerModelOptions.length)}
                  >
                    {providerModelOptions.map((providerModel) => (
                      <option key={providerModel.id} value={providerModel.id}>
                        {providerModel.optionLabel}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`route-policy-fallback-models-${routePolicy.id}`}>
                    Edit fallback provider models
                  </label>
                  <select
                    id={`route-policy-fallback-models-${routePolicy.id}`}
                    name="fallbackProviderModelIds"
                    defaultValue={routePolicy.fallbackCandidates.map((candidate) => candidate.id)}
                    multiple
                    size={providerModelSelectSize(providerModelOptions.length)}
                  >
                    {providerModelOptions.map((providerModel) => (
                      <option key={providerModel.id} value={providerModel.id}>
                        {providerModel.optionLabel}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Save route policy</button>
                </form>
                <form action="/api/route-policies" method="post">
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="id" value={routePolicy.id} />
                  <button className="secondary-button" type="submit">
                    Delete route policy
                  </button>
                </form>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="providers-panel" aria-labelledby="agents-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Agents</p>
            <h2 id="agents-title">Agent configurations</h2>
          </div>
        </div>
        <form className="provider-create-form" action="/api/agents" method="post">
          <input type="hidden" name="action" value="create" />
          <label htmlFor="agent-name">Agent name</label>
          <input id="agent-name" name="name" required />
          <label htmlFor="agent-type">Agent type</label>
          <select id="agent-type" name="agentType" required defaultValue="coding">
            <option value="coding">coding</option>
            <option value="desktop">desktop</option>
            <option value="terminal">terminal</option>
            <option value="ide">ide</option>
            <option value="other">other</option>
          </select>
          <button type="submit">Create agent</button>
        </form>
        <div className="provider-list">
          {agents.length === 0 ? (
            <p>No agents configured.</p>
          ) : (
            agents.map((agent) => (
              <article className="provider-item" key={agent.id}>
                <header className="provider-header">
                  <div>
                    <p className="eyebrow">Type: {agent.agentType}</p>
                    <h2>{agent.name}</h2>
                  </div>
                  <p className={agent.enabled ? "status-enabled" : "status-disabled"}>
                    {agent.enabled ? "Enabled" : "Disabled"}
                  </p>
                </header>
                <form className="provider-edit-form" action="/api/agents" method="post">
                  <input type="hidden" name="action" value="update" />
                  <input type="hidden" name="id" value={agent.id} />
                  <label htmlFor={`agent-name-${agent.id}`}>Edit agent name</label>
                  <input
                    id={`agent-name-${agent.id}`}
                    name="name"
                    defaultValue={agent.name}
                    required
                  />
                  <label htmlFor={`agent-type-${agent.id}`}>Edit agent type</label>
                  <select
                    id={`agent-type-${agent.id}`}
                    name="agentType"
                    defaultValue={agent.agentType}
                    required
                  >
                    <option value="coding">coding</option>
                    <option value="desktop">desktop</option>
                    <option value="terminal">terminal</option>
                    <option value="ide">ide</option>
                    <option value="other">other</option>
                  </select>
                  <button type="submit">Save agent</button>
                </form>
                <p>Active API keys: {agent.activeApiKeyCount}</p>
                <p>Request attribution records: {agent.requestAttributionCount}</p>
                <div className="provider-key-metadata">
                  {(agentApiKeysByAgentId.get(agent.id) ?? []).length === 0 ? (
                    <p>No Agent API keys saved.</p>
                  ) : (
                    (agentApiKeysByAgentId.get(agent.id) ?? []).map((agentApiKey) => {
                      const access = agentApiKeyVirtualModelAccessById.get(agentApiKey.id) ?? {
                        agentApiKeyId: agentApiKey.id,
                        allowedVirtualModels: [],
                        defaultVirtualModel: null,
                      };
                      const accessLabels = formatAgentApiKeyVirtualModelAccess(access);
                      const limits = agentLimitsByApiKeyId.get(agentApiKey.id) ?? [];
                      const limitSummaries = formatAgentLimitSummaries(limits);
                      const budgetLimit = findAgentLimit(limits, "budget");
                      const rpmLimit = findAgentLimit(limits, "rpm");
                      const tokenLimit = findAgentLimit(limits, "token");
                      const tpmLimit = findAgentLimit(limits, "tpm");

                      return (
                        <div key={agentApiKey.id}>
                          <p>Agent API key prefix: {agentApiKey.keyPrefix}</p>
                          <p>
                            Agent API key status: {agentApiKey.enabled ? "Enabled" : "Disabled"}
                          </p>
                          <p>Agent API key created: {formatDateTime(agentApiKey.createdAt)}</p>
                          <p>Agent API key updated: {formatDateTime(agentApiKey.updatedAt)}</p>
                          <p>Allowed Virtual Models: {accessLabels.allowedLabel}</p>
                          <p>Default Virtual Model: {accessLabels.defaultLabel}</p>
                          <form
                            className="provider-edit-form"
                            action="/api/agent-api-keys"
                            method="post"
                          >
                            <input type="hidden" name="action" value="updateVirtualModelAccess" />
                            <input type="hidden" name="id" value={agentApiKey.id} />
                            <label htmlFor={`agent-key-allowed-virtual-models-${agentApiKey.id}`}>
                              Allowed virtual models
                            </label>
                            <select
                              id={`agent-key-allowed-virtual-models-${agentApiKey.id}`}
                              name="allowedVirtualModelIds"
                              defaultValue={access.allowedVirtualModels.map(
                                (virtualModel) => virtualModel.id,
                              )}
                              multiple
                              size={virtualModelSelectSize(virtualModels.length)}
                            >
                              {virtualModels.map((virtualModel) => (
                                <option key={virtualModel.id} value={virtualModel.id}>
                                  {formatVirtualModelOptionLabel(virtualModel)}
                                </option>
                              ))}
                            </select>
                            <label htmlFor={`agent-key-default-virtual-model-${agentApiKey.id}`}>
                              Default virtual model
                            </label>
                            <select
                              id={`agent-key-default-virtual-model-${agentApiKey.id}`}
                              name="defaultVirtualModelId"
                              defaultValue={access.defaultVirtualModel?.id ?? ""}
                            >
                              <option value="">No default virtual model</option>
                              {virtualModels.map((virtualModel) => (
                                <option key={virtualModel.id} value={virtualModel.id}>
                                  {formatVirtualModelOptionLabel(virtualModel)}
                                </option>
                              ))}
                            </select>
                            <button type="submit">Save Agent API key virtual models</button>
                          </form>
                          <p>Budget Limit: {limitSummaries.budget}</p>
                          <p>RPM Limit: {limitSummaries.rpm}</p>
                          <p>TPM Limit: {limitSummaries.tpm}</p>
                          <p>Token Limit: {limitSummaries.token}</p>
                          <form
                            className="provider-edit-form"
                            action="/api/agent-limits"
                            method="post"
                          >
                            <input type="hidden" name="action" value="saveLimitRules" />
                            <input type="hidden" name="agentApiKeyId" value={agentApiKey.id} />
                            <label htmlFor={`agent-key-budget-usd-${agentApiKey.id}`}>
                              Budget USD limit
                            </label>
                            <input
                              id={`agent-key-budget-usd-${agentApiKey.id}`}
                              name="budgetUsd"
                              type="number"
                              min="0.000001"
                              step="0.000001"
                              defaultValue={budgetLimit?.limitValue ?? 10}
                              required
                            />
                            <label htmlFor={`agent-key-budget-period-${agentApiKey.id}`}>
                              Budget period
                            </label>
                            <select
                              id={`agent-key-budget-period-${agentApiKey.id}`}
                              name="budgetPeriod"
                              defaultValue={budgetLimit?.period ?? "month"}
                              required
                            >
                              <option value="day">day</option>
                              <option value="week">week</option>
                              <option value="month">month</option>
                            </select>
                            <label htmlFor={`agent-key-budget-provider-${agentApiKey.id}`}>
                              Budget price provider key
                            </label>
                            <input
                              id={`agent-key-budget-provider-${agentApiKey.id}`}
                              name="budgetPriceProviderKey"
                              defaultValue="openai"
                              required
                            />
                            <label htmlFor={`agent-key-budget-model-${agentApiKey.id}`}>
                              Budget price model id
                            </label>
                            <input
                              id={`agent-key-budget-model-${agentApiKey.id}`}
                              name="budgetPriceModelId"
                              defaultValue="gpt-4.1-mini"
                              required
                            />
                            <label htmlFor={`agent-key-rpm-${agentApiKey.id}`}>RPM limit</label>
                            <input
                              id={`agent-key-rpm-${agentApiKey.id}`}
                              name="rpm"
                              type="number"
                              min="1"
                              step="1"
                              defaultValue={rpmLimit?.limitValue ?? 60}
                              required
                            />
                            <label htmlFor={`agent-key-tpm-${agentApiKey.id}`}>TPM limit</label>
                            <input
                              id={`agent-key-tpm-${agentApiKey.id}`}
                              name="tpm"
                              type="number"
                              min="1"
                              step="1"
                              defaultValue={tpmLimit?.limitValue ?? 120000}
                              required
                            />
                            <label htmlFor={`agent-key-token-limit-${agentApiKey.id}`}>
                              Token limit
                            </label>
                            <input
                              id={`agent-key-token-limit-${agentApiKey.id}`}
                              name="tokenLimit"
                              type="number"
                              min="1"
                              step="1"
                              defaultValue={tokenLimit?.limitValue ?? 8000}
                              required
                            />
                            <button type="submit">Save Agent API key limits</button>
                          </form>
                          <form action="/api/agent-api-keys" method="post">
                            <input type="hidden" name="action" value="rotate" />
                            <input type="hidden" name="id" value={agentApiKey.id} />
                            <button type="submit">Rotate Agent API key</button>
                          </form>
                          {agentApiKey.enabled ? (
                            <form action="/api/agent-api-keys" method="post">
                              <input type="hidden" name="action" value="disable" />
                              <input type="hidden" name="id" value={agentApiKey.id} />
                              <button className="secondary-button" type="submit">
                                Disable Agent API key
                              </button>
                            </form>
                          ) : null}
                          <form action="/api/agent-api-keys" method="post">
                            <input type="hidden" name="action" value="delete" />
                            <input type="hidden" name="id" value={agentApiKey.id} />
                            <button className="secondary-button" type="submit">
                              Delete Agent API key
                            </button>
                          </form>
                        </div>
                      );
                    })
                  )}
                </div>
                <form className="provider-key-form" action="/api/agent-api-keys" method="post">
                  <input type="hidden" name="action" value="create" />
                  <input type="hidden" name="agentId" value={agent.id} />
                  <button type="submit">Create Agent API key</button>
                </form>
                <form action="/api/agents" method="post">
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="id" value={agent.id} />
                  <button className="secondary-button" type="submit">
                    Delete agent
                  </button>
                </form>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="price-panel" aria-labelledby="price-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Prices</p>
            <h2 id="price-title">{previewModelId}</h2>
          </div>
          <p className="price-source">{pricePanel.sourceLabel}</p>
        </div>
        <dl className="price-grid">
          <div>
            <dt>Input</dt>
            <dd>{pricePanel.inputPriceLabel}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{pricePanel.outputPriceLabel}</dd>
          </div>
          <div>
            <dt>Estimate</dt>
            <dd>{pricePanel.estimateLabel}</dd>
          </div>
        </dl>
        <form className="price-form" action="/api/prices/override" method="post">
          <input type="hidden" name="providerKey" value={previewProviderKey} />
          <input type="hidden" name="modelId" value={previewModelId} />
          <label htmlFor="override-input-price">Override input price</label>
          <input
            id="override-input-price"
            name="inputUsdPerMillionTokens"
            type="number"
            min="0"
            step="0.00000001"
            defaultValue={pricePanel.inputPriceValue}
            required
          />
          <label htmlFor="override-output-price">Override output price</label>
          <input
            id="override-output-price"
            name="outputUsdPerMillionTokens"
            type="number"
            min="0"
            step="0.00000001"
            defaultValue={pricePanel.outputPriceValue}
            required
          />
          <button type="submit">Save price override</button>
        </form>
      </section>
      <section className="providers-panel" aria-labelledby="providers-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Providers</p>
            <h2 id="providers-title">Provider configurations</h2>
          </div>
        </div>
        <form className="provider-create-form" action="/api/providers" method="post">
          <input type="hidden" name="action" value="create" />
          <input type="hidden" name="providerType" value="api_key" />
          <label htmlFor="provider-key">Provider key</label>
          <input id="provider-key" name="providerKey" required />
          <label htmlFor="provider-display-name">Provider display name</label>
          <input id="provider-display-name" name="displayName" required />
          <label htmlFor="provider-base-url">Provider base URL</label>
          <input id="provider-base-url" name="baseUrl" type="url" />
          <button type="submit">Create provider</button>
        </form>
        <form className="provider-template-form" action="/api/providers" method="post">
          <input type="hidden" name="action" value="createFromTemplate" />
          <label htmlFor="provider-template">Provider template</label>
          <select id="provider-template" name="templateId" required>
            {providerTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.displayName}
              </option>
            ))}
          </select>
          <button type="submit">Add template provider</button>
        </form>
        {localProviderTemplates.map((template) => (
          <form
            className="provider-template-form local-provider-template-form"
            action="/api/providers"
            method="post"
            key={template.id}
          >
            <input type="hidden" name="action" value="createFromTemplate" />
            <input type="hidden" name="templateId" value={template.id} />
            <label htmlFor={`${template.id}-base-url`}>{template.displayName} base URL</label>
            <input
              id={`${template.id}-base-url`}
              name="baseUrl"
              type="url"
              placeholder="http://127.0.0.1:11434"
              required
            />
            <label className="checkbox-label" htmlFor={`${template.id}-public-risk`}>
              <input
                id={`${template.id}-public-risk`}
                name="publicNetworkRiskAccepted"
                type="checkbox"
                value="true"
              />
              Accept public network risk
            </label>
            <button type="submit">Add local provider</button>
          </form>
        ))}
        {modelRefreshProvider ? (
          <p role="status">Model refresh queued for {modelRefreshProvider.displayName}.</p>
        ) : null}
        <div className="provider-list">
          {providers.length === 0 ? (
            <p>No providers configured.</p>
          ) : (
            providers.map((provider) => {
              const providerKeyMetadata = providerKeyByProviderId.get(provider.id);

              return (
                <article className="provider-item" key={provider.id}>
                  <header className="provider-header">
                    <div>
                      <p className="eyebrow">{provider.providerKey}</p>
                      <h2>{provider.displayName}</h2>
                    </div>
                    <p className={provider.enabled ? "status-enabled" : "status-disabled"}>
                      {provider.enabled ? "Enabled" : "Disabled"}
                    </p>
                  </header>
                  <form className="provider-edit-form" action="/api/providers" method="post">
                    <input type="hidden" name="action" value="update" />
                    <input type="hidden" name="id" value={provider.id} />
                    <label htmlFor={`provider-display-${provider.id}`}>
                      Edit provider display name
                    </label>
                    <input
                      id={`provider-display-${provider.id}`}
                      name="displayName"
                      defaultValue={provider.displayName}
                      required
                    />
                    {provider.providerTemplateId ? (
                      <p>Template provider base URL: {provider.baseUrl}</p>
                    ) : (
                      <>
                        <label htmlFor={`provider-base-${provider.id}`}>
                          Edit provider base URL
                        </label>
                        <input
                          id={`provider-base-${provider.id}`}
                          name="baseUrl"
                          type="url"
                          defaultValue={provider.baseUrl ?? ""}
                        />
                      </>
                    )}
                    <button type="submit">Save provider</button>
                  </form>
                  <div className="provider-key-metadata">
                    {providerKeyMetadata ? (
                      <>
                        <p>Provider API key prefix: {providerKeyMetadata.keyPrefix}</p>
                        <p>
                          Provider API key created: {formatDateTime(providerKeyMetadata.createdAt)}
                        </p>
                        {providerKeyMetadata.rotatedAt ? (
                          <p>
                            Provider API key rotated:{" "}
                            {formatDateTime(providerKeyMetadata.rotatedAt)}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p>No Provider API key saved.</p>
                    )}
                  </div>
                  <form className="provider-key-form" action="/api/provider-keys" method="post">
                    <input type="hidden" name="providerId" value={provider.id} />
                    <label htmlFor={`provider-api-key-${provider.id}`}>Provider API key</label>
                    <input
                      id={`provider-api-key-${provider.id}`}
                      name="providerApiKey"
                      type="password"
                      autoComplete="off"
                      required
                    />
                    <button type="submit">
                      {providerKeyMetadata ? "Rotate provider API key" : "Store provider API key"}
                    </button>
                  </form>
                  <form action="/api/providers" method="post">
                    <input type="hidden" name="id" value={provider.id} />
                    <input
                      type="hidden"
                      name="action"
                      value={provider.enabled ? "disable" : "enable"}
                    />
                    <button className="secondary-button" type="submit">
                      {provider.enabled ? "Disable provider" : "Enable provider"}
                    </button>
                  </form>
                  <form action="/api/provider-model-refresh" method="post">
                    <input type="hidden" name="providerId" value={provider.id} />
                    <button className="secondary-button" disabled={!provider.enabled} type="submit">
                      Refresh provider models
                    </button>
                  </form>
                </article>
              );
            })
          )}
        </div>
      </section>
    </main>
  );
}

async function getPricePanel(databaseUrl: string) {
  const manualOverride = await getManualPriceOverride({
    databaseUrl,
    modelId: previewModelId,
    providerKey: previewProviderKey,
  });
  const price = resolveEffectiveModelTokenPrice({
    manualOverride,
    modelId: previewModelId,
    providerKey: previewProviderKey,
  });

  if (price.status === "unknown_price") {
    return {
      estimateLabel: "Sample estimate: unavailable",
      inputPriceLabel: "Unknown input price",
      inputPriceValue: "",
      outputPriceLabel: "Unknown output price",
      outputPriceValue: "",
      sourceLabel: "Unknown price",
    };
  }

  const estimate = calculateTokenCostUsd(price, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  const totalCost = estimate.status === "estimated" ? estimate.totalCostUsd : 0;

  return {
    estimateLabel: `Sample estimate: ${formatUsd(totalCost)}`,
    inputPriceLabel: `${formatUsd(price.inputUsdPerMillionTokens)} / 1M input`,
    inputPriceValue: String(price.inputUsdPerMillionTokens),
    outputPriceLabel: `${formatUsd(price.outputUsdPerMillionTokens)} / 1M output`,
    outputPriceValue: String(price.outputUsdPerMillionTokens),
    sourceLabel: price.source === "manual_override" ? "Manual override" : "Built-in price",
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function getPlaygroundGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

function formatDateTime(value: Date): string {
  return value.toISOString();
}

function formatNullableDateTime(value: Date | null): string {
  return value ? formatDateTime(value) : "Unknown";
}

function formatConfigVersion(value: number | null): string {
  return value === null ? "None" : `v${value}`;
}

function readSingleSearchParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function formatActivityListStatus(activity: ConsoleActivity): string {
  return `${activity.protocol} - ${activity.status} - ${activity.httpStatus ?? "no status"}`;
}

function formatActivityProviderLabel(activity: ConsoleActivity): string {
  return activity.providerDisplayName ?? activity.providerKey ?? "Unknown provider";
}

function formatActivityModelSummary(activity: ConsoleActivity): string {
  return activity.providerModelName ?? activity.model ?? "Unknown model";
}

function formatActivityModelHitLabel(activity: ConsoleActivity): string {
  const displayName = activity.providerModelDisplayName ?? "Unknown model";
  const modelName = activity.providerModelName ?? activity.providerModelId ?? "unknown";
  return `${displayName} (${modelName})`;
}

function formatUsageBreakdownStats(breakdown: ConsoleUsageBreakdown): string {
  const requestLabel = breakdown.requestCount === 1 ? "request" : "requests";
  return `${breakdown.requestCount} ${requestLabel} - ${breakdown.totalTokens} tokens - ${formatConsoleUsageCost(breakdown.totalCostUsd)}`;
}

function formatRoutePolicyCandidateList(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate) => candidate.optionLabel).join(", ");
}

function providerModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
}

function virtualModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
}

function formatVirtualModelOptionLabel(virtualModel: {
  displayName: string;
  name: string;
}): string {
  return `${virtualModel.displayName} (${virtualModel.name})`;
}

function findAgentLimit(
  limits: readonly ConsoleAgentLimit[],
  limitType: ConsoleAgentLimit["limitType"],
): ConsoleAgentLimit | undefined {
  return limits.find((limit) => limit.limitType === limitType);
}

function groupByAgentApiKeyId<T extends { agentApiKeyId: string }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = grouped.get(value.agentApiKeyId) ?? [];
    group.push(value);
    grouped.set(value.agentApiKeyId, group);
  }
  return grouped;
}

function groupByAgentId<T extends { agentId: string }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = grouped.get(value.agentId) ?? [];
    group.push(value);
    grouped.set(value.agentId, group);
  }
  return grouped;
}

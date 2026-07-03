"use client";

import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProviderOAuthConnection } from "@llmingress/db/console-provider-oauth";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ConsoleProviderModelOption } from "@llmingress/db/console-route-policies";
import { useEffect, useMemo, useState } from "react";
import { FlatIcon } from "../_components/flat-icon";
import { buildQueryHref, type ConsoleSearchParams } from "../_lib/pagination";

export function ProvidersClientSection({
  initialSelectedProviderId,
  providerHealthSummaries,
  providerKeys,
  providerModelOptions,
  providerOAuthConnections,
  providers,
  searchParams,
}: {
  initialSelectedProviderId?: string;
  providerHealthSummaries: ConsoleProviderHealthSummary[];
  providerKeys: ProviderApiKeyMetadata[];
  providerModelOptions: ConsoleProviderModelOption[];
  providerOAuthConnections: ConsoleProviderOAuthConnection[];
  providers: ConsoleProvider[];
  searchParams: ConsoleSearchParams;
}) {
  const providerHealthByProviderId = useMemo(
    () => new Map(providerHealthSummaries.map((summary) => [summary.id, summary])),
    [providerHealthSummaries],
  );
  const providerKeysByProviderId = useMemo(
    () => groupProviderKeysByProviderId(providerKeys),
    [providerKeys],
  );
  const providerOAuthByProviderId = useMemo(
    () => groupProviderOAuthByProviderId(providerOAuthConnections),
    [providerOAuthConnections],
  );
  const providerModelsByProviderId = useMemo(
    () => groupProviderModelsByProviderId(providerModelOptions),
    [providerModelOptions],
  );
  const initialProvider =
    providers.find((provider) => provider.id === initialSelectedProviderId) ??
    providers.find((provider) => provider.providerKey === "openai") ??
    providers[0] ??
    null;
  const initialProviderId = initialProvider?.id ?? null;
  const [selectedProviderId, setSelectedProviderId] = useState(initialProviderId);
  useEffect(() => {
    setSelectedProviderId(initialProviderId);
  }, [initialProviderId]);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ?? initialProvider;
  const selectedProviderHealth = selectedProvider
    ? providerHealthByProviderId.get(selectedProvider.id)
    : undefined;
  const selectedProviderKeys = selectedProvider
    ? (providerKeysByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const selectedProviderOAuthConnections = selectedProvider
    ? (providerOAuthByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const selectedProviderCredentialCount =
    selectedProvider?.providerType === "local"
      ? 1
      : selectedProvider?.providerType === "subscription"
        ? selectedProviderOAuthConnections.length
        : selectedProviderKeys.length;
  const selectedProviderModels = selectedProvider
    ? (providerModelsByProviderId.get(selectedProvider.id) ?? [])
    : [];

  return (
    <>
      <div className="providers-content-grid">
        <div className="providers-main-column">
          <div className="chart-card providers-list-card">
            <h2 className="chart-card-title">Provider list</h2>
            {providers.length === 0 ? (
              <p>No providers configured.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table providers-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Type</th>
                      <th className="num">Keys</th>
                      <th className="num">Models</th>
                      <th>Last connected</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((provider) => {
                      const providerHealth = providerHealthByProviderId.get(provider.id);
                      const providerModels = providerModelsByProviderId.get(provider.id) ?? [];
                      const providerKeyCount = readProviderCredentialCount(
                        provider,
                        providerKeysByProviderId,
                        providerOAuthByProviderId,
                      );

                      return (
                        <tr
                          className={
                            provider.id === selectedProvider?.id ? "is-selected" : "is-clickable"
                          }
                          key={provider.id}
                        >
                          <td>
                            <button
                              className="table-row-link"
                              type="button"
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              <strong>{provider.displayName}</strong>
                            </button>
                          </td>
                          <td>
                            <button
                              className="table-row-link"
                              type="button"
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              <ProviderHealthDetailPill
                                status={
                                  provider.enabled
                                    ? (providerHealth?.status ?? "unknown")
                                    : "disabled"
                                }
                              />
                            </button>
                          </td>
                          <td>
                            <button
                              className="table-row-link"
                              type="button"
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              {formatProviderType(provider)}
                            </button>
                          </td>
                          <td className="num">
                            <button
                              className="table-row-link"
                              type="button"
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              {providerKeyCount}
                            </button>
                          </td>
                          <td className="num">
                            <button
                              className="table-row-link"
                              type="button"
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              {providerModels.length}
                            </button>
                          </td>
                          <td>
                            <button
                              className="table-row-link"
                              type="button"
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              {formatProviderLastConnection(providerHealth)}
                            </button>
                          </td>
                          <td>
                            <span className="provider-table-actions">
                              {provider.enabled ? (
                                <>
                                  <a
                                    className="provider-action-button provider-action-edit"
                                    href={buildQueryHref(searchParams, {
                                      providerDialog: provider.id,
                                      selected: provider.id,
                                    })}
                                    aria-label={`Edit ${provider.displayName}`}
                                    title="Edit"
                                  >
                                    <FlatIcon name="edit" />
                                  </a>
                                  <form action="/api/providers" method="post">
                                    <input type="hidden" name="action" value="disable" />
                                    <input type="hidden" name="id" value={provider.id} />
                                    <button
                                      className="provider-action-button provider-action-delete"
                                      aria-label={`Disable ${provider.displayName}`}
                                      title="Disable"
                                      type="submit"
                                    >
                                      <FlatIcon name="disable" />
                                    </button>
                                  </form>
                                  <a
                                    className="provider-action-button provider-action-delete"
                                    href={buildQueryHref(searchParams, {
                                      providerDelete: provider.id,
                                      selected: provider.id,
                                    })}
                                    aria-label={`Delete ${provider.displayName}`}
                                    title="Delete"
                                  >
                                    <FlatIcon name="delete" />
                                  </a>
                                </>
                              ) : (
                                <>
                                  <form action="/api/providers" method="post">
                                    <input type="hidden" name="action" value="enable" />
                                    <input type="hidden" name="id" value={provider.id} />
                                    <button
                                      className="provider-action-button provider-action-enable"
                                      aria-label={`Enable ${provider.displayName}`}
                                      title="Enable"
                                      type="submit"
                                    >
                                      <FlatIcon name="enable" />
                                    </button>
                                  </form>
                                  <a
                                    className="provider-action-button provider-action-delete"
                                    href={buildQueryHref(searchParams, {
                                      providerDelete: provider.id,
                                      selected: provider.id,
                                    })}
                                    aria-label={`Delete ${provider.displayName}`}
                                    title="Delete"
                                  >
                                    <FlatIcon name="delete" />
                                  </a>
                                </>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <aside className="provider-detail-card" aria-label="Selected provider details">
          {selectedProvider ? (
            <>
              <header className="provider-detail-head">
                <div>
                  <h2>Provider details - {selectedProvider.displayName}</h2>
                </div>
                <form
                  className="provider-refresh-form"
                  action="/api/provider-model-refresh"
                  method="post"
                >
                  <input type="hidden" name="providerId" value={selectedProvider.id} />
                  <button
                    className="provider-refresh-button"
                    disabled={selectedProviderCredentialCount === 0}
                    aria-label="Refresh models"
                    title="Refresh models"
                    type="submit"
                  >
                    <FlatIcon name="refresh" />
                  </button>
                  {selectedProviderCredentialCount === 0 ? (
                    <p className="field-error is-visible">
                      {selectedProvider.providerType === "subscription"
                        ? "Add an OAuth connection first"
                        : "Add an API key first"}
                    </p>
                  ) : null}
                </form>
              </header>

              <dl className="provider-detail-stats">
                <div>
                  <dt>Status</dt>
                  <dd>
                    {formatProviderHealthStatusLabel(
                      selectedProvider.enabled
                        ? (selectedProviderHealth?.status ?? "unknown")
                        : "disabled",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Available models</dt>
                  <dd>{selectedProviderModels.length}</dd>
                </div>
                <div>
                  <dt>Last connected</dt>
                  <dd>{formatProviderLastConnection(selectedProviderHealth)}</dd>
                </div>
              </dl>

              <section className="provider-detail-section">
                <div className="provider-detail-section-head">
                  <h3>
                    {selectedProvider.providerType === "subscription"
                      ? "OAuth connections"
                      : selectedProvider.providerType === "local"
                        ? "Local connection"
                        : "API keys"}
                  </h3>
                  {selectedProvider.providerType === "subscription" ? (
                    <form
                      action="/api/provider-oauth"
                      className="provider-oauth-add-form"
                      method="post"
                    >
                      <input type="hidden" name="action" value="start" />
                      <input type="hidden" name="providerId" value={selectedProvider.id} />
                      <input type="hidden" name="priority" value="100" />
                      <button
                        aria-label="Add OAuth connection"
                        className="provider-key-add-button"
                        title="Add OAuth connection"
                        type="submit"
                      >
                        <FlatIcon name="key" />
                      </button>
                    </form>
                  ) : selectedProvider.providerType === "local" ? null : (
                    <a
                      className="provider-key-add-button"
                      href={buildQueryHref(searchParams, {
                        providerKeyDialog: selectedProvider.id,
                        selected: selectedProvider.id,
                      })}
                      aria-label="Add API key"
                      title="Add API key"
                    >
                      <FlatIcon name="key" />
                    </a>
                  )}
                </div>
                {selectedProvider.providerType === "local" ? (
                  <p>Local providers do not require API keys.</p>
                ) : (
                  <div className="data-table-wrap">
                    <table className="data-table provider-key-table">
                      <thead>
                        <tr>
                          <th>Label</th>
                          <th>Priority</th>
                          <th>Status</th>
                          <th>Last tested</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedProvider.providerType === "subscription" ? (
                          selectedProviderOAuthConnections.length === 0 ? (
                            <tr>
                              <td colSpan={5}>No OAuth connection stored.</td>
                            </tr>
                          ) : (
                            selectedProviderOAuthConnections.map((connection) => (
                              <tr key={connection.id}>
                                <td>{connection.label ?? "-"}</td>
                                <td>{connection.priority}</td>
                                <td>
                                  <ProviderOAuthTestStatusPill status={connection.lastTestStatus} />
                                </td>
                                <td>{formatProviderOAuthLastTest(connection)}</td>
                                <td>
                                  <span className="provider-table-actions">
                                    <form action="/api/provider-oauth" method="post">
                                      <input
                                        type="hidden"
                                        name="action"
                                        value={connection.enabled ? "disable" : "enable"}
                                      />
                                      <input
                                        type="hidden"
                                        name="providerOAuthId"
                                        value={connection.id}
                                      />
                                      <button
                                        className={
                                          connection.enabled
                                            ? "provider-key-delete-button"
                                            : "provider-action-button provider-action-enable"
                                        }
                                        aria-label={
                                          connection.enabled
                                            ? "Disable OAuth connection"
                                            : "Enable OAuth connection"
                                        }
                                        title={connection.enabled ? "Disable" : "Enable"}
                                        type="submit"
                                      >
                                        <FlatIcon
                                          name={connection.enabled ? "disable" : "enable"}
                                        />
                                      </button>
                                    </form>
                                    <form action="/api/provider-oauth" method="post">
                                      <input type="hidden" name="action" value="delete" />
                                      <input
                                        type="hidden"
                                        name="providerOAuthId"
                                        value={connection.id}
                                      />
                                      <button
                                        className="provider-key-delete-button"
                                        aria-label="Delete OAuth connection"
                                        title="Delete OAuth connection"
                                        type="submit"
                                      >
                                        <FlatIcon name="delete" />
                                      </button>
                                    </form>
                                  </span>
                                </td>
                              </tr>
                            ))
                          )
                        ) : selectedProviderKeys.length === 0 ? (
                          <tr>
                            <td colSpan={5}>No provider key stored.</td>
                          </tr>
                        ) : (
                          selectedProviderKeys.map((providerKey) => (
                            <tr key={providerKey.id}>
                              <td>{providerKey.label ?? "-"}</td>
                              <td>{providerKey.priority}</td>
                              <td>
                                <ProviderApiKeyTestStatusPill status={providerKey.lastTestStatus} />
                              </td>
                              <td>{formatProviderApiKeyLastTest(providerKey)}</td>
                              <td>
                                <a
                                  className="provider-key-delete-button"
                                  href={buildQueryHref(searchParams, {
                                    providerKeyDelete: providerKey.id,
                                    selected: selectedProvider.id,
                                  })}
                                  aria-label="Delete API key"
                                  title="Delete API key"
                                >
                                  <FlatIcon name="delete" />
                                </a>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : (
            <p>No provider selected.</p>
          )}
        </aside>
      </div>

      <div className="chart-card model-library-card">
        <h2 className="chart-card-title">
          Model library{selectedProvider ? ` - ${selectedProvider.displayName}` : ""}
        </h2>
        {selectedProviderModels.length === 0 ? (
          <p>No provider models discovered yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table model-library-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model ID</th>
                  <th>Context</th>
                  <th>Input price</th>
                  <th>Output price</th>
                  <th>Tools</th>
                  <th>Streaming</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedProviderModels.map((model) => (
                  <tr key={model.id}>
                    <td>{model.providerDisplayName}</td>
                    <td>
                      <span className="model-id-cell">
                        <strong>{model.modelDisplayName}</strong>
                        <small className="mono">{model.modelId}</small>
                      </span>
                    </td>
                    <td>{formatModelContext(model.contextWindow)}</td>
                    <td>{formatModelPrice(model.inputUsdPerMillionTokens)}</td>
                    <td>{formatModelPrice(model.outputUsdPerMillionTokens)}</td>
                    <td>{formatBooleanFeature(model.supportsTools)}</td>
                    <td>{formatBooleanFeature(model.supportsStreaming)}</td>
                    <td>
                      <ModelAvailabilityPill value={model.availability} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function ProviderHealthDetailPill({ status }: { status: string }) {
  return <ProviderStatusPill label={formatProviderHealthStatusLabel(status)} status={status} />;
}

function ProviderApiKeyTestStatusPill({
  status,
}: {
  status: ProviderApiKeyMetadata["lastTestStatus"];
}) {
  return <ProviderStatusPill label={formatProviderTestStatusLabel(status)} status={status} />;
}

function ProviderOAuthTestStatusPill({
  status,
}: {
  status: ConsoleProviderOAuthConnection["lastTestStatus"];
}) {
  return <ProviderStatusPill label={formatProviderTestStatusLabel(status)} status={status} />;
}

function ModelAvailabilityPill({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  if (normalized === "available") {
    return <span className="pill--ok pill">Enabled</span>;
  }
  if (normalized === "disabled") {
    return <span className="pill--danger pill">Disabled</span>;
  }
  return <span className="pill">{formatModelAvailability(value)}</span>;
}

function ProviderStatusPill({ label, status }: { label: string; status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "healthy") {
    return <span className="pill--ok pill">{label}</span>;
  }
  if (normalized === "unknown") {
    return <span className="pill">{label}</span>;
  }
  if (normalized === "checking" || normalized === "quota_limited") {
    return <span className="pill--warn pill">{label}</span>;
  }
  return <span className="pill--danger pill">{label}</span>;
}

function formatProviderHealthStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "healthy") {
    return "Healthy";
  }
  if (normalized === "disabled") {
    return "Disabled";
  }
  if (normalized === "checking") {
    return "Checking";
  }
  if (normalized === "unhealthy") {
    return "Unhealthy";
  }
  if (normalized === "auth_failed") {
    return "Auth failed";
  }
  if (normalized === "quota_limited") {
    return "Quota limited";
  }
  if (normalized === "network_error") {
    return "Network error";
  }
  return "Unknown";
}

function formatProviderTestStatusLabel(
  status:
    | ProviderApiKeyMetadata["lastTestStatus"]
    | ConsoleProviderOAuthConnection["lastTestStatus"],
): string {
  return {
    auth_failed: "Auth failed",
    healthy: "Healthy",
    network_error: "Network error",
    quota_limited: "Quota limited",
    unhealthy: "Unhealthy",
    unknown: "Unknown",
  }[status];
}

function groupProviderModelsByProviderId(providerModels: ConsoleProviderModelOption[]) {
  const grouped = new Map<string, ConsoleProviderModelOption[]>();
  for (const model of providerModels) {
    const models = grouped.get(model.providerId) ?? [];
    models.push(model);
    grouped.set(model.providerId, models);
  }
  return grouped;
}

function groupProviderKeysByProviderId(providerKeys: ProviderApiKeyMetadata[]) {
  const grouped = new Map<string, ProviderApiKeyMetadata[]>();
  for (const providerKey of providerKeys) {
    const keys = grouped.get(providerKey.providerId) ?? [];
    keys.push(providerKey);
    grouped.set(providerKey.providerId, keys);
  }
  return grouped;
}

function groupProviderOAuthByProviderId(
  providerOAuthConnections: ConsoleProviderOAuthConnection[],
) {
  const grouped = new Map<string, ConsoleProviderOAuthConnection[]>();
  for (const connection of providerOAuthConnections) {
    const connections = grouped.get(connection.providerId) ?? [];
    connections.push(connection);
    grouped.set(connection.providerId, connections);
  }
  return grouped;
}

function readProviderCredentialCount(
  provider: ConsoleProvider,
  providerKeysByProviderId: Map<string, ProviderApiKeyMetadata[]>,
  providerOAuthByProviderId: Map<string, ConsoleProviderOAuthConnection[]>,
): number {
  if (provider.providerType === "local") {
    return 1;
  }
  if (provider.providerType === "subscription") {
    return providerOAuthByProviderId.get(provider.id)?.length ?? 0;
  }
  return providerKeysByProviderId.get(provider.id)?.length ?? 0;
}

function formatProviderType(provider: ConsoleProvider): string {
  if (provider.providerType === "local") {
    return "Local";
  }
  if (provider.providerType === "subscription") {
    return "Subscription";
  }
  return provider.providerTemplateId ? "Template" : "API Key";
}

function formatProviderLastConnection(
  providerHealth: ConsoleProviderHealthSummary | undefined,
): string {
  if (!providerHealth?.latestProbeAt) {
    return "-";
  }

  return formatRelativeDateTime(providerHealth.latestProbeAt);
}

function formatProviderApiKeyLastTest(providerKey: ProviderApiKeyMetadata): string {
  return providerKey.lastTestedAt ? formatRelativeDateTime(providerKey.lastTestedAt) : "-";
}

function formatProviderOAuthLastTest(connection: ConsoleProviderOAuthConnection): string {
  return connection.lastTestedAt ? formatRelativeDateTime(connection.lastTestedAt) : "-";
}

function formatRelativeDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const elapsedMs = Date.now() - date.getTime();
  if (elapsedMs < 60_000) {
    return "just now";
  }
  if (elapsedMs < 3_600_000) {
    return `${Math.floor(elapsedMs / 60_000)} min ago`;
  }
  if (elapsedMs < 86_400_000) {
    return `${Math.floor(elapsedMs / 3_600_000)} h ago`;
  }
  return date.toISOString().slice(0, 10);
}

function formatModelContext(contextWindow: number | null): string {
  if (contextWindow === null) {
    return "Unknown";
  }
  if (contextWindow >= 1_000_000) {
    return `${formatDecimal(contextWindow / 1_000_000)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${formatDecimal(contextWindow / 1_000)}K`;
  }
  return String(contextWindow);
}

function formatModelPrice(price: number | null): string {
  if (price === null) {
    return "Unknown";
  }
  const digits = price >= 1 ? 2 : 4;
  return `$${price.toFixed(digits)}`;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBooleanFeature(value: boolean): string {
  return value ? "Yes" : "No";
}

function formatModelAvailability(value: string): string {
  if (value === "available") {
    return "Enabled";
  }
  if (value === "disabled") {
    return "Disabled";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

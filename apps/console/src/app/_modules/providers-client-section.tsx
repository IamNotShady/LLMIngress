"use client";

import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProviderOAuthConnection } from "@llmingress/db/console-provider-oauth";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ConsoleProviderModelOption } from "@llmingress/db/console-route-policies";
import { type FormEvent, Fragment, useEffect, useMemo, useState } from "react";
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
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedProviderId(initialProviderId);
  }, [initialProviderId]);
  const toggleProvider = (providerId: string) => {
    setSelectedProviderId((currentProviderId) =>
      currentProviderId === providerId ? null : providerId,
    );
  };
  const refreshProviderModels = async (event: FormEvent<HTMLFormElement>, providerId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    setRefreshingProviderId(providerId);
    try {
      await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch {
      // ponytail: no toast yet; surface enqueue failures when refresh status UI exists.
    } finally {
      setRefreshingProviderId(null);
    }
  };
  const selectedProvider = selectedProviderId
    ? (providers.find((provider) => provider.id === selectedProviderId) ?? null)
    : null;
  const selectedProviderKeys = selectedProvider
    ? (providerKeysByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const selectedProviderOAuthConnections = selectedProvider
    ? (providerOAuthByProviderId.get(selectedProvider.id) ?? [])
    : [];
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
                      const isSelected = provider.id === selectedProvider?.id;
                      const isRefreshing = provider.id === refreshingProviderId;

                      return (
                        <Fragment key={provider.id}>
                          <tr className={isSelected ? "is-selected" : "is-clickable"}>
                            <td>
                              <button
                                aria-expanded={isSelected}
                                className="table-row-link"
                                type="button"
                                onClick={() => toggleProvider(provider.id)}
                              >
                                <strong>{provider.displayName}</strong>
                              </button>
                            </td>
                            <td>
                              <button
                                aria-expanded={isSelected}
                                className="table-row-link"
                                type="button"
                                onClick={() => toggleProvider(provider.id)}
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
                                aria-expanded={isSelected}
                                className="table-row-link"
                                type="button"
                                onClick={() => toggleProvider(provider.id)}
                              >
                                {formatProviderType(provider)}
                              </button>
                            </td>
                            <td className="num">
                              <button
                                aria-expanded={isSelected}
                                className="table-row-link"
                                type="button"
                                onClick={() => toggleProvider(provider.id)}
                              >
                                {providerKeyCount}
                              </button>
                            </td>
                            <td className="num">
                              <button
                                aria-expanded={isSelected}
                                className="table-row-link"
                                type="button"
                                onClick={() => toggleProvider(provider.id)}
                              >
                                {providerModels.length}
                              </button>
                            </td>
                            <td>
                              <button
                                aria-expanded={isSelected}
                                className="table-row-link"
                                type="button"
                                onClick={() => toggleProvider(provider.id)}
                              >
                                {formatProviderLastConnection(providerHealth)}
                              </button>
                            </td>
                            <td>
                              <span className="provider-table-actions">
                                <form
                                  action="/api/provider-model-refresh"
                                  method="post"
                                  onSubmit={(event) => refreshProviderModels(event, provider.id)}
                                >
                                  <input type="hidden" name="providerId" value={provider.id} />
                                  <button
                                    className="provider-refresh-button"
                                    disabled={providerKeyCount === 0 || isRefreshing}
                                    aria-busy={isRefreshing}
                                    aria-label={`Refresh models for ${provider.displayName}`}
                                    title="Refresh models"
                                    type="submit"
                                  >
                                    <FlatIcon name="refresh" />
                                  </button>
                                </form>
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
                          {isSelected ? (
                            <tr className="provider-inline-detail-row">
                              <td colSpan={7}>
                                <section
                                  className="provider-inline-detail"
                                  aria-label={`Provider credentials - ${provider.displayName}`}
                                >
                                  <section className="provider-detail-section">
                                    <div className="provider-detail-section-head">
                                      <h3>
                                        {provider.providerType === "subscription"
                                          ? "OAuth connections"
                                          : provider.providerType === "local"
                                            ? "Local connection"
                                            : "API keys"}
                                      </h3>
                                      {provider.providerType === "subscription" ? (
                                        <form
                                          action="/api/provider-oauth"
                                          className="provider-oauth-add-form"
                                          method="post"
                                        >
                                          <input type="hidden" name="action" value="start" />
                                          <input
                                            type="hidden"
                                            name="providerId"
                                            value={provider.id}
                                          />
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
                                      ) : provider.providerType === "local" ? null : (
                                        <a
                                          className="provider-key-add-button"
                                          href={buildQueryHref(searchParams, {
                                            providerKeyDialog: provider.id,
                                            selected: provider.id,
                                          })}
                                          aria-label="Add API key"
                                          title="Add API key"
                                        >
                                          <FlatIcon name="key" />
                                        </a>
                                      )}
                                    </div>
                                    {provider.providerType === "local" ? (
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
                                            {provider.providerType === "subscription" ? (
                                              selectedProviderOAuthConnections.length === 0 ? (
                                                <tr>
                                                  <td colSpan={5}>No OAuth connection stored.</td>
                                                </tr>
                                              ) : (
                                                selectedProviderOAuthConnections.map(
                                                  (connection) => (
                                                    <tr key={connection.id}>
                                                      <td>{connection.label ?? "-"}</td>
                                                      <td>{connection.priority}</td>
                                                      <td>
                                                        <ProviderOAuthTestStatusPill
                                                          status={connection.lastTestStatus}
                                                        />
                                                      </td>
                                                      <td>
                                                        {formatProviderOAuthLastTest(connection)}
                                                      </td>
                                                      <td>
                                                        <span className="provider-table-actions">
                                                          <form
                                                            action="/api/provider-oauth"
                                                            method="post"
                                                          >
                                                            <input
                                                              type="hidden"
                                                              name="action"
                                                              value={
                                                                connection.enabled
                                                                  ? "disable"
                                                                  : "enable"
                                                              }
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
                                                              title={
                                                                connection.enabled
                                                                  ? "Disable"
                                                                  : "Enable"
                                                              }
                                                              type="submit"
                                                            >
                                                              <FlatIcon
                                                                name={
                                                                  connection.enabled
                                                                    ? "disable"
                                                                    : "enable"
                                                                }
                                                              />
                                                            </button>
                                                          </form>
                                                          <form
                                                            action="/api/provider-oauth"
                                                            method="post"
                                                          >
                                                            <input
                                                              type="hidden"
                                                              name="action"
                                                              value="delete"
                                                            />
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
                                                  ),
                                                )
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
                                                    <ProviderApiKeyTestStatusPill
                                                      status={providerKey.lastTestStatus}
                                                    />
                                                  </td>
                                                  <td>
                                                    {formatProviderApiKeyLastTest(providerKey)}
                                                  </td>
                                                  <td>
                                                    <a
                                                      className="provider-key-delete-button"
                                                      href={buildQueryHref(searchParams, {
                                                        providerKeyDelete: providerKey.id,
                                                        selected: provider.id,
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
                                </section>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
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

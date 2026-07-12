"use client";

import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProviderOAuthConnection } from "@llmingress/db/console-provider-oauth";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ConsoleProviderModelPage } from "@llmingress/db/console-route-policies";
import { type FormEvent, Fragment, useMemo, useState } from "react";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { buildQueryHref, type ConsoleSearchParams } from "../_lib/pagination";
import { formatRelativeDateTime } from "../_lib/provider-relative-time";

export function ProvidersClientSection({
  initialSelectedProviderId,
  modelQuery,
  providerHealthSummaries,
  providerKeys,
  providerModelPage,
  providerOAuthConnections,
  providers,
  renderedAtMs,
  searchParams,
}: {
  initialSelectedProviderId?: string;
  modelQuery: string;
  providerHealthSummaries: ConsoleProviderHealthSummary[];
  providerKeys: ProviderApiKeyMetadata[];
  providerModelPage: ConsoleProviderModelPage;
  providerOAuthConnections: ConsoleProviderOAuthConnection[];
  providers: ConsoleProvider[];
  renderedAtMs: number;
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
  const initialProvider =
    providers.find((provider) => provider.id === initialSelectedProviderId) ??
    providers.find((provider) => provider.providerKey === "openai") ??
    providers[0] ??
    null;
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshProviderModels = async (event: FormEvent<HTMLFormElement>, providerId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    setRefreshError(null);
    setRefreshingProviderId(providerId);
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        setRefreshError(payload.error ?? "Provider model refresh failed.");
      }
    } catch {
      setRefreshError("Provider model refresh failed.");
    } finally {
      setRefreshingProviderId(null);
    }
  };
  const selectedProvider = initialProvider;
  const selectedProviderKeys = selectedProvider
    ? (providerKeysByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const selectedProviderOAuthConnections = selectedProvider
    ? (providerOAuthByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const selectedProviderModels = providerModelPage.items;

  return (
    <>
      <div className="providers-content-grid">
        <div className="providers-main-column">
          <div className="chart-card providers-list-card">
            <h2 className="chart-card-title">Provider list</h2>
            {refreshError ? (
              <p className="form-error" role="alert">
                {refreshError}
              </p>
            ) : null}
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
                      const providerKeyCount = readProviderCredentialCount(
                        provider,
                        providerKeysByProviderId,
                        providerOAuthByProviderId,
                      );
                      const isSelected = provider.id === selectedProvider?.id;
                      const isRefreshing = provider.id === refreshingProviderId;
                      const isRefreshDisabled =
                        !provider.enabled || providerKeyCount === 0 || isRefreshing;

                      return (
                        <Fragment key={provider.id}>
                          <tr className={isSelected ? "is-selected" : "is-clickable"}>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={buildQueryHref(searchParams, {
                                  modelPage: undefined,
                                  modelQuery: undefined,
                                  selected: provider.id,
                                })}
                              >
                                <strong>{provider.displayName}</strong>
                              </a>
                            </td>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={buildQueryHref(searchParams, {
                                  modelPage: undefined,
                                  modelQuery: undefined,
                                  selected: provider.id,
                                })}
                              >
                                <ProviderHealthDetailPill
                                  status={
                                    provider.enabled
                                      ? (providerHealth?.status ?? "unknown")
                                      : "disabled"
                                  }
                                />
                              </a>
                            </td>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={buildQueryHref(searchParams, {
                                  modelPage: undefined,
                                  modelQuery: undefined,
                                  selected: provider.id,
                                })}
                              >
                                {formatProviderType(provider)}
                              </a>
                            </td>
                            <td className="num">
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={buildQueryHref(searchParams, {
                                  modelPage: undefined,
                                  modelQuery: undefined,
                                  selected: provider.id,
                                })}
                              >
                                {providerKeyCount}
                              </a>
                            </td>
                            <td className="num">
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={buildQueryHref(searchParams, {
                                  modelPage: undefined,
                                  modelQuery: undefined,
                                  selected: provider.id,
                                })}
                              >
                                {provider.providerModelCount}
                              </a>
                            </td>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={buildQueryHref(searchParams, {
                                  modelPage: undefined,
                                  modelQuery: undefined,
                                  selected: provider.id,
                                })}
                              >
                                {formatProviderLastConnection(providerHealth, renderedAtMs)}
                              </a>
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
                                    className="provider-refresh-button row-action-button"
                                    disabled={isRefreshDisabled}
                                    aria-busy={isRefreshing}
                                    aria-label={`Refresh models for ${provider.displayName}`}
                                    title={
                                      provider.enabled
                                        ? "Refresh models"
                                        : "Enable provider to refresh models"
                                    }
                                    type="submit"
                                  >
                                    <FlatIcon name="refresh" />
                                  </button>
                                </form>
                                {provider.enabled ? (
                                  <>
                                    <a
                                      className="provider-action-button provider-action-edit row-action-button"
                                      href={buildQueryHref(searchParams, {
                                        providerDialog: provider.id,
                                        selected: provider.id,
                                      })}
                                      aria-label={`Edit ${provider.displayName}`}
                                      id={`provider-edit-${provider.id}-trigger`}
                                      title="Edit"
                                    >
                                      <FlatIcon name="edit" />
                                    </a>
                                    <ConsoleMutationForm
                                      action="/api/providers"
                                      fallbackError="Provider disable failed."
                                    >
                                      <input type="hidden" name="action" value="disable" />
                                      <input type="hidden" name="id" value={provider.id} />
                                      <button
                                        className="provider-action-button provider-action-disable row-action-button"
                                        aria-label={`Disable ${provider.displayName}`}
                                        title="Disable"
                                        type="submit"
                                      >
                                        <FlatIcon name="disable" />
                                      </button>
                                    </ConsoleMutationForm>
                                    <a
                                      className="provider-action-button provider-action-delete row-action-button row-action-danger"
                                      href={buildQueryHref(searchParams, {
                                        providerDelete: provider.id,
                                        selected: provider.id,
                                      })}
                                      aria-label={`Delete ${provider.displayName}`}
                                      id={`provider-delete-${provider.id}-trigger`}
                                      title="Delete"
                                    >
                                      <FlatIcon name="delete" />
                                    </a>
                                  </>
                                ) : (
                                  <>
                                    <ConsoleMutationForm
                                      action="/api/providers"
                                      fallbackError="Provider enable failed."
                                    >
                                      <input type="hidden" name="action" value="enable" />
                                      <input type="hidden" name="id" value={provider.id} />
                                      <button
                                        className="provider-action-button provider-action-enable row-action-button"
                                        aria-label={`Enable ${provider.displayName}`}
                                        title="Enable"
                                        type="submit"
                                      >
                                        <FlatIcon name="enable" />
                                      </button>
                                    </ConsoleMutationForm>
                                    <a
                                      className="provider-action-button provider-action-delete row-action-button row-action-danger"
                                      href={buildQueryHref(searchParams, {
                                        providerDelete: provider.id,
                                        selected: provider.id,
                                      })}
                                      aria-label={`Delete ${provider.displayName}`}
                                      id={`provider-delete-${provider.id}-trigger`}
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
                                        <ConsoleMutationForm
                                          action="/api/provider-oauth"
                                          className="provider-oauth-add-form"
                                          fallbackError="Provider OAuth start failed."
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
                                            id={`provider-key-${provider.id}-trigger`}
                                            title="Add OAuth connection"
                                            type="submit"
                                          >
                                            <FlatIcon name="key" />
                                          </button>
                                        </ConsoleMutationForm>
                                      ) : provider.providerType === "local" ? null : (
                                        <a
                                          className="provider-key-add-button"
                                          href={buildQueryHref(searchParams, {
                                            providerKeyDialog: provider.id,
                                            selected: provider.id,
                                          })}
                                          aria-label="Add API key"
                                          id={`provider-key-${provider.id}-trigger`}
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
                                                        {formatProviderOAuthLastTest(
                                                          connection,
                                                          renderedAtMs,
                                                        )}
                                                      </td>
                                                      <td>
                                                        <span className="provider-table-actions">
                                                          <ConsoleMutationForm
                                                            action="/api/provider-oauth"
                                                            fallbackError="Provider OAuth update failed."
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
                                                                  ? "provider-key-delete-button row-action-button row-action-danger"
                                                                  : "provider-action-button provider-action-enable row-action-button"
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
                                                          </ConsoleMutationForm>
                                                          <ConsoleMutationForm
                                                            action="/api/provider-oauth"
                                                            fallbackError="Provider OAuth deletion failed."
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
                                                          </ConsoleMutationForm>
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
                                                    {formatProviderApiKeyLastTest(
                                                      providerKey,
                                                      renderedAtMs,
                                                    )}
                                                  </td>
                                                  <td>
                                                    <a
                                                      className="provider-key-delete-button"
                                                      href={buildQueryHref(searchParams, {
                                                        providerKeyDelete: providerKey.id,
                                                        selected: provider.id,
                                                      })}
                                                      aria-label="Delete API key"
                                                      id={`provider-key-delete-${providerKey.id}-trigger`}
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
        <div className="model-library-head">
          <h2 className="chart-card-title">
            Model library{selectedProvider ? ` - ${selectedProvider.displayName}` : ""}
          </h2>
          {selectedProvider ? (
            <form className="model-library-search" action="/providers" method="get">
              <input type="hidden" name="selected" value={selectedProvider.id} />
              <label className="sr-only" htmlFor="provider-model-query">
                Search models
              </label>
              <input
                defaultValue={modelQuery}
                id="provider-model-query"
                name="modelQuery"
                type="search"
                placeholder="Search models"
              />
            </form>
          ) : null}
        </div>
        {providerModelPage.total === 0 && modelQuery ? (
          <p>No models match “{modelQuery}”.</p>
        ) : providerModelPage.total === 0 ? (
          <p>No provider models discovered yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table model-library-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model ID</th>
                  <th>Context</th>
                  <th>Output cap</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Input price</th>
                  <th>Output price</th>
                  <th>Function</th>
                  <th>Reasoning</th>
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
                    <td>{formatModelContext(model.maxOutputTokens)}</td>
                    <td>{formatModalities(model.inputModalities)}</td>
                    <td>{formatModalities(model.outputModalities)}</td>
                    <td>{formatModelPrice(model.inputUsdPerMillionTokens)}</td>
                    <td>{formatModelPrice(model.outputUsdPerMillionTokens)}</td>
                    <td>{formatNullableBooleanFeature(model.supportsFunctionCalling)}</td>
                    <td>{formatNullableBooleanFeature(model.supportsReasoning)}</td>
                    <td>{formatBooleanFeature(model.supportsStreaming)}</td>
                    <td>
                      <ModelAvailabilityPill value={model.availability} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {providerModelPage.pageCount > 1 ? (
              <nav className="model-library-truncation-note" aria-label="Model pages">
                {providerModelPage.page > 1 ? (
                  <a
                    href={buildQueryHref(searchParams, {
                      modelPage: String(providerModelPage.page - 1),
                    })}
                  >
                    Previous
                  </a>
                ) : null}
                <span>
                  Page {providerModelPage.page} of {providerModelPage.pageCount} ·{" "}
                  {providerModelPage.total} models
                </span>
                {providerModelPage.page < providerModelPage.pageCount ? (
                  <a
                    href={buildQueryHref(searchParams, {
                      modelPage: String(providerModelPage.page + 1),
                    })}
                  >
                    Next
                  </a>
                ) : null}
              </nav>
            ) : null}
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
    // Intentionally disabled is a neutral state, not an error.
    return <span className="pill">Disabled</span>;
  }
  return <span className="pill">{formatModelAvailability(value)}</span>;
}

function ProviderStatusPill({ label, status }: { label: string; status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "healthy") {
    return <span className="pill--ok pill">{label}</span>;
  }
  // Unknown and intentionally disabled are neutral states, not errors.
  if (normalized === "unknown" || normalized === "disabled") {
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
  referenceTimeMs: number,
): string {
  if (!providerHealth?.latestProbeAt) {
    return "-";
  }

  return formatRelativeDateTime(providerHealth.latestProbeAt, referenceTimeMs);
}

function formatProviderApiKeyLastTest(
  providerKey: ProviderApiKeyMetadata,
  referenceTimeMs: number,
): string {
  return providerKey.lastTestedAt
    ? formatRelativeDateTime(providerKey.lastTestedAt, referenceTimeMs)
    : "-";
}

function formatProviderOAuthLastTest(
  connection: ConsoleProviderOAuthConnection,
  referenceTimeMs: number,
): string {
  return connection.lastTestedAt
    ? formatRelativeDateTime(connection.lastTestedAt, referenceTimeMs)
    : "-";
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

function formatNullableBooleanFeature(value: boolean | null): string {
  return value === null ? "Unknown" : formatBooleanFeature(value);
}

function formatModalities(value: readonly string[] | null): string {
  return value && value.length > 0 ? value.join(", ") : "Unknown";
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

"use client";

import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProviderOAuthConnection } from "@llmingress/db/console-provider-oauth";
import type { ConsoleProviderQuotaSummary } from "@llmingress/db/console-provider-quota";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ConsoleProviderModelPage } from "@llmingress/db/console-route-policies";
import { useRouter } from "next/navigation";
import { type FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ConsoleMutationForm, ConsoleMutationToast } from "../_components/console-mutation-form";
import { EmptyState } from "../_components/empty-state";
import { FlatIcon } from "../_components/flat-icon";
import { Pagination } from "../_components/pagination";
import { buildQueryHref, type ConsoleSearchParams } from "../_lib/pagination";
import { aggregateProviderConnectionHealthStatus } from "../_lib/provider-health";
import {
  buildProviderQuotaConnectionView,
  findSharedProviderBalances,
  type ProviderQuotaConnectionView,
  type SharedProviderBalance,
} from "../_lib/provider-quota-format";
import { formatRelativeDateTime } from "../_lib/provider-relative-time";

export function ProvidersClientSection({
  initialSelectedProviderId,
  modelQuery,
  providerHealthSummaries,
  providerKeys,
  providerModelPage,
  providerOAuthConnections,
  providerQuotaSummaries,
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
  providerQuotaSummaries: ConsoleProviderQuotaSummary[];
  providers: ConsoleProvider[];
  renderedAtMs: number;
  searchParams: ConsoleSearchParams;
}) {
  const connectionHealthByKey = useMemo(
    () =>
      new Map(
        providerHealthSummaries.map((summary) => [
          providerConnectionHealthKey(summary.providerId, summary.id),
          summary,
        ]),
      ),
    [providerHealthSummaries],
  );
  const providerHealthByProviderId = useMemo(
    () => groupProviderHealthByProviderId(providerHealthSummaries),
    [providerHealthSummaries],
  );
  const providerQuotaByProviderId = useMemo(
    () => groupProviderQuotaByProviderId(providerQuotaSummaries),
    [providerQuotaSummaries],
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
    providers.find((provider) => provider.id === initialSelectedProviderId) ?? null;
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (!refreshNotice) {
      return;
    }
    const timeout = window.setTimeout(() => setRefreshNotice(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [refreshNotice]);
  const refreshProviderModels = async (event: FormEvent<HTMLFormElement>, providerId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    setRefreshError(null);
    setRefreshNotice(null);
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
        return;
      }
      setRefreshNotice("Model refresh queued — models update shortly.");
      window.setTimeout(() => router.refresh(), 2500);
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
            {refreshNotice && typeof document !== "undefined"
              ? createPortal(
                  <ConsoleMutationToast
                    message={refreshNotice}
                    onDismiss={() => setRefreshNotice(null)}
                    tone="success"
                  />,
                  document.body,
                )
              : null}
            {providers.length === 0 ? (
              <EmptyState
                title="No providers configured"
                description="Connect a provider to start routing requests."
              />
            ) : (
              <div className="data-table-wrap">
                <table className="data-table bounded-table providers-table">
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
                      const providerHealth = providerHealthByProviderId.get(provider.id) ?? [];
                      const providerKeyCount = readProviderCredentialCount(
                        provider,
                        providerKeysByProviderId,
                        providerOAuthByProviderId,
                      );
                      const isSelected = provider.id === selectedProvider?.id;
                      const isRefreshing = provider.id === refreshingProviderId;
                      const isRefreshDisabled =
                        !provider.enabled || providerKeyCount === 0 || isRefreshing;
                      const rowHref = buildQueryHref(searchParams, {
                        modelPage: undefined,
                        modelQuery: undefined,
                        selected: isSelected ? undefined : provider.id,
                      });

                      return (
                        <Fragment key={provider.id}>
                          <tr className={isSelected ? "is-selected" : "is-clickable"}>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={rowHref}
                              >
                                <strong>{provider.displayName}</strong>
                              </a>
                            </td>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={rowHref}
                              >
                                <ProviderHealthDetailPill
                                  status={formatProviderAggregateHealthStatus(
                                    provider,
                                    providerHealth,
                                  )}
                                />
                              </a>
                            </td>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={rowHref}
                              >
                                {formatProviderType(provider)}
                              </a>
                            </td>
                            <td className="num">
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={rowHref}
                              >
                                {providerKeyCount}
                              </a>
                            </td>
                            <td className="num">
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={rowHref}
                              >
                                {provider.providerModelCount}
                              </a>
                            </td>
                            <td>
                              <a
                                aria-expanded={isSelected}
                                className="table-row-link"
                                href={rowHref}
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
                                      errorPresentation="toast"
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
                                      errorPresentation="toast"
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
                                          errorPresentation="toast"
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
                                    <ProviderQuotaSharedBalances
                                      balances={findSharedProviderBalances(
                                        providerQuotaByProviderId.get(provider.id) ?? [],
                                      )}
                                    />
                                    <ProviderConnectionTable
                                      connectionHealthByKey={connectionHealthByKey}
                                      oauthConnections={selectedProviderOAuthConnections}
                                      provider={provider}
                                      providerKeys={selectedProviderKeys}
                                      providerQuotaSummaries={
                                        providerQuotaByProviderId.get(provider.id) ?? []
                                      }
                                      renderedAtMs={renderedAtMs}
                                      searchParams={searchParams}
                                    />
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

      {selectedProvider ? (
        <div className="chart-card model-library-card">
          <div className="model-library-head">
            <h2 className="chart-card-title">Model library - {selectedProvider.displayName}</h2>
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
          </div>
          {providerModelPage.total === 0 && modelQuery ? (
            <p>No models match “{modelQuery}”.</p>
          ) : providerModelPage.total === 0 ? (
            <p>No provider models discovered yet.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table bounded-table model-library-table">
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
              <Pagination
                ariaLabel="Model pages"
                itemLabel="models"
                page={providerModelPage.page}
                pageParam="modelPage"
                searchParams={searchParams}
                total={providerModelPage.total}
                totalPages={providerModelPage.pageCount}
              />
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

function ProviderHealthDetailPill({ status }: { status: string }) {
  return <ProviderStatusPill label={formatProviderHealthStatusLabel(status)} status={status} />;
}

function ProviderQuotaSharedBalances({ balances }: { balances: SharedProviderBalance[] }) {
  if (balances.length === 0) {
    return null;
  }
  return (
    <p className="provider-quota-shared">
      {/* One account-scoped pool, not one per credential. */}
      {balances
        .map((balance) => `${balance.label} shared across ${balance.connectionCount} connections`)
        .join(" · ")}
    </p>
  );
}

function ProviderQuotaCell({
  children,
  view,
}: {
  children?: React.ReactNode;
  view: ProviderQuotaConnectionView;
}) {
  return (
    <span className="quota-cell">
      {view.windows.map((window) => (
        <span className="quota-window" key={window.label}>
          <strong>{window.percent}</strong>
          <small>
            {window.label}
            {window.resetLabel ? ` · ${window.resetLabel}` : ""}
          </small>
        </span>
      ))}
      {view.balances.map((balance) => (
        <strong key={balance}>{balance}</strong>
      ))}
      {view.reason ? (
        <span className={view.tone === "warn" ? "pill--warn pill" : "pill"}>{view.reason}</span>
      ) : null}
      {view.emptyLabel ? <small>{view.emptyLabel}</small> : null}
      {view.pausedLabel ? <small>{view.pausedLabel}</small> : null}
      {view.sharedBalanceNote ? <small>{view.sharedBalanceNote}</small> : null}
      {view.observedLabel ? <small>{view.observedLabel}</small> : null}
      {children}
    </span>
  );
}

function ProviderConnectionTable({
  connectionHealthByKey,
  oauthConnections,
  provider,
  providerKeys,
  providerQuotaSummaries,
  renderedAtMs,
  searchParams,
}: {
  connectionHealthByKey: Map<string, ConsoleProviderHealthSummary>;
  oauthConnections: ConsoleProviderOAuthConnection[];
  provider: ConsoleProvider;
  providerKeys: ProviderApiKeyMetadata[];
  providerQuotaSummaries: ConsoleProviderQuotaSummary[];
  renderedAtMs: number;
  searchParams: ConsoleSearchParams;
}) {
  const quotaByConnectionId = new Map(
    providerQuotaSummaries.map((summary) => [summary.id, summary]),
  );
  const sharedBalanceKeys = new Set(
    findSharedProviderBalances(providerQuotaSummaries).map((balance) => balance.key),
  );
  const connections =
    provider.providerType === "local"
      ? [
          {
            enabled: provider.enabled,
            id: provider.id,
            kind: "local" as const,
            label: "Local connection",
            priority: null,
          },
        ]
      : provider.providerType === "subscription"
        ? oauthConnections.map((connection) => ({
            enabled: connection.enabled,
            id: connection.id,
            kind: "oauth" as const,
            label: connection.label ?? "OAuth connection",
            priority: connection.priority,
          }))
        : providerKeys.map((providerKey) => ({
            enabled: providerKey.enabled,
            id: providerKey.id,
            kind: "api_key" as const,
            label: providerKey.label ?? providerKey.keyPrefix,
            priority: providerKey.priority,
          }));

  return (
    <div className="data-table-wrap">
      <table className="data-table bounded-table provider-key-table">
        <thead>
          <tr>
            <th>Connection</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Quota</th>
            <th>Last probed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {connections.length === 0 ? (
            <tr>
              <td colSpan={6}>No provider connection stored.</td>
            </tr>
          ) : (
            connections.map((connection) => {
              const health = connectionHealthByKey.get(
                providerConnectionHealthKey(provider.id, connection.id),
              );
              const probeEnabled = provider.enabled && connection.enabled;
              const status = probeEnabled ? (health?.status ?? "healthy") : "disabled";
              return (
                <tr key={connection.id}>
                  <td>
                    <span className="model-id-cell">
                      <strong>{connection.label}</strong>
                      <small className="mono">{connection.id}</small>
                    </span>
                  </td>
                  <td>{connection.priority ?? "-"}</td>
                  <td title={health?.reasonMessage ?? undefined}>
                    <ProviderHealthDetailPill status={status} />
                    {health?.reasonMessage ? <small>{health.reasonMessage}</small> : null}
                  </td>
                  <td>
                    <ProviderQuotaCell
                      view={buildProviderQuotaConnectionView({
                        referenceTimeMs: renderedAtMs,
                        sharedBalanceKeys,
                        summary: quotaByConnectionId.get(connection.id),
                      })}
                    >
                      {connection.kind !== "local" &&
                      connection.enabled &&
                      quotaByConnectionId.has(connection.id) ? (
                        <ConsoleMutationForm
                          action={
                            connection.kind === "oauth"
                              ? "/api/provider-oauth"
                              : "/api/provider-keys"
                          }
                          errorPresentation="toast"
                          fallbackError="Quota probing update failed."
                        >
                          <input
                            type="hidden"
                            name="action"
                            value={
                              quotaByConnectionId.get(connection.id)?.quotaProbeEnabled
                                ? "quota-probe-disable"
                                : "quota-probe-enable"
                            }
                          />
                          <input
                            type="hidden"
                            name={
                              connection.kind === "oauth" ? "providerOAuthId" : "providerApiKeyId"
                            }
                            value={connection.id}
                          />
                          <button
                            aria-label={
                              quotaByConnectionId.get(connection.id)?.quotaProbeEnabled
                                ? "Pause quota probing"
                                : "Resume quota probing"
                            }
                            className="quota-toggle-button"
                            type="submit"
                          >
                            {quotaByConnectionId.get(connection.id)?.quotaProbeEnabled
                              ? "Pause"
                              : "Resume"}
                          </button>
                        </ConsoleMutationForm>
                      ) : null}
                    </ProviderQuotaCell>
                  </td>
                  <td>{formatConnectionLastProbe(health, renderedAtMs)}</td>
                  <td>
                    <span className="provider-table-actions">
                      <ConsoleMutationForm
                        action="/api/provider-health-probes"
                        errorPresentation="toast"
                        fallbackError="Provider connection probe failed."
                        successMessage="Connection probe queued — refreshing shortly."
                        successRefreshDelayMs={2500}
                      >
                        <input type="hidden" name="providerId" value={provider.id} />
                        <input type="hidden" name="providerConnectionId" value={connection.id} />
                        <button
                          aria-label={`Probe ${connection.label}`}
                          className="provider-refresh-button row-action-button"
                          disabled={!probeEnabled || status === "checking"}
                          title="Probe connection"
                          type="submit"
                        >
                          <FlatIcon name="probe" />
                        </button>
                      </ConsoleMutationForm>
                      {connection.kind === "oauth" ? (
                        <>
                          <ConsoleMutationForm
                            action="/api/provider-oauth"
                            errorPresentation="toast"
                            fallbackError="Provider OAuth update failed."
                          >
                            <input
                              type="hidden"
                              name="action"
                              value={connection.enabled ? "disable" : "enable"}
                            />
                            <input type="hidden" name="providerOAuthId" value={connection.id} />
                            <button
                              aria-label={
                                connection.enabled
                                  ? "Disable OAuth connection"
                                  : "Enable OAuth connection"
                              }
                              className="provider-action-button row-action-button"
                              title={connection.enabled ? "Disable" : "Enable"}
                              type="submit"
                            >
                              <FlatIcon name={connection.enabled ? "disable" : "enable"} />
                            </button>
                          </ConsoleMutationForm>
                          <ConsoleMutationForm
                            action="/api/provider-oauth"
                            errorPresentation="toast"
                            fallbackError="Provider OAuth deletion failed."
                          >
                            <input type="hidden" name="action" value="delete" />
                            <input type="hidden" name="providerOAuthId" value={connection.id} />
                            <button
                              aria-label="Delete OAuth connection"
                              className="provider-key-delete-button"
                              title="Delete OAuth connection"
                              type="submit"
                            >
                              <FlatIcon name="delete" />
                            </button>
                          </ConsoleMutationForm>
                        </>
                      ) : connection.kind === "api_key" ? (
                        <>
                          <a
                            aria-label="Rotate API key"
                            className="provider-action-button row-action-button"
                            href={buildQueryHref(searchParams, {
                              providerKeyDialog: provider.id,
                              providerKeyEdit: connection.id,
                              selected: provider.id,
                            })}
                            id={`provider-key-rotate-${connection.id}-trigger`}
                            title="Rotate API key"
                          >
                            <FlatIcon name="edit" />
                          </a>
                          <ConsoleMutationForm
                            action="/api/provider-keys"
                            errorPresentation="toast"
                            fallbackError="Provider API key update failed."
                            successMessage="Provider API key updated."
                          >
                            <input
                              type="hidden"
                              name="action"
                              value={connection.enabled ? "disable" : "enable"}
                            />
                            <input type="hidden" name="providerApiKeyId" value={connection.id} />
                            <button
                              aria-label={connection.enabled ? "Disable API key" : "Enable API key"}
                              className="provider-action-button row-action-button"
                              title={connection.enabled ? "Disable" : "Enable"}
                              type="submit"
                            >
                              <FlatIcon name={connection.enabled ? "disable" : "enable"} />
                            </button>
                          </ConsoleMutationForm>
                          <a
                            aria-label="Delete API key"
                            className="provider-key-delete-button"
                            href={buildQueryHref(searchParams, {
                              providerKeyDelete: connection.id,
                              selected: provider.id,
                            })}
                            id={`provider-key-delete-${connection.id}-trigger`}
                            title="Delete API key"
                          >
                            <FlatIcon name="delete" />
                          </a>
                        </>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function providerConnectionHealthKey(providerId: string, providerConnectionId: string): string {
  return `${providerId}:${providerConnectionId}`;
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
  if (normalized === "checking") {
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
  return "Unknown";
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

function groupProviderQuotaByProviderId(
  summaries: ConsoleProviderQuotaSummary[],
): Map<string, ConsoleProviderQuotaSummary[]> {
  const grouped = new Map<string, ConsoleProviderQuotaSummary[]>();
  for (const summary of summaries) {
    const providerQuota = grouped.get(summary.providerId) ?? [];
    providerQuota.push(summary);
    grouped.set(summary.providerId, providerQuota);
  }
  return grouped;
}

function groupProviderHealthByProviderId(
  summaries: ConsoleProviderHealthSummary[],
): Map<string, ConsoleProviderHealthSummary[]> {
  const grouped = new Map<string, ConsoleProviderHealthSummary[]>();
  for (const summary of summaries) {
    const providerHealth = grouped.get(summary.providerId) ?? [];
    providerHealth.push(summary);
    grouped.set(summary.providerId, providerHealth);
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
  providerHealth: ConsoleProviderHealthSummary[],
  referenceTimeMs: number,
): string {
  const latestProbeAt = providerHealth.reduce<Date | null>(
    (latest, connection) =>
      connection.latestProbeAt && (!latest || connection.latestProbeAt > latest)
        ? connection.latestProbeAt
        : latest,
    null,
  );
  if (!latestProbeAt) {
    return "-";
  }

  return formatRelativeDateTime(latestProbeAt, referenceTimeMs);
}

function formatConnectionLastProbe(
  health: ConsoleProviderHealthSummary | undefined,
  referenceTimeMs: number,
): string {
  return health?.latestProbeAt
    ? formatRelativeDateTime(health.latestProbeAt, referenceTimeMs)
    : "-";
}

function formatProviderAggregateHealthStatus(
  provider: ConsoleProvider,
  health: ConsoleProviderHealthSummary[],
): string {
  if (!provider.enabled) {
    return "disabled";
  }
  return aggregateProviderConnectionHealthStatus(health);
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

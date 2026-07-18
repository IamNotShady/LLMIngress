import {
  type ConsoleApiKeyLimit,
  type ConsoleApiKeyLimitRuntimeSnapshot,
  defaultApiKeyLimitFormValues,
  formatApiKeyLimitSummaries,
  listApiKeyLimitRuntimeSnapshots,
  listApiKeyLimits,
} from "@llmingress/db/console-api-key-limits";
import {
  type ApiKeyVirtualModelAccess,
  listApiKeys,
  listApiKeyVirtualModelAccess,
} from "@llmingress/db/console-api-keys";
import Link from "next/link";
import { ConsoleDialog } from "../_components/console-dialog";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { EmptyState } from "../_components/empty-state";
import { FlatIcon } from "../_components/flat-icon";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref } from "../_lib/pagination";
import {
  type ConsoleSearchParams,
  findApiKeyLimit,
  formatDeltaTone,
  groupByApiKeyId,
  readSingleSearchParam,
} from "./sections";

function LimitsConfigDialog({
  apiKey,
  closeHref,
  limits,
  allowedVirtualModels,
  runtime,
}: {
  apiKey: { id: string; keyPrefix: string | null; name: string };
  closeHref: string;
  limits: readonly ConsoleApiKeyLimit[];
  allowedVirtualModels: ReadonlyArray<{ id: string; displayName: string; name: string }>;
  runtime: ConsoleApiKeyLimitRuntimeSnapshot;
}) {
  const budgetLimit = findApiKeyLimit(limits, "budget");
  const rpmLimit = findApiKeyLimit(limits, "rpm");
  const tpmLimit = findApiKeyLimit(limits, "tpm");
  const concurrencyLimit = findApiKeyLimit(limits, "concurrency");
  const tokenLimit = findApiKeyLimit(limits, "token");
  const usagePercent = runtime.budgetUsagePercent;
  const usageTone = usagePercent >= 95 ? "is-danger" : usagePercent >= 80 ? "is-warn" : "";

  return (
    <ConsoleDialog
      ariaLabelledby={`limits-config-title-${apiKey.id}`}
      className="console-dialog limits-config-dialog"
      closeHref={closeHref}
      triggerId={`limits-edit-${apiKey.id}-trigger`}
    >
      <div className="console-dialog-head limits-config-head">
        <div>
          <h2 className="limits-config-title" id={`limits-config-title-${apiKey.id}`}>
            Rule configuration
          </h2>
          <p>{apiKey.name}</p>
        </div>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ConsoleMutationForm
        action="/api/api-key-limits"
        className="limits-config-form"
        fallbackError="API key limit update failed."
      >
        <input type="hidden" name="action" value="saveLimitRules" />
        <input type="hidden" name="apiKeyId" value={apiKey.id} />
        <div className="limits-form-grid">
          <div className="console-field">
            <label htmlFor={`limits-budget-${apiKey.id}`}>Cost limit (USD)</label>
            <input
              id={`limits-budget-${apiKey.id}`}
              name="budgetUsd"
              type="number"
              min="0.000001"
              step="0.000001"
              defaultValue={formatInputNumber(
                budgetLimit?.limitValue ?? defaultApiKeyLimitFormValues.budgetUsd,
              )}
              required
            />
          </div>
          <div className="console-field">
            <label htmlFor={`limits-token-${apiKey.id}`}>Token limit</label>
            <input
              id={`limits-token-${apiKey.id}`}
              name="tokenLimit"
              type="number"
              min="1"
              step="1"
              defaultValue={formatInputNumber(
                tokenLimit?.limitValue ?? defaultApiKeyLimitFormValues.tokenLimit,
              )}
              required
            />
          </div>
          <div className="console-field">
            <label htmlFor={`limits-budget-period-${apiKey.id}`}>Period</label>
            <select
              id={`limits-budget-period-${apiKey.id}`}
              name="budgetPeriod"
              defaultValue={budgetLimit?.period ?? defaultApiKeyLimitFormValues.budgetPeriod}
              required
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
        </div>
        <div className="limits-usage-block">
          <div className="usage-bar">
            <div className="usage-bar-head">
              <span>Current usage</span>
              <span>{formatUsagePercent(usagePercent)}</span>
            </div>
            <div className="usage-bar-track">
              <div
                className={`usage-bar-fill ${usageTone}`.trim()}
                style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }}
              />
            </div>
          </div>
        </div>
        <div>
          <h3 className="limits-config-subtitle">Rate limit caps</h3>
          <div className="limits-rate-grid">
            <div className="console-field">
              <label htmlFor={`limits-rpm-${apiKey.id}`}>RPM</label>
              <input
                id={`limits-rpm-${apiKey.id}`}
                name="rpm"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  rpmLimit?.limitValue ?? defaultApiKeyLimitFormValues.rpm,
                )}
                required
              />
            </div>
            <div className="console-field">
              <label htmlFor={`limits-tpm-${apiKey.id}`}>TPM</label>
              <input
                id={`limits-tpm-${apiKey.id}`}
                name="tpm"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  tpmLimit?.limitValue ?? defaultApiKeyLimitFormValues.tpm,
                )}
                required
              />
            </div>
            <div className="console-field">
              <label htmlFor={`limits-concurrency-${apiKey.id}`}>Concurrency</label>
              <input
                id={`limits-concurrency-${apiKey.id}`}
                name="concurrency"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  concurrencyLimit?.limitValue ?? defaultApiKeyLimitFormValues.concurrency,
                )}
                required
              />
            </div>
          </div>
        </div>
        <div>
          <h3 className="limits-config-subtitle">Allowed Virtual Models</h3>
          <div className="tag-row">
            {allowedVirtualModels.length === 0 ? (
              <span className="tag-chip">All virtual models</span>
            ) : (
              allowedVirtualModels.map((virtualModel) => (
                <span className="tag-chip" key={virtualModel.id}>
                  {virtualModel.name}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="limits-config-actions">
          <a className="secondary-button" href={closeHref}>
            Cancel
          </a>
          <button type="submit">
            <span>Save</span>
          </button>
        </div>
      </ConsoleMutationForm>
    </ConsoleDialog>
  );
}

function getApiKeyLimitRuntimeSnapshot(
  apiKeyId: string,
  snapshotsByApiKeyId: Map<string, ConsoleApiKeyLimitRuntimeSnapshot>,
): ConsoleApiKeyLimitRuntimeSnapshot {
  return snapshotsByApiKeyId.get(apiKeyId) ?? getEmptyApiKeyLimitRuntimeSnapshot(apiKeyId);
}

function getLimitsVisibleVirtualModels(
  access: ApiKeyVirtualModelAccess | undefined,
): ReadonlyArray<{ id: string; displayName: string; name: string }> {
  if (!access) {
    return [];
  }
  const models: Array<{ id: string; displayName: string; name: string }> = [];
  const seen = new Set<string>();
  if (access.defaultVirtualModel) {
    models.push(access.defaultVirtualModel);
    seen.add(access.defaultVirtualModel.id);
  }
  for (const virtualModel of access.allowedVirtualModels) {
    if (!seen.has(virtualModel.id)) {
      models.push(virtualModel);
      seen.add(virtualModel.id);
    }
  }
  return models;
}

function getEmptyApiKeyLimitRuntimeSnapshot(apiKeyId: string): ConsoleApiKeyLimitRuntimeSnapshot {
  return {
    apiKeyId,
    budgetUsagePercent: 0,
    currentConcurrency: 0,
    currentRpm: 0,
    currentTpm: 0,
    overLimitTodayCount: 0,
    overLimitYesterdayCount: 0,
    rateLimitHits24h: 0,
  };
}

function getLimitRuleStatus({
  enabled,
  usagePercent,
}: {
  enabled: boolean;
  usagePercent: number;
}): { className: string; label: string } {
  if (!enabled) {
    return { className: "", label: "Disabled" };
  }
  if (usagePercent >= 100) {
    return { className: "pill--danger", label: "Blocked" };
  }
  return { className: "pill--ok", label: "Normal" };
}

function formatSignedInteger(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  return String(value);
}

function formatLimitsKeyPrefix(keyPrefix: string | null): string {
  if (!keyPrefix) {
    return "No key";
  }
  if (keyPrefix.length <= 8) {
    return keyPrefix;
  }
  return `${keyPrefix.slice(0, 5)}...${keyPrefix.slice(-3)}`;
}

function formatLimitBudgetCell(limits: readonly ConsoleApiKeyLimit[]): string {
  const limit = findApiKeyLimit(limits, "budget");
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `$${limit.limitValue.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatLimitNumericCell(
  limits: readonly ConsoleApiKeyLimit[],
  limitType: ConsoleApiKeyLimit["limitType"],
): string {
  const limit = findApiKeyLimit(limits, limitType);
  if (!limit?.enabled) {
    return "Not configured";
  }
  return formatInteger(limit.limitValue);
}

function formatUsagePercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatInputNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
export async function LimitsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const selectedApiKeyId = readSingleSearchParam(searchParams.selected);
  const dialogApiKeyId = readSingleSearchParam(searchParams.limitDialog);
  const query = readSingleSearchParam(searchParams.q)?.trim() ?? "";
  const [apiKeys, apiKeyLimits, runtimeSnapshots, apiKeyVirtualModelAccess] = await Promise.all([
    listApiKeys(),
    listApiKeyLimits(),
    listApiKeyLimitRuntimeSnapshots(),
    listApiKeyVirtualModelAccess(),
  ]);
  const apiKeyLimitsByApiKeyId = groupByApiKeyId(apiKeyLimits);
  const runtimeByApiKeyId = new Map(
    runtimeSnapshots.map((snapshot) => [snapshot.apiKeyId, snapshot]),
  );
  const accessById = new Map(apiKeyVirtualModelAccess.map((access) => [access.apiKeyId, access]));

  const ruleApiKeys = apiKeys.filter(
    (apiKey) => (apiKeyLimitsByApiKeyId.get(apiKey.id) ?? []).length > 0,
  );
  const selectedApiKey = selectedApiKeyId
    ? (apiKeys.find((apiKey) => apiKey.id === selectedApiKeyId) ?? null)
    : null;
  const dialogApiKey = dialogApiKeyId
    ? (apiKeys.find((apiKey) => apiKey.id === dialogApiKeyId) ?? null)
    : null;

  const rows = ruleApiKeys.map((apiKey) => {
    const limits = apiKeyLimitsByApiKeyId.get(apiKey.id) ?? [];
    const summaries = formatApiKeyLimitSummaries(limits);
    const runtime = getApiKeyLimitRuntimeSnapshot(apiKey.id, runtimeByApiKeyId);
    const budgetUsagePercent = runtime.budgetUsagePercent;
    const status = getLimitRuleStatus({
      enabled: apiKey.enabled,
      usagePercent: budgetUsagePercent,
    });
    return { apiKey, budgetUsagePercent, limits, runtime, status, summaries };
  });
  const filteredRows = query
    ? rows.filter((row) => {
        const normalizedQuery = query.toLowerCase();
        return (
          row.apiKey.name.toLowerCase().includes(normalizedQuery) ||
          (row.apiKey.keyPrefix?.toLowerCase().includes(normalizedQuery) ?? false)
        );
      })
    : rows;

  const overLimitTodayCount = runtimeSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.overLimitTodayCount,
    0,
  );
  const overLimitYesterdayCount = runtimeSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.overLimitYesterdayCount,
    0,
  );
  const rateLimitHits24h = runtimeSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.rateLimitHits24h,
    0,
  );
  const nearBudgetCount = rows.filter((row) => row.budgetUsagePercent >= 100).length;
  const dialogLimits = dialogApiKey ? (apiKeyLimitsByApiKeyId.get(dialogApiKey.id) ?? []) : [];
  const dialogRuntime = dialogApiKey
    ? getApiKeyLimitRuntimeSnapshot(dialogApiKey.id, runtimeByApiKeyId)
    : null;
  const dialogCloseHref = buildQueryHref(searchParams, { limitDialog: undefined });

  return (
    <section className="limits-dashboard" aria-label="Limits">
      <div className="limits-main">
        <div className="limits-left-column">
          <div className="stat-grid limits-kpi-grid">
            <StatCard
              icon="R"
              label="Configured rules"
              value={String(rows.length)}
              delta="API Key"
            />
            <StatCard
              icon="!"
              label="Over-limit today"
              value={String(overLimitTodayCount)}
              delta={`vs yesterday ${formatSignedInteger(overLimitTodayCount - overLimitYesterdayCount)}`}
              deltaTone={formatDeltaTone(overLimitTodayCount, overLimitYesterdayCount, "down-good")}
            />
            <StatCard
              icon="B"
              label="Keys near budget"
              value={String(nearBudgetCount)}
              delta="At configured limit"
            />
            <StatCard
              icon="L"
              label="Rate limit hits"
              value={String(rateLimitHits24h)}
              delta="Last 24h"
            />
          </div>
          <div className="limits-toolbar">
            <form className="limits-search-form" action="/limits" method="get">
              {selectedApiKey ? (
                <input type="hidden" name="selected" value={selectedApiKey.id} />
              ) : null}
              <label className="sr-only" htmlFor="limits-search">
                Search limit rules
              </label>
              <input
                id="limits-search"
                name="q"
                type="search"
                defaultValue={query}
                placeholder="Search by name or key prefix"
              />
              <button type="submit">
                <span>Search</span>
              </button>
            </form>
          </div>
          <div className="limits-rule-card">
            <h2 className="limits-section-title">Limit Rules</h2>
            <div className="data-table-wrap limits-rule-table-wrap">
              <table className="data-table bounded-table limits-rule-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>API Key</th>
                    <th className="num">Budget</th>
                    <th className="num">Tokens</th>
                    <th className="num">RPM</th>
                    <th className="num">TPM</th>
                    <th className="num">Concurrency</th>
                    <th className="num">Usage</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={10}>
                        {apiKeys.length === 0 ? (
                          <EmptyState
                            title="No limits configured"
                            description="Add budget, token, RPM, TPM, and concurrency rules to an API key."
                            action={
                              <Link className="empty-state-action" href="/api-keys?apiKeyDialog=new">
                                Create an API Key and enable limits
                              </Link>
                            }
                          />
                        ) : query ? (
                          <EmptyState title="No limit rules match the search" />
                        ) : (
                          <EmptyState
                            title="No limit rules configured"
                            description="Edit an API key to enable budget, token, RPM, TPM, and concurrency rules."
                            action={
                              <Link className="empty-state-action" href="/api-keys">
                                API Keys page
                              </Link>
                            }
                          />
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const editHref = buildQueryHref(searchParams, {
                        limitDialog: row.apiKey.id,
                        selected: row.apiKey.id,
                      });
                      return (
                        <tr
                          key={row.apiKey.id}
                          className={selectedApiKey?.id === row.apiKey.id ? "is-selected" : undefined}
                        >
                          <td>{row.apiKey.name}</td>
                          <td className="mono">{formatLimitsKeyPrefix(row.apiKey.keyPrefix)}</td>
                          <td className="num">{formatLimitBudgetCell(row.limits)}</td>
                          <td className="num">{formatLimitNumericCell(row.limits, "token")}</td>
                          <td className="num">{formatLimitNumericCell(row.limits, "rpm")}</td>
                          <td className="num">{formatLimitNumericCell(row.limits, "tpm")}</td>
                          <td className="num">
                            {formatLimitNumericCell(row.limits, "concurrency")}
                          </td>
                          <td className="num">{formatUsagePercent(row.budgetUsagePercent)}</td>
                          <td>
                            <span className={`pill limits-status-pill ${row.status.className}`}>
                              {row.status.label}
                            </span>
                          </td>
                          <td className="limits-rule-action-cell">
                            <span className="api-key-table-actions">
                              <a
                                aria-label={`Edit ${row.apiKey.name}`}
                                className="link-button api-key-action-edit row-action-button"
                                href={editHref}
                                id={`limits-edit-${row.apiKey.id}-trigger`}
                                title="Edit"
                              >
                                <FlatIcon name="edit" />
                              </a>
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {dialogApiKey ? (
        <LimitsConfigDialog
          apiKey={dialogApiKey}
          closeHref={dialogCloseHref}
          limits={dialogLimits}
          allowedVirtualModels={getLimitsVisibleVirtualModels(accessById.get(dialogApiKey.id))}
          runtime={dialogRuntime ?? getEmptyApiKeyLimitRuntimeSnapshot(dialogApiKey.id)}
        />
      ) : null}
    </section>
  );
}

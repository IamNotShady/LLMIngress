import {
  type ConsoleAgentLimit,
  type ConsoleAgentLimitRuntimeSnapshot,
  defaultAgentLimitFormValues,
  formatAgentLimitSummaries,
  listAgentLimitRuntimeSnapshots,
  listAgentLimits,
} from "@llmingress/db/console-agent-limits";
import {
  type AgentVirtualModelAccess,
  listAgents,
  listAgentVirtualModelAccess,
} from "@llmingress/db/console-agents";
import { ConsoleDialog } from "../_components/console-dialog";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref } from "../_lib/pagination";
import {
  type ConsoleSearchParams,
  findAgentLimit,
  formatDeltaTone,
  groupByAgentId,
  readSingleSearchParam,
} from "./sections";

function LimitsConfigDialog({
  agent,
  closeHref,
  limits,
  allowedVirtualModels,
  runtime,
}: {
  agent: { id: string; keyPrefix: string | null; name: string };
  closeHref: string;
  limits: readonly ConsoleAgentLimit[];
  allowedVirtualModels: ReadonlyArray<{ id: string; displayName: string; name: string }>;
  runtime: ConsoleAgentLimitRuntimeSnapshot;
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tpmLimit = findAgentLimit(limits, "tpm");
  const concurrencyLimit = findAgentLimit(limits, "concurrency");
  const tokenLimit = findAgentLimit(limits, "token");
  const usagePercent = runtime.budgetUsagePercent;
  const usageTone = usagePercent >= 95 ? "is-danger" : usagePercent >= 80 ? "is-warn" : "";

  return (
    <ConsoleDialog
      ariaLabelledby={`limits-config-title-${agent.id}`}
      className="console-dialog limits-config-dialog"
      closeHref={closeHref}
      triggerId={`limits-edit-${agent.id}-trigger`}
    >
      <div className="console-dialog-head limits-config-head">
        <div>
          <h2 className="limits-config-title" id={`limits-config-title-${agent.id}`}>
            Rule configuration
          </h2>
          <p>{agent.name}</p>
        </div>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ConsoleMutationForm
        action="/api/agent-limits"
        className="limits-config-form"
        fallbackError="Agent limit update failed."
      >
        <input type="hidden" name="action" value="saveLimitRules" />
        <input type="hidden" name="agentId" value={agent.id} />
        <div className="limits-form-grid">
          <div className="console-field">
            <label htmlFor={`limits-budget-${agent.id}`}>Cost limit (USD)</label>
            <input
              id={`limits-budget-${agent.id}`}
              name="budgetUsd"
              type="number"
              min="0.000001"
              step="0.000001"
              defaultValue={formatInputNumber(
                budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd,
              )}
              required
            />
          </div>
          <div className="console-field">
            <label htmlFor={`limits-token-${agent.id}`}>Token limit</label>
            <input
              id={`limits-token-${agent.id}`}
              name="tokenLimit"
              type="number"
              min="1"
              step="1"
              defaultValue={formatInputNumber(
                tokenLimit?.limitValue ?? defaultAgentLimitFormValues.tokenLimit,
              )}
              required
            />
          </div>
          <div className="console-field">
            <label htmlFor={`limits-budget-period-${agent.id}`}>Period</label>
            <select
              id={`limits-budget-period-${agent.id}`}
              name="budgetPeriod"
              defaultValue={budgetLimit?.period ?? defaultAgentLimitFormValues.budgetPeriod}
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
              <label htmlFor={`limits-rpm-${agent.id}`}>RPM</label>
              <input
                id={`limits-rpm-${agent.id}`}
                name="rpm"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm,
                )}
                required
              />
            </div>
            <div className="console-field">
              <label htmlFor={`limits-tpm-${agent.id}`}>TPM</label>
              <input
                id={`limits-tpm-${agent.id}`}
                name="tpm"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm,
                )}
                required
              />
            </div>
            <div className="console-field">
              <label htmlFor={`limits-concurrency-${agent.id}`}>Concurrency</label>
              <input
                id={`limits-concurrency-${agent.id}`}
                name="concurrency"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  concurrencyLimit?.limitValue ?? defaultAgentLimitFormValues.concurrency,
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

function getAgentLimitRuntimeSnapshot(
  agentId: string,
  snapshotsByAgentId: Map<string, ConsoleAgentLimitRuntimeSnapshot>,
): ConsoleAgentLimitRuntimeSnapshot {
  return snapshotsByAgentId.get(agentId) ?? getEmptyAgentLimitRuntimeSnapshot(agentId);
}

function getLimitsVisibleVirtualModels(
  access: AgentVirtualModelAccess | undefined,
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

function getEmptyAgentLimitRuntimeSnapshot(agentId: string): ConsoleAgentLimitRuntimeSnapshot {
  return {
    agentId,
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

function formatLimitBudgetCell(limits: readonly ConsoleAgentLimit[]): string {
  const limit = findAgentLimit(limits, "budget");
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `$${limit.limitValue.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatLimitNumericCell(
  limits: readonly ConsoleAgentLimit[],
  limitType: ConsoleAgentLimit["limitType"],
): string {
  const limit = findAgentLimit(limits, limitType);
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
  const selectedAgentId = readSingleSearchParam(searchParams.selected);
  const dialogAgentId = readSingleSearchParam(searchParams.limitDialog);
  const query = readSingleSearchParam(searchParams.q)?.trim() ?? "";
  const [agents, agentLimits, runtimeSnapshots, agentVirtualModelAccess] = await Promise.all([
    listAgents(),
    listAgentLimits(),
    listAgentLimitRuntimeSnapshots(),
    listAgentVirtualModelAccess(),
  ]);
  const agentLimitsByAgentId = groupByAgentId(agentLimits);
  const runtimeByAgentId = new Map(
    runtimeSnapshots.map((snapshot) => [snapshot.agentId, snapshot]),
  );
  const accessById = new Map(agentVirtualModelAccess.map((access) => [access.agentId, access]));

  const ruleAgents = agents.filter(
    (agent) => (agentLimitsByAgentId.get(agent.id) ?? []).length > 0,
  );
  const selectedAgent = selectedAgentId
    ? (agents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;
  const dialogAgent = dialogAgentId
    ? (agents.find((agent) => agent.id === dialogAgentId) ?? null)
    : null;

  const rows = ruleAgents.map((agent) => {
    const limits = agentLimitsByAgentId.get(agent.id) ?? [];
    const summaries = formatAgentLimitSummaries(limits);
    const runtime = getAgentLimitRuntimeSnapshot(agent.id, runtimeByAgentId);
    const budgetUsagePercent = runtime.budgetUsagePercent;
    const status = getLimitRuleStatus({
      enabled: agent.enabled,
      usagePercent: budgetUsagePercent,
    });
    return { agent, budgetUsagePercent, limits, runtime, status, summaries };
  });
  const filteredRows = query
    ? rows.filter((row) => {
        const normalizedQuery = query.toLowerCase();
        return (
          row.agent.name.toLowerCase().includes(normalizedQuery) ||
          (row.agent.keyPrefix?.toLowerCase().includes(normalizedQuery) ?? false)
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
  const dialogLimits = dialogAgent ? (agentLimitsByAgentId.get(dialogAgent.id) ?? []) : [];
  const dialogRuntime = dialogAgent
    ? getAgentLimitRuntimeSnapshot(dialogAgent.id, runtimeByAgentId)
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
              delta="Agent API Key"
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
              {selectedAgent ? (
                <input type="hidden" name="selected" value={selectedAgent.id} />
              ) : null}
              <label className="sr-only" htmlFor="limits-search">
                Search limit rules
              </label>
              <input
                id="limits-search"
                name="q"
                type="search"
                defaultValue={query}
                placeholder="Search Agent or API Key prefix"
              />
            </form>
          </div>
          <div className="limits-rule-card">
            <h2 className="limits-section-title">Limit Rules</h2>
            <div className="data-table-wrap limits-rule-table-wrap">
              <table className="data-table limits-rule-table">
                <thead>
                  <tr>
                    <th>Agent</th>
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
                        {agents.length === 0 ? (
                          <>
                            <a className="empty-state-action" href="/agents?agentDialog=new">
                              Create an Agent and enable limits
                            </a>{" "}
                            to add budget, token, RPM, TPM, and concurrency rules.
                          </>
                        ) : query ? (
                          "No limit rules match the search."
                        ) : (
                          <>
                            No limit rules configured. Edit an Agent from the{" "}
                            <a className="empty-state-action" href="/agents">
                              Agents page
                            </a>{" "}
                            to enable them.
                          </>
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const editHref = buildQueryHref(searchParams, {
                        limitDialog: row.agent.id,
                        selected: row.agent.id,
                      });
                      return (
                        <tr
                          key={row.agent.id}
                          className={selectedAgent?.id === row.agent.id ? "is-selected" : undefined}
                        >
                          <td>{row.agent.name}</td>
                          <td className="mono">{formatLimitsKeyPrefix(row.agent.keyPrefix)}</td>
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
                            <span className="agent-table-actions">
                              <a
                                aria-label={`Edit ${row.agent.name}`}
                                className="link-button agent-action-edit row-action-button"
                                href={editHref}
                                id={`limits-edit-${row.agent.id}-trigger`}
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
      {dialogAgent ? (
        <LimitsConfigDialog
          agent={dialogAgent}
          closeHref={dialogCloseHref}
          limits={dialogLimits}
          allowedVirtualModels={getLimitsVisibleVirtualModels(accessById.get(dialogAgent.id))}
          runtime={dialogRuntime ?? getEmptyAgentLimitRuntimeSnapshot(dialogAgent.id)}
        />
      ) : null}
    </section>
  );
}

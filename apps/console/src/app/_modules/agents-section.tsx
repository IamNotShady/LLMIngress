import { gatewayPublicBaseUrl } from "@llmingress/config";
import {
  type ConsoleAgentLimit,
  defaultAgentLimitFormValues,
} from "@llmingress/db/console-agent-limits";
import type { AgentVirtualModelAccess, ConsoleAgent } from "@llmingress/db/console-agents";
import { formatConsoleCompactCount, formatConsoleUsd } from "@llmingress/db/console-format";
import type { ConsoleVirtualModel } from "@llmingress/db/console-virtual-models";
import { ConsoleDialog } from "../_components/console-dialog";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref } from "../_lib/pagination";
import { AgentCreateDialogClient } from "./agent-create-dialog-client";
import {
  AGENT_API_KEY_PLACEHOLDER,
  groupAgentVirtualModelEndpoints,
} from "./agent-integration-guide";
import { AgentIntegrationGuideTabs } from "./agent-integration-guide-tabs";
import { AgentVirtualModelFields } from "./agent-virtual-model-fields";
import { loadAgentsSectionData } from "./agents-section-data";
import {
  type ConsoleSearchParams,
  findAgentLimit,
  formatRouteEndpointProtocolLabel,
  groupByAgentId,
  readSingleSearchParam,
} from "./sections";

function AgentViewDialog({
  access,
  agent,
  closeHref,
  limits,
}: {
  access: AgentVirtualModelAccess | null;
  agent: ConsoleAgent;
  closeHref: string;
  limits: readonly ConsoleAgentLimit[];
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tokenLimit = findAgentLimit(limits, "token");
  const tpmLimit = findAgentLimit(limits, "tpm");
  const gatewayBaseUrl = gatewayPublicBaseUrl();
  const allowedVirtualModels = access?.allowedVirtualModels ?? [];
  const endpointGroups = groupAgentVirtualModelEndpoints({
    gatewayBaseUrl,
    virtualModels: allowedVirtualModels,
  });
  const guideModel =
    access?.defaultVirtualModel?.name ?? allowedVirtualModels[0]?.name ?? "<Virtual Model Name>";

  return (
    <ConsoleDialog
      ariaLabelledby={`agent-view-dialog-title-${agent.id}`}
      className="console-dialog agent-view-dialog"
      closeHref={closeHref}
      initialFocus="close"
      triggerId={`agent-view-${agent.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id={`agent-view-dialog-title-${agent.id}`}>{agent.name}</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <div className="agent-view-columns">
        <div className="agent-view-column">
          <dl className="agent-detail-fields">
            <div>
              <dt>Created</dt>
              <dd>{formatAgentDetailDate(agent.createdAt)}</dd>
            </div>
            <div>
              <dt>Enabled</dt>
              <dd>{agent.enabled ? "True" : "False"}</dd>
            </div>
            <div>
              <dt>Default model</dt>
              <dd>{access?.defaultVirtualModel?.name ?? "None"}</dd>
            </div>
          </dl>
          <section className="agent-detail-section">
            <h3>Budget / Limit</h3>
            <div className="agent-limit-row">
              <span>Budget</span>
              <strong>{formatAgentBudgetLimit(budgetLimit)}</strong>
            </div>
            <div className="agent-limit-row">
              <span>RPM</span>
              <strong>{formatAgentNumericLimit(rpmLimit)}</strong>
            </div>
            <div className="agent-limit-row">
              <span>TPM</span>
              <strong>{formatAgentNumericLimit(tpmLimit)}</strong>
            </div>
            <div className="agent-limit-row">
              <span>Token limit</span>
              <strong>{formatAgentTokenLimit(tokenLimit)}</strong>
            </div>
          </section>
        </div>
        <div className="agent-view-column">
          <section className="agent-detail-section">
            <h3>Endpoints</h3>
            {allowedVirtualModels.length === 0 ? (
              <p>No Virtual Models are allowed for this Agent.</p>
            ) : null}
            {endpointGroups.configured.map((group) => (
              <div className="agent-endpoint-group" key={group.protocol}>
                <p className="agent-endpoint-url mono">{group.url}</p>
                <p className="agent-endpoint-protocol">
                  {formatRouteEndpointProtocolLabel(group.protocol)}
                </p>
                <div className="agent-chip-list">
                  {group.virtualModels.map((virtualModel) => (
                    <span className="agent-chip" key={virtualModel.id}>
                      {virtualModel.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {endpointGroups.unrouted.length > 0 ? (
              <div className="agent-endpoint-group agent-endpoint-group-unrouted">
                <p className="agent-endpoint-url">No route policy configured</p>
                <div className="agent-chip-list">
                  {endpointGroups.unrouted.map((virtualModel) => (
                    <span className="agent-chip" key={virtualModel.id}>
                      {virtualModel.name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <section className="agent-detail-section">
        <h3>Integration guide</h3>
        <AgentIntegrationGuideTabs
          apiKey={AGENT_API_KEY_PLACEHOLDER}
          gatewayBaseUrl={gatewayBaseUrl}
          idPrefix={`agent-view-${agent.id}`}
          keyPrefix={agent.keyPrefix}
          model={guideModel}
        />
      </section>
    </ConsoleDialog>
  );
}

function AgentCreateDialog({
  closeHref,
  virtualModels,
}: {
  closeHref: string;
  virtualModels: readonly ConsoleVirtualModel[];
}) {
  return (
    <AgentCreateDialogClient closeHref={closeHref}>
      <input type="hidden" name="action" value="create" />
      <label htmlFor="agent-name">Agent name</label>
      <input id="agent-name" name="name" required />
      <AgentVirtualModelFields
        idPrefix="agent"
        initialSelectedVirtualModelIds={[]}
        virtualModels={virtualModels.map(({ id, name }) => ({ id, name }))}
      />
      <label className="checkbox-label agent-limit-toggle" htmlFor="agent-enable-limits">
        <input id="agent-enable-limits" name="enableLimits" type="checkbox" value="true" />
        <span>Enable limits</span>
      </label>
      <div className="agent-create-limit-fields">
        <label htmlFor="agent-budget-usd">Budget USD limit</label>
        <input
          id="agent-budget-usd"
          name="budgetUsd"
          type="number"
          min="0.000001"
          step="0.000001"
          defaultValue={defaultAgentLimitFormValues.budgetUsd}
        />
        <label htmlFor="agent-budget-period">Budget period</label>
        <select
          id="agent-budget-period"
          name="budgetPeriod"
          defaultValue={defaultAgentLimitFormValues.budgetPeriod}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
        <label htmlFor="agent-rpm">RPM limit</label>
        <input
          id="agent-rpm"
          name="rpm"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultAgentLimitFormValues.rpm}
        />
        <label htmlFor="agent-tpm">TPM limit</label>
        <input
          id="agent-tpm"
          name="tpm"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultAgentLimitFormValues.tpm}
        />
        <label htmlFor="agent-concurrency">Concurrency limit</label>
        <input
          id="agent-concurrency"
          name="concurrency"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultAgentLimitFormValues.concurrency}
        />
        <label htmlFor="agent-token-limit">Token limit</label>
        <input
          id="agent-token-limit"
          name="tokenLimit"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultAgentLimitFormValues.tokenLimit}
        />
      </div>
    </AgentCreateDialogClient>
  );
}

function AgentEditDialog({
  access,
  agent,
  closeHref,
  limits,
  virtualModels,
}: {
  access: AgentVirtualModelAccess;
  agent: ConsoleAgent;
  closeHref: string;
  limits: readonly ConsoleAgentLimit[];
  virtualModels: readonly ConsoleVirtualModel[];
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const concurrencyLimit = findAgentLimit(limits, "concurrency");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tokenLimit = findAgentLimit(limits, "token");
  const tpmLimit = findAgentLimit(limits, "tpm");
  const limitsEnabled = agent.limitsEnabled;

  return (
    <ConsoleDialog
      ariaLabelledby={`agent-dialog-title-${agent.id}`}
      className="console-dialog"
      closeHref={closeHref}
      triggerId={`agent-edit-${agent.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id={`agent-dialog-title-${agent.id}`}>Edit {agent.name}</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ConsoleMutationForm
        action="/api/agents"
        className="provider-edit-form"
        fallbackError="Agent update failed."
      >
        <input type="hidden" name="action" value="saveAll" />
        <input type="hidden" name="id" value={agent.id} />
        <label htmlFor={`agent-name-${agent.id}`}>Agent name</label>
        <input id={`agent-name-${agent.id}`} name="name" defaultValue={agent.name} required />
        <AgentVirtualModelFields
          idPrefix={`agent-${agent.id}`}
          initialDefaultVirtualModelId={access.defaultVirtualModel?.id ?? ""}
          initialSelectedVirtualModelIds={access.allowedVirtualModels.map(
            (virtualModel) => virtualModel.id,
          )}
          virtualModels={virtualModels.map(({ id, name }) => ({ id, name }))}
        />
        <label
          className="checkbox-label agent-limit-toggle"
          htmlFor={`agent-enable-limits-${agent.id}`}
        >
          <input
            id={`agent-enable-limits-${agent.id}`}
            name="enableLimits"
            type="checkbox"
            value="true"
            defaultChecked={limitsEnabled}
          />
          <span>Enable limits</span>
        </label>
        <div className="agent-limit-fields">
          <label htmlFor={`agent-budget-usd-${agent.id}`}>Budget USD limit</label>
          <input
            id={`agent-budget-usd-${agent.id}`}
            name="budgetUsd"
            type="number"
            min="0.000001"
            step="0.000001"
            defaultValue={budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd}
            required
          />
          <label htmlFor={`agent-budget-period-${agent.id}`}>Budget period</label>
          <select
            id={`agent-budget-period-${agent.id}`}
            name="budgetPeriod"
            defaultValue={budgetLimit?.period ?? defaultAgentLimitFormValues.budgetPeriod}
            required
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
          <label htmlFor={`agent-rpm-${agent.id}`}>RPM limit</label>
          <input
            id={`agent-rpm-${agent.id}`}
            name="rpm"
            type="number"
            min="1"
            step="1"
            defaultValue={rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm}
            required
          />
          <label htmlFor={`agent-tpm-${agent.id}`}>TPM limit</label>
          <input
            id={`agent-tpm-${agent.id}`}
            name="tpm"
            type="number"
            min="1"
            step="1"
            defaultValue={tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm}
            required
          />
          <label htmlFor={`agent-concurrency-${agent.id}`}>Concurrency limit</label>
          <input
            id={`agent-concurrency-${agent.id}`}
            name="concurrency"
            type="number"
            min="1"
            step="1"
            defaultValue={concurrencyLimit?.limitValue ?? defaultAgentLimitFormValues.concurrency}
            required
          />
          <label htmlFor={`agent-token-limit-${agent.id}`}>Token limit</label>
          <input
            id={`agent-token-limit-${agent.id}`}
            name="tokenLimit"
            type="number"
            min="1"
            step="1"
            defaultValue={tokenLimit?.limitValue ?? defaultAgentLimitFormValues.tokenLimit}
            required
          />
        </div>
        <button type="submit">
          <span>Save</span>
        </button>
      </ConsoleMutationForm>
    </ConsoleDialog>
  );
}

function AgentDeleteDialog({ agent, closeHref }: { agent: ConsoleAgent; closeHref: string }) {
  return (
    <ConsoleDialog
      ariaLabelledby={`agent-delete-dialog-title-${agent.id}`}
      className="console-dialog agent-delete-dialog"
      closeHref={closeHref}
      initialFocus="cancel"
      triggerId={`agent-delete-${agent.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id={`agent-delete-dialog-title-${agent.id}`}>Delete {agent.name}?</h2>
      </div>
      <p>This removes the Agent and its API key.</p>
      <div className="agent-delete-actions">
        <a className="agent-delete-cancel" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Cancel</span>
        </a>
        <ConsoleMutationForm action="/api/agents" fallbackError="Agent deletion failed.">
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="id" value={agent.id} />
          <button className="agent-delete-confirm" type="submit">
            <FlatIcon name="delete" />
            <span>Delete</span>
          </button>
        </ConsoleMutationForm>
      </div>
    </ConsoleDialog>
  );
}

function AgentEnabledToggleForm({ agent }: { agent: ConsoleAgent }) {
  if (agent.enabled) {
    return (
      <ConsoleMutationForm
        action="/api/agents"
        errorPresentation="toast"
        fallbackError="Agent disable failed."
      >
        <input type="hidden" name="action" value="disable" />
        <input type="hidden" name="id" value={agent.id} />
        <button
          aria-label={`Disable ${agent.name}`}
          className="agent-action-toggle row-action-button"
          title="Disable"
          type="submit"
        >
          <FlatIcon name="disable" />
        </button>
      </ConsoleMutationForm>
    );
  }

  return (
    <ConsoleMutationForm
      action="/api/agents"
      errorPresentation="toast"
      fallbackError="Agent enable failed."
    >
      <input type="hidden" name="action" value="enable" />
      <input type="hidden" name="id" value={agent.id} />
      <button
        aria-label={`Enable ${agent.name}`}
        className="agent-action-toggle row-action-button"
        title="Enable"
        type="submit"
      >
        <FlatIcon name="enable" />
      </button>
    </ConsoleMutationForm>
  );
}

function filterAgents(agents: ConsoleAgent[], filters: { agentSearch: string }): ConsoleAgent[] {
  const normalizedSearch = filters.agentSearch.toLowerCase();
  if (!normalizedSearch) {
    return agents;
  }
  return agents.filter((agent) =>
    [agent.name, agent.keyPrefix ?? ""].some((value) =>
      value.toLowerCase().includes(normalizedSearch),
    ),
  );
}

function formatAgentKeyPrefixDisplay(keyPrefix: string): string {
  return keyPrefix.length <= 8 ? keyPrefix : `${keyPrefix.slice(0, 6)}...${keyPrefix.slice(-4)}`;
}

function formatAgentDetailDate(value: Date): string {
  return value.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatAgentBudgetLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `$${limit.limitValue.toLocaleString()} / ${limit.period}`;
}

function formatAgentNumericLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `${formatConsoleCompactCount(limit.limitValue)} / ${limit.period}`;
}

function formatAgentTokenLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `${formatConsoleCompactCount(limit.limitValue)} / ${limit.period}`;
}

export async function AgentsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const { agentLimits, agentVirtualModelAccess, agents, usageToday, virtualModels } =
    await loadAgentsSectionData();
  const agentVirtualModelAccessByAgentId = new Map(
    agentVirtualModelAccess.map((access) => [access.agentId, access]),
  );
  const agentLimitsByAgentId = groupByAgentId(agentLimits);
  const enabledAgentCount = agents.filter((agent) => agent.enabled).length;
  const usageTodayByAgentId = new Map(usageToday.agentBreakdowns.map((agent) => [agent.id, agent]));
  const agentSearch = readSingleSearchParam(searchParams.agentSearch)?.trim() ?? "";
  const visibleAgents = filterAgents(agents, { agentSearch });
  const selectedAgentId = readSingleSearchParam(searchParams.selected);
  const agentView = readSingleSearchParam(searchParams.agentView);
  const viewDialogAgent = agents.find((agent) => agent.id === agentView) ?? null;
  const viewDialogAccess = viewDialogAgent
    ? (agentVirtualModelAccessByAgentId.get(viewDialogAgent.id) ?? null)
    : null;
  const viewDialogLimits = viewDialogAgent
    ? (agentLimitsByAgentId.get(viewDialogAgent.id) ?? [])
    : [];
  const agentViewCloseHref = buildQueryHref(searchParams, { agentView: undefined });
  const agentDialog = readSingleSearchParam(searchParams.agentDialog);
  const editDialogAgent = agents.find((agent) => agent.id === agentDialog) ?? null;
  const agentDialogCloseHref = buildQueryHref(searchParams, {
    agentDialog: undefined,
    agentView: undefined,
  });
  const deleteAgent = readSingleSearchParam(searchParams.deleteAgent);
  const deleteDialogAgent = agents.find((agent) => agent.id === deleteAgent) ?? null;
  const deleteDialogCloseHref = buildQueryHref(searchParams, {
    agentView: undefined,
    deleteAgent: undefined,
  });

  return (
    <section className="agents-dashboard" aria-label="Agents">
      <div className="agents-shell">
        <div className="agents-main-column">
          <div className="stat-grid agents-stat-grid">
            <StatCard icon="AG" label="Agents" value={String(agents.length)} />
            <StatCard icon="ON" label="Enabled" value={String(enabledAgentCount)} />
            <StatCard
              icon="RQ"
              label="Requests 24h"
              value={formatConsoleCompactCount(usageToday.requestCount)}
            />
            <StatCard icon="$" label="Cost 24h" value={formatConsoleUsd(usageToday.totalCostUsd)} />
          </div>
          <form action="/agents" method="get">
            <fieldset className="agents-filter-bar">
              <legend className="sr-only">Agent filters</legend>
              <div className="console-field agents-search-field">
                <label htmlFor="agent-filter-search" className="sr-only">
                  Search
                </label>
                <input
                  id="agent-filter-search"
                  name="agentSearch"
                  defaultValue={agentSearch}
                  placeholder="Search agent name or note"
                />
              </div>
              <div className="agents-filter-actions">
                <button type="submit">
                  <span>Filter</span>
                </button>
              </div>
            </fieldset>
          </form>
          <div className="chart-card agents-list-card">
            <h2 className="chart-card-title">Agent list</h2>
            {agents.length === 0 ? (
              <p>
                <a className="empty-state-action" href="?agentDialog=new">
                  Create an Agent
                </a>{" "}
                to issue an API key and grant Virtual Model access.
              </p>
            ) : visibleAgents.length === 0 ? (
              <p>No agents match the selected filters.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table bounded-table agents-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>API Key Prefix</th>
                      <th>Default Virtual Model</th>
                      <th>Virtual Models</th>
                      <th className="num">Requests 24h</th>
                      <th className="num">24h Cost</th>
                      <th>Enabled</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAgents.map((agent) => {
                      const access = agentVirtualModelAccessByAgentId.get(agent.id);
                      const usage = usageTodayByAgentId.get(agent.id);
                      const agentViewHref = buildQueryHref(searchParams, {
                        agentDialog: undefined,
                        agentView: agent.id,
                        deleteAgent: undefined,
                        selected: agent.id,
                      });
                      const isSelectedAgent =
                        agent.id === selectedAgentId || agent.id === viewDialogAgent?.id;
                      return (
                        <tr
                          className={isSelectedAgent ? "is-selected" : "is-clickable"}
                          key={agent.id}
                        >
                          <td>
                            <a
                              className="table-row-link"
                              href={agentViewHref}
                              id={`agent-view-${agent.id}-trigger`}
                            >
                              {agent.name}
                            </a>
                          </td>
                          <td className="mono">
                            <a className="table-row-link" href={agentViewHref}>
                              {agent.keyPrefix
                                ? formatAgentKeyPrefixDisplay(agent.keyPrefix)
                                : "No key"}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={agentViewHref}>
                              {access?.defaultVirtualModel?.name ?? "None"}
                            </a>
                          </td>
                          <td>
                            <a
                              className="agent-virtual-model-names table-row-link"
                              href={agentViewHref}
                              title={
                                access?.allowedVirtualModels
                                  .map((model) => model.name)
                                  .join(", ") || "None"
                              }
                            >
                              {access?.allowedVirtualModels.map((model) => model.name).join(", ") ||
                                "None"}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={agentViewHref}>
                              {formatConsoleCompactCount(usage?.requestCount ?? 0)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={agentViewHref}>
                              {formatConsoleUsd(usage?.totalCostUsd ?? null)}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={agentViewHref}>
                              {agent.enabled ? "True" : "False"}
                            </a>
                          </td>
                          <td>
                            <span className="agent-table-actions">
                              <AgentEnabledToggleForm agent={agent} />
                              <a
                                aria-label={`Edit ${agent.name}`}
                                className="link-button agent-action-edit row-action-button"
                                href={buildQueryHref(searchParams, {
                                  agentDialog: agent.id,
                                  agentView: undefined,
                                })}
                                id={`agent-edit-${agent.id}-trigger`}
                                title="Edit"
                              >
                                <FlatIcon name="edit" />
                              </a>
                              <a
                                aria-label={`Delete ${agent.name}`}
                                className="link-button agent-action-delete row-action-button row-action-danger"
                                href={buildQueryHref(searchParams, {
                                  agentDialog: undefined,
                                  agentView: undefined,
                                  deleteAgent: agent.id,
                                })}
                                id={`agent-delete-${agent.id}-trigger`}
                                title="Delete"
                              >
                                <FlatIcon name="delete" />
                              </a>
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
      </div>
      {viewDialogAgent ? (
        <AgentViewDialog
          access={viewDialogAccess}
          agent={viewDialogAgent}
          closeHref={agentViewCloseHref}
          limits={viewDialogLimits}
        />
      ) : null}
      {agentDialog === "new" ? (
        <AgentCreateDialog closeHref={agentDialogCloseHref} virtualModels={virtualModels} />
      ) : null}
      {editDialogAgent ? (
        <AgentEditDialog
          agent={editDialogAgent}
          access={
            agentVirtualModelAccessByAgentId.get(editDialogAgent.id) ?? {
              agentId: editDialogAgent.id,
              allowedVirtualModels: [],
              defaultVirtualModel: null,
            }
          }
          closeHref={agentDialogCloseHref}
          limits={agentLimitsByAgentId.get(editDialogAgent.id) ?? []}
          virtualModels={virtualModels}
        />
      ) : null}
      {deleteDialogAgent ? (
        <AgentDeleteDialog agent={deleteDialogAgent} closeHref={deleteDialogCloseHref} />
      ) : null}
    </section>
  );
}

import {
  formatConsoleCompactCount,
  formatConsoleUsd,
  MISSING_VALUE,
} from "@llmingress/db/console-format";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import {
  buildRoutePolicyHealthWarnings,
  type ConsoleProviderModelOption,
  type ConsoleRoutePolicy,
  filterRoutePolicyEditorHealthyProviderModelOptions,
  listProviderModelOptions,
  listRoutePolicies,
  routePolicyStrategies,
} from "@llmingress/db/console-route-policies";
import {
  type ConsoleVirtualModel,
  listVirtualModelFallbackBreakdown,
  listVirtualModels,
} from "@llmingress/db/console-virtual-models";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { FlatIcon } from "../_components/flat-icon";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref } from "../_lib/pagination";
import {
  buildRoutePolicyHealthWarningCandidates,
  type ConsoleSearchParams,
  failureRateTone,
  formatRouteEndpointProtocolLabel,
  orderProviderModelsForConsole,
  readSingleSearchParam,
  toneToNumClass,
} from "./sections";
import { VirtualModelRouteDialogClient } from "./virtual-model-route-dialog";

function VirtualModelViewDialog({
  closeHref,
  fallbackOverview,
  routePolicy,
  routePolicyWarnings,
  virtualModel,
}: {
  closeHref: string;
  fallbackOverview: Awaited<ReturnType<typeof listVirtualModelFallbackBreakdown>>;
  routePolicy: ConsoleRoutePolicy | null;
  routePolicyWarnings: readonly string[];
  virtualModel: ConsoleVirtualModel;
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby={`virtual-model-view-dialog-title-${virtualModel.id}`}
        aria-modal="true"
        className="console-dialog agent-view-dialog vm-view-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <div className="agent-view-dialog-title">
            <h2 id={`virtual-model-view-dialog-title-${virtualModel.id}`}>{virtualModel.name}</h2>
            {virtualModel.enabled ? (
              <span className="pill--ok pill">Enabled</span>
            ) : (
              <span className="pill">Disabled</span>
            )}
          </div>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <dl className="agent-detail-fields">
          <div>
            <dt>Strategy</dt>
            <dd>{routePolicy ? formatRouteStrategyLabel(routePolicy.strategy) : MISSING_VALUE}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{formatRouteEndpointProtocolLabel(routePolicy?.endpointProtocol ?? "")}</dd>
          </div>
          <div>
            <dt>Candidates</dt>
            <dd>{routePolicy ? `${routePolicy.candidates.length} models` : MISSING_VALUE}</dd>
          </div>
          <div>
            <dt>Default hit</dt>
            <dd>{formatDefaultCandidate(routePolicy)}</dd>
          </div>
          <div>
            <dt>Requests 24h</dt>
            <dd>{formatConsoleCompactCount(virtualModel.requestCount24h)}</dd>
          </div>
          <div>
            <dt>Cost 24h</dt>
            <dd>{formatVirtualModelCost(virtualModel.cost24hUsd)}</dd>
          </div>
          <div>
            <dt>Failure rate total</dt>
            <dd>
              {formatVirtualModelFailureRate(
                virtualModel.requestCountTotal,
                virtualModel.failureCountTotal,
              )}
            </dd>
          </div>
        </dl>
        <section className="agent-detail-section">
          <h3>Candidates</h3>
          {routePolicy?.candidates.length ? (
            <div className="vm-candidate-list">
              {routePolicy.candidates.map((candidate) => (
                <div className="vm-candidate-card" key={candidate.id}>
                  <div>
                    <strong>
                      {candidate.providerDisplayName} / {candidate.modelDisplayName}
                    </strong>
                    <span>
                      {formatModelPrice(candidate.inputUsdPerMillionTokens)} /{" "}
                      {formatModelPrice(candidate.outputUsdPerMillionTokens)}
                    </span>
                  </div>
                  {candidate.availability === "available" ? (
                    <span className="pill--ok pill">Available</span>
                  ) : (
                    <span className="pill">Disabled</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p>No candidates configured.</p>
          )}
        </section>
        {routePolicyWarnings.length > 0 ? (
          <section className="agent-detail-section" aria-label="Route warnings">
            <h3>Route warnings</h3>
            {routePolicyWarnings.map((warning) => (
              <p className="route-warning" key={warning}>
                {warning}
              </p>
            ))}
          </section>
        ) : null}
        <section className="agent-detail-section">
          <h3>Fallback overview</h3>
          {fallbackOverview.length > 0 ? (
            <DonutBreakdown
              ariaLabel="Fallback overview"
              data={fallbackOverview}
              valueFormat="percent"
            />
          ) : (
            <p>No fallback data recorded in the last 24h.</p>
          )}
        </section>
      </section>
    </>
  );
}

function VirtualModelRouteDialog({
  closeHref,
  mode,
  providerModelOptions,
  routePolicy,
  virtualModel,
}: {
  closeHref: string;
  mode: "create" | "edit";
  providerModelOptions: readonly ConsoleProviderModelOption[];
  routePolicy: ConsoleRoutePolicy | null;
  virtualModel: ConsoleVirtualModel | null;
}) {
  return (
    <VirtualModelRouteDialogClient
      closeHref={closeHref}
      mode={mode}
      providerModelOptions={[...providerModelOptions]}
      routePolicy={routePolicy}
      virtualModel={virtualModel}
    />
  );
}

function formatDefaultCandidate(routePolicy: ConsoleRoutePolicy | null | undefined): string {
  return routePolicy?.candidates[0]?.modelDisplayName ?? MISSING_VALUE;
}

function parseUsd(value: number | string | null): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatVirtualModelCost(value: number | string | null): string {
  return formatConsoleUsd(parseUsd(value));
}

function formatVirtualModelFailureRate(
  requestCount: number,
  failureCount: number,
  digits = 1,
): string {
  if (requestCount <= 0) {
    return `${(0).toFixed(digits)}%`;
  }
  return `${((failureCount / requestCount) * 100).toFixed(digits)}%`;
}

function formatRouteStrategyLabel(strategy: string): string {
  if (strategy === "cost_first") {
    return "Cost First";
  }
  if (strategy === "quality_first") {
    return "Quality First";
  }
  if (strategy === "random") {
    return "Random";
  }
  return strategy.charAt(0).toUpperCase() + strategy.slice(1);
}

function formatModelPrice(price: number | null): string {
  if (price === null) {
    return "Unknown";
  }
  const digits = price >= 1 ? 2 : 4;
  return `$${price.toFixed(digits)}`;
}
export async function VirtualModelsSection({
  searchParams,
}: {
  searchParams: ConsoleSearchParams;
}) {
  const virtualModels = await listVirtualModels();
  const routePolicies = await listRoutePolicies();
  const providerHealthSummaries = await listConsoleProviderHealthSummaries();
  const providerHealthByProviderId = new Map(
    providerHealthSummaries.map((summary) => [summary.id, summary]),
  );
  const providerModelOptions = orderProviderModelsForConsole(
    filterRoutePolicyEditorHealthyProviderModelOptions(
      await listProviderModelOptions(),
      providerHealthSummaries,
    ),
  );
  const routePolicyByVmId = new Map(routePolicies.map((policy) => [policy.virtualModelId, policy]));
  const statusFilter = readSingleSearchParam(searchParams.vmStatus) ?? "";
  const strategyFilter = readSingleSearchParam(searchParams.vmStrategy) ?? "";
  const queryFilter = readSingleSearchParam(searchParams.vmQuery)?.toLowerCase() ?? "";
  const visibleVirtualModels = virtualModels.filter((virtualModel) => {
    const policy = routePolicyByVmId.get(virtualModel.id);
    if (statusFilter === "enabled" && !virtualModel.enabled) {
      return false;
    }
    if (statusFilter === "disabled" && virtualModel.enabled) {
      return false;
    }
    if (strategyFilter && policy?.strategy !== strategyFilter) {
      return false;
    }
    if (
      queryFilter &&
      ![virtualModel.name, virtualModel.description].some((value) =>
        value.toLowerCase().includes(queryFilter),
      )
    ) {
      return false;
    }
    return true;
  });
  const viewVirtualModelId = readSingleSearchParam(searchParams.virtualModelView);
  const viewDialogVirtualModel = viewVirtualModelId
    ? (virtualModels.find((virtualModel) => virtualModel.id === viewVirtualModelId) ?? null)
    : null;
  const viewDialogRoutePolicy = viewDialogVirtualModel
    ? (routePolicyByVmId.get(viewDialogVirtualModel.id) ?? null)
    : null;
  const viewDialogRoutePolicyWarnings = viewDialogRoutePolicy
    ? [
        ...viewDialogRoutePolicy.routeWarnings,
        ...buildRoutePolicyHealthWarnings(
          buildRoutePolicyHealthWarningCandidates(
            viewDialogRoutePolicy,
            providerHealthByProviderId,
          ),
        ),
      ]
    : [];
  const viewDialogCloseHref = buildQueryHref(searchParams, {
    selected: undefined,
    virtualModelView: undefined,
  });
  const dialogTarget = readSingleSearchParam(searchParams.virtualModelDialog);
  const dialogVirtualModel =
    dialogTarget && dialogTarget !== "new"
      ? (virtualModels.find((virtualModel) => virtualModel.id === dialogTarget) ?? null)
      : null;
  const dialogRoutePolicy = dialogVirtualModel
    ? (routePolicyByVmId.get(dialogVirtualModel.id) ?? null)
    : null;
  const dialogCloseHref = buildQueryHref(searchParams, { virtualModelDialog: undefined });
  const totalVirtualModelRequests24h = virtualModels.reduce(
    (total, virtualModel) => total + virtualModel.requestCount24h,
    0,
  );
  const totalVirtualModelCost24h = virtualModels.reduce(
    (total, virtualModel) => total + parseUsd(virtualModel.cost24hUsd),
    0,
  );
  const totalVirtualModelFailures = virtualModels.reduce(
    (total, virtualModel) => total + virtualModel.failureCountTotal,
    0,
  );
  const totalVirtualModelRequests = virtualModels.reduce(
    (total, virtualModel) => total + virtualModel.requestCountTotal,
    0,
  );
  const viewDialogFallbackOverview = viewDialogVirtualModel
    ? await listVirtualModelFallbackBreakdown({
        virtualModelId: viewDialogVirtualModel.id,
      })
    : [];
  return (
    <section className="vm-dashboard" aria-label="Virtual models and routes">
      <div className="stat-grid">
        <StatCard icon="VM" label="Virtual Models" value={String(virtualModels.length)} />
        <StatCard
          icon="Q"
          label="Requests 24h"
          value={formatConsoleCompactCount(totalVirtualModelRequests24h)}
        />
        <StatCard
          icon="$"
          label="Cost 24h"
          value={formatVirtualModelCost(totalVirtualModelCost24h)}
        />
        <StatCard
          icon="!"
          label="Failure rate total"
          value={formatVirtualModelFailureRate(
            totalVirtualModelRequests,
            totalVirtualModelFailures,
            2,
          )}
          valueTone={failureRateTone(totalVirtualModelFailures, totalVirtualModelRequests)}
        />
      </div>
      <form className="vm-filter-bar" action="/models" method="get">
        <div>
          <label htmlFor="vm-status-filter">Status</label>
          <select id="vm-status-filter" name="vmStatus" defaultValue={statusFilter}>
            <option value="">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <div>
          <label htmlFor="vm-strategy-filter">Strategy</label>
          <select id="vm-strategy-filter" name="vmStrategy" defaultValue={strategyFilter}>
            <option value="">All</option>
            {routePolicyStrategies.map((strategy) => (
              <option key={strategy} value={strategy}>
                {formatRouteStrategyLabel(strategy)}
              </option>
            ))}
          </select>
        </div>
        <input
          aria-label="Search Virtual Model Name"
          name="vmQuery"
          placeholder="Search Virtual Model name"
          defaultValue={readSingleSearchParam(searchParams.vmQuery) ?? ""}
        />
        <button type="submit">
          <span>Filter</span>
        </button>
      </form>
      <div className="vm-shell">
        <div className="agents-main-column">
          <div className="chart-card">
            <h2 className="chart-card-title">Virtual Model list</h2>
            {visibleVirtualModels.length === 0 ? (
              <p>No virtual models configured.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table vm-table">
                  <thead>
                    <tr>
                      <th>Virtual Model</th>
                      <th>Strategy</th>
                      <th className="num">Candidates</th>
                      <th>Default hit model</th>
                      <th className="num">Requests 24h</th>
                      <th className="num">Cost 24h</th>
                      <th className="num">Failure rate total</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVirtualModels.map((virtualModel) => {
                      const policy = routePolicyByVmId.get(virtualModel.id);
                      const viewHref = buildQueryHref(searchParams, {
                        selected: undefined,
                        virtualModelDialog: undefined,
                        virtualModelView: virtualModel.id,
                      });
                      const selected = virtualModel.id === viewDialogVirtualModel?.id;
                      return (
                        <tr
                          className={selected ? "is-selected" : "is-clickable"}
                          key={virtualModel.id}
                        >
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {virtualModel.name}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {policy ? (
                                <span className="pill--info pill">
                                  {formatRouteStrategyLabel(policy.strategy)}
                                </span>
                              ) : (
                                MISSING_VALUE
                              )}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              {policy?.candidates.length ?? 0}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {formatDefaultCandidate(policy)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              {formatConsoleCompactCount(virtualModel.requestCount24h)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              {formatVirtualModelCost(virtualModel.cost24hUsd)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              <span
                                className={toneToNumClass(
                                  failureRateTone(
                                    virtualModel.failureCountTotal,
                                    virtualModel.requestCountTotal,
                                  ),
                                )}
                              >
                                {formatVirtualModelFailureRate(
                                  virtualModel.requestCountTotal,
                                  virtualModel.failureCountTotal,
                                )}
                              </span>
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {virtualModel.enabled ? (
                                <span className="pill--ok pill">Enabled</span>
                              ) : (
                                <span className="pill">Disabled</span>
                              )}
                            </a>
                          </td>
                          <td>
                            <span className="agent-table-actions">
                              <a
                                aria-label={`Edit ${virtualModel.name}`}
                                className="link-button agent-action-edit row-action-button"
                                href={buildQueryHref(searchParams, {
                                  virtualModelView: undefined,
                                  virtualModelDialog: virtualModel.id,
                                })}
                                title="Edit"
                              >
                                <FlatIcon name="edit" />
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
      {viewDialogVirtualModel ? (
        <VirtualModelViewDialog
          closeHref={viewDialogCloseHref}
          fallbackOverview={viewDialogFallbackOverview}
          routePolicy={viewDialogRoutePolicy}
          routePolicyWarnings={viewDialogRoutePolicyWarnings}
          virtualModel={viewDialogVirtualModel}
        />
      ) : null}
      {dialogTarget === "new" ? (
        <VirtualModelRouteDialog
          closeHref={dialogCloseHref}
          mode="create"
          providerModelOptions={providerModelOptions}
          routePolicy={null}
          virtualModel={null}
        />
      ) : dialogVirtualModel ? (
        <VirtualModelRouteDialog
          closeHref={dialogCloseHref}
          mode="edit"
          providerModelOptions={providerModelOptions}
          routePolicy={dialogRoutePolicy}
          virtualModel={dialogVirtualModel}
        />
      ) : null}
    </section>
  );
}

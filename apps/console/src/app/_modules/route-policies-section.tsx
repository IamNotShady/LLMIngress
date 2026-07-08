import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import {
  buildRoutePolicyHealthWarnings,
  filterRoutePolicyEditorProviderModelOptions,
  listProviderModelOptions,
  listRoutePolicies,
  mergeRoutePolicyEditorProviderModelOptions,
  normalizeRoutePolicyEditorFilters,
  routePolicyStrategies,
} from "@llmingress/db/console-route-policies";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import { FlatIcon } from "../_components/flat-icon";
import { Disclosure, Pager, Row } from "../_components/list-ui";
import { paginate, readPageParam } from "../_lib/pagination";
import {
  buildRoutePolicyHealthWarningCandidates,
  type ConsoleSearchParams,
  formatRouteEndpointProtocolLabel,
  readSingleSearchParam,
} from "./sections";

function formatRoutePolicyCandidateList(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate) => candidate.optionLabel).join(", ");
}

const routeEndpointProtocolOptions = [
  "chat_completions",
  "responses",
  "messages",
  "embeddings",
] as const;

function formatRoutePolicyCandidateOrder(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate, index) => `${index + 1}. ${candidate.optionLabel}`).join(" -> ");
}

function providerModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
}

function listRoutePolicyProviderFilterOptions(
  providerModels: Awaited<ReturnType<typeof listProviderModelOptions>>,
) {
  const providersByKey = new Map<string, { providerDisplayName: string; providerKey: string }>();
  for (const providerModel of providerModels) {
    if (!providersByKey.has(providerModel.providerKey)) {
      providersByKey.set(providerModel.providerKey, {
        providerDisplayName: providerModel.providerDisplayName,
        providerKey: providerModel.providerKey,
      });
    }
  }
  return Array.from(providersByKey.values()).sort((left, right) =>
    left.providerDisplayName.localeCompare(right.providerDisplayName),
  );
}
export async function RoutePoliciesSection({
  searchParams,
}: {
  searchParams: ConsoleSearchParams;
}) {
  const routePolicyEditorFilters = normalizeRoutePolicyEditorFilters({
    endpointProtocol: readSingleSearchParam(searchParams.routeEndpointFilter) ?? "chat_completions",
    modelQuery: readSingleSearchParam(searchParams.routeModelFilter),
    providerKey: readSingleSearchParam(searchParams.routeProviderFilter),
  });
  const virtualModels = await listVirtualModels();
  const routePolicies = await listRoutePolicies();
  const providerModelOptions = await listProviderModelOptions();
  const providerHealthSummaries = await listConsoleProviderHealthSummaries();
  const providerHealthByProviderId = new Map(
    providerHealthSummaries.map((summary) => [summary.id, summary]),
  );
  const routePolicyProviderFilterOptions =
    listRoutePolicyProviderFilterOptions(providerModelOptions);
  const routePolicyCreateProviderModelOptions = filterRoutePolicyEditorProviderModelOptions(
    providerModelOptions,
    routePolicyEditorFilters,
  );
  const routedVirtualModelIds = new Set(
    routePolicies.map((routePolicy) => routePolicy.virtualModelId),
  );
  const virtualModelsWithoutRoutePolicy = virtualModels.filter(
    (virtualModel) => !routedVirtualModelIds.has(virtualModel.id),
  );
  const view = paginate(routePolicies, readPageParam(searchParams));
  return (
    <section className="providers-panel" aria-label="Route policies">
      {providerModelOptions.length === 0 ? null : (
        <form className="provider-create-form" action="/routing" method="get">
          <label htmlFor="route-endpoint-filter">Route endpoint filter</label>
          <select
            id="route-endpoint-filter"
            name="routeEndpointFilter"
            defaultValue={routePolicyEditorFilters.endpointProtocol ?? "chat_completions"}
          >
            {routeEndpointProtocolOptions.map((protocol) => (
              <option key={protocol} value={protocol}>
                {formatRouteEndpointProtocolLabel(protocol)}
              </option>
            ))}
          </select>
          <label htmlFor="route-provider-filter">Route provider filter</label>
          <select
            id="route-provider-filter"
            name="routeProviderFilter"
            defaultValue={routePolicyEditorFilters.providerKey ?? ""}
          >
            <option value="">All providers</option>
            {routePolicyProviderFilterOptions.map((provider) => (
              <option key={provider.providerKey} value={provider.providerKey}>
                {provider.providerDisplayName} ({provider.providerKey})
              </option>
            ))}
          </select>
          <label htmlFor="route-model-filter">Route model filter</label>
          <input
            id="route-model-filter"
            name="routeModelFilter"
            defaultValue={routePolicyEditorFilters.modelQuery ?? ""}
          />
          <button type="submit">
            <FlatIcon name="filter" />
            <span>Apply route policy filters</span>
          </button>
          <a href="/routing">Clear route policy filters</a>
        </form>
      )}
      {virtualModelsWithoutRoutePolicy.length === 0 ? (
        <p>No Virtual Models without route policies.</p>
      ) : providerModelOptions.length === 0 ? (
        <p>No provider models available.</p>
      ) : routePolicyCreateProviderModelOptions.length === 0 ? (
        <p>No provider models match route policy filters.</p>
      ) : (
        <Disclosure tone="add" summary="New route policy">
          <form className="provider-create-form" action="/api/route-policies" method="post">
            <input type="hidden" name="action" value="create" />
            <label htmlFor="route-policy-virtual-model">Route policy virtual model</label>
            <select id="route-policy-virtual-model" name="virtualModelId" required defaultValue="">
              <option value="" disabled>
                Select virtual model
              </option>
              {virtualModelsWithoutRoutePolicy.map((virtualModel) => (
                <option key={virtualModel.id} value={virtualModel.id}>
                  {virtualModel.name}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-strategy">Route policy strategy</label>
            <select id="route-policy-strategy" name="strategy" required defaultValue="random">
              {routePolicyStrategies.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {strategy}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-endpoint">Route policy endpoint</label>
            <select
              id="route-policy-endpoint"
              name="endpointProtocol"
              required
              defaultValue={routePolicyEditorFilters.endpointProtocol ?? "chat_completions"}
            >
              {routeEndpointProtocolOptions.map((protocol) => (
                <option key={protocol} value={protocol}>
                  {formatRouteEndpointProtocolLabel(protocol)}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-models">Provider models (in priority order)</label>
            <select
              id="route-policy-models"
              name="providerModelIds"
              multiple
              required
              size={providerModelSelectSize(routePolicyCreateProviderModelOptions.length)}
            >
              {routePolicyCreateProviderModelOptions.map((providerModel) => (
                <option key={providerModel.id} value={providerModel.id}>
                  {providerModel.pricedOptionLabel}
                </option>
              ))}
            </select>
            <button type="submit">
              <FlatIcon name="add" />
              <span>Create route policy</span>
            </button>
          </form>
        </Disclosure>
      )}
      {routePolicies.length === 0 ? (
        <p>No route policies configured.</p>
      ) : (
        <div className="row-list">
          {view.items.map((routePolicy) => {
            const routePolicyEndpointProtocol =
              routePolicy.endpointProtocol ??
              routePolicyEditorFilters.endpointProtocol ??
              "chat_completions";
            const routePolicyEditorOptions = mergeRoutePolicyEditorProviderModelOptions(
              filterRoutePolicyEditorProviderModelOptions(providerModelOptions, {
                ...routePolicyEditorFilters,
                endpointProtocol: routePolicyEndpointProtocol,
              }),
              routePolicy.candidates,
            );
            const routePolicyWarnings = [
              ...routePolicy.routeWarnings,
              ...buildRoutePolicyHealthWarnings(
                buildRoutePolicyHealthWarningCandidates(routePolicy, providerHealthByProviderId),
              ),
            ];

            return (
              <Row
                key={routePolicy.id}
                title={<h3 className="row-title">{routePolicy.virtualModelDisplayName}</h3>}
                meta={
                  <span className="row-meta">
                    <span className="mono">{routePolicy.virtualModelName}</span>
                    <span>{routePolicy.strategy}</span>
                    {routePolicyWarnings.length > 0 ? (
                      <span className="row-flag">{routePolicyWarnings.length} warnings</span>
                    ) : null}
                  </span>
                }
                status={<span className="status-enabled">Enabled</span>}
              >
                <p>
                  Virtual Model: {routePolicy.virtualModelDisplayName} (
                  {routePolicy.virtualModelName})
                </p>
                <p>Strategy: {routePolicy.strategy}</p>
                <p>Endpoint: {formatRouteEndpointProtocolLabel(routePolicyEndpointProtocol)}</p>
                <p>Route reason: {routePolicy.routeReason}</p>
                {routePolicyWarnings.map((warning) => (
                  <p className="route-warning" key={warning}>
                    {warning}
                  </p>
                ))}
                <p>Candidates: {formatRoutePolicyCandidateList(routePolicy.candidates)}</p>
                <p>Candidate order: {formatRoutePolicyCandidateOrder(routePolicy.candidates)}</p>
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
                  <label htmlFor={`route-policy-endpoint-${routePolicy.id}`}>
                    Edit route policy endpoint
                  </label>
                  <select
                    id={`route-policy-endpoint-${routePolicy.id}`}
                    name="endpointProtocol"
                    defaultValue={routePolicyEndpointProtocol}
                    required
                  >
                    {routeEndpointProtocolOptions.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {formatRouteEndpointProtocolLabel(protocol)}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`route-policy-models-${routePolicy.id}`}>
                    Edit provider models (in priority order)
                  </label>
                  <select
                    id={`route-policy-models-${routePolicy.id}`}
                    name="providerModelIds"
                    defaultValue={routePolicy.candidates.map((candidate) => candidate.id)}
                    multiple
                    required
                    size={providerModelSelectSize(routePolicyEditorOptions.length)}
                  >
                    {routePolicyEditorOptions.map((providerModel) => (
                      <option key={providerModel.id} value={providerModel.id}>
                        {providerModel.pricedOptionLabel}
                      </option>
                    ))}
                  </select>
                  <button type="submit">
                    <FlatIcon name="save" />
                    <span>Save route policy</span>
                  </button>
                </form>
                <div className="row-actions">
                  <form action="/api/route-policies" method="post">
                    <input type="hidden" name="action" value="delete" />
                    <input type="hidden" name="id" value={routePolicy.id} />
                    <button className="secondary-button" type="submit">
                      <FlatIcon name="delete" />
                      <span>Delete route policy</span>
                    </button>
                  </form>
                </div>
              </Row>
            );
          })}
        </div>
      )}
      <Pager view={view} searchParams={searchParams} />
    </section>
  );
}

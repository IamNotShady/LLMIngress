"use client";

import { type DragEvent, useMemo, useState } from "react";
import { ConsoleDialog } from "../_components/console-dialog";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";

type Strategy = "fixed" | "cost_first" | "random";
type EndpointProtocol = "chat_completions" | "responses" | "messages" | "embeddings";

type ProviderModelOption = {
  availability: string;
  contextWindow: number | null;
  id: string;
  inputUsdPerMillionTokens: number | null;
  modelDisplayName: string;
  modelId: string;
  optionLabel: string;
  outputUsdPerMillionTokens: number | null;
  providerDisplayName: string;
  providerKey: string;
  supportedEndpoints: EndpointProtocol[];
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean | null;
};

type Candidate = ProviderModelOption & {
  candidateOrder: number;
};

type RoutePolicy = {
  candidates: Candidate[];
  endpointProtocol: EndpointProtocol | null;
  id: string;
  strategy: Strategy;
};

type VirtualModel = {
  description: string;
  id: string;
  name: string;
};

const strategies: Strategy[] = ["fixed", "cost_first", "random"];
const endpointProtocols: EndpointProtocol[] = [
  "chat_completions",
  "responses",
  "messages",
  "embeddings",
];

export function VirtualModelRouteDialogClient({
  closeHref,
  mode,
  providerModelOptions,
  routePolicy,
  virtualModel,
}: {
  closeHref: string;
  mode: "create" | "edit";
  providerModelOptions: ProviderModelOption[];
  routePolicy: RoutePolicy | null;
  virtualModel: VirtualModel | null;
}) {
  const [strategy, setStrategy] = useState<Strategy>(routePolicy?.strategy ?? "random");
  const [endpointProtocol, setEndpointProtocol] = useState<EndpointProtocol>(
    readInitialEndpointProtocol(routePolicy),
  );
  const [selectedCandidates, setSelectedCandidates] = useState<Candidate[]>(
    routePolicy?.candidates ?? [],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState("all");
  const [modelQuery, setModelQuery] = useState("");

  const providerFilters = useMemo(() => {
    const providers = new Map<string, string>();
    for (const option of providerModelOptions) {
      providers.set(option.providerKey, option.providerDisplayName);
    }
    return [...providers.entries()];
  }, [providerModelOptions]);

  const selectedIds = useMemo(
    () => new Set(selectedCandidates.map((candidate) => candidate.id)),
    [selectedCandidates],
  );
  const visibleOptions = providerModelOptions.filter((option) => {
    if (selectedIds.has(option.id)) {
      return false;
    }
    if (!option.supportedEndpoints.includes(endpointProtocol)) {
      return false;
    }
    if (providerFilter !== "all" && option.providerKey !== providerFilter) {
      return false;
    }
    const query = modelQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return `${option.providerDisplayName} ${option.modelDisplayName} ${option.modelId}`
      .toLowerCase()
      .includes(query);
  });

  function addModel(option: ProviderModelOption) {
    setSelectedCandidates((current) => [...current, { ...option, candidateOrder: current.length }]);
    setPickerOpen(false);
  }

  function handleEndpointChange(nextEndpointProtocol: EndpointProtocol) {
    setEndpointProtocol(nextEndpointProtocol);
    setSelectedCandidates((current) =>
      current
        .filter((candidate) => candidate.supportedEndpoints.includes(nextEndpointProtocol))
        .map((candidate, index) => ({ ...candidate, candidateOrder: index })),
    );
  }

  function moveCandidate(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
      return;
    }
    setSelectedCandidates((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) {
        return current;
      }
      next.splice(toIndex, 0, moved);
      return next.map((candidate, index) => ({ ...candidate, candidateOrder: index }));
    });
  }

  function handleCandidateDrop(event: DragEvent<HTMLTableRowElement>, toIndex: number) {
    event.preventDefault();
    moveCandidate(Number(event.dataTransfer.getData("text/plain")), toIndex);
  }

  function removeCandidate(index: number) {
    setSelectedCandidates((current) =>
      current
        .filter((_, candidateIndex) => candidateIndex !== index)
        .map((candidate, candidateIndex) => ({ ...candidate, candidateOrder: candidateIndex })),
    );
  }

  return (
    <>
      <ConsoleDialog
        ariaLabelledby="virtual-model-dialog-title"
        className="console-dialog vm-route-dialog"
        closeHref={closeHref}
        triggerId={
          virtualModel
            ? `virtual-model-edit-${virtualModel.id}-trigger`
            : "virtual-model-create-dialog-trigger"
        }
      >
        <div className="console-dialog-head">
          <h2 id="virtual-model-dialog-title">
            {mode === "create"
              ? "Create Virtual Model"
              : `Edit Virtual Model: ${virtualModel?.name}`}
          </h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <div className="vm-editor-grid">
          <ConsoleMutationForm
            action="/api/virtual-models"
            className="vm-editor-form"
            fallbackError="Virtual Model operation failed."
          >
            <input
              type="hidden"
              name="action"
              value={mode === "create" ? "createWithRoute" : "updateWithRoute"}
            />
            {virtualModel ? <input type="hidden" name="id" value={virtualModel.id} /> : null}
            {routePolicy ? (
              <input type="hidden" name="routePolicyId" value={routePolicy.id} />
            ) : null}
            <section className="chart-card">
              <h3 className="chart-card-title">Basic info</h3>
              <div className="vm-editor-fields">
                <div>
                  <label htmlFor="virtual-model-dialog-endpoint">Endpoint</label>
                  <select
                    id="virtual-model-dialog-endpoint"
                    name="endpointProtocol"
                    value={endpointProtocol}
                    onChange={(event) =>
                      handleEndpointChange(event.target.value as EndpointProtocol)
                    }
                    required
                  >
                    {endpointProtocols.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {formatEndpointProtocolLabel(protocol)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="virtual-model-dialog-name">Virtual Model name</label>
                  <input
                    data-dialog-initial-focus
                    id="virtual-model-dialog-name"
                    name="name"
                    defaultValue={virtualModel?.name ?? ""}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="virtual-model-dialog-description">Description</label>
                  <input
                    id="virtual-model-dialog-description"
                    name="description"
                    defaultValue={virtualModel?.description ?? ""}
                    required
                  />
                </div>
              </div>
            </section>
            <section className="chart-card">
              <h3 className="chart-card-title">1. Choose routing strategy</h3>
              <div className="option-cards">
                {strategies.map((candidateStrategy) => (
                  <label className="option-card" key={candidateStrategy}>
                    <input
                      checked={candidateStrategy === strategy}
                      name="strategy"
                      onChange={() => setStrategy(candidateStrategy)}
                      type="radio"
                      value={candidateStrategy}
                    />
                    <span className="option-card-title">
                      {formatRouteStrategyLabel(candidateStrategy)}
                    </span>
                    <span className="option-card-desc">
                      {formatRouteStrategyDescription(candidateStrategy)}
                    </span>
                  </label>
                ))}
              </div>
            </section>
            <section className="chart-card">
              <h3 className="chart-card-title">2. Selected candidates</h3>
              {selectedCandidates.length === 0 ? (
                <p>No candidates selected.</p>
              ) : (
                <div className="data-table-wrap">
                  <table className="data-table bounded-table vm-candidate-table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Context</th>
                        <th>Input price</th>
                        <th>Output price</th>
                        <th>Function calling</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedCandidates.map((candidate, index) => (
                        <tr
                          draggable
                          key={candidate.id}
                          onDragOver={(event) => event.preventDefault()}
                          onDragStart={(event) =>
                            event.dataTransfer.setData("text/plain", String(index))
                          }
                          onDrop={(event) => handleCandidateDrop(event, index)}
                        >
                          <td>
                            <input type="hidden" name="providerModelIds" value={candidate.id} />
                            <span className="vm-candidate-order">
                              <span aria-hidden="true" className="vm-drag-handle">
                                ::
                              </span>
                              {index + 1}
                            </span>
                          </td>
                          <td>{candidate.providerDisplayName}</td>
                          <td>{candidate.modelDisplayName}</td>
                          <td>{formatModelContext(candidate.contextWindow)}</td>
                          <td>{formatModelPrice(candidate.inputUsdPerMillionTokens)}</td>
                          <td>{formatModelPrice(candidate.outputUsdPerMillionTokens)}</td>
                          <td>{formatBooleanFeature(candidate.supportsFunctionCalling)}</td>
                          <td>
                            {candidate.availability === "available" ? (
                              <span className="pill--ok pill">Available</span>
                            ) : (
                              <span className="pill--danger pill">Disabled</span>
                            )}
                          </td>
                          <td>
                            <button
                              className="vm-candidate-remove"
                              type="button"
                              onClick={() => removeCandidate(index)}
                            >
                              <FlatIcon name="delete" />
                              <span>Remove</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="callout">
                Candidates are tried in order; fallback continues to the next available candidate.
              </p>
              <button
                className="secondary-button vm-add-model-button"
                id="vm-model-picker-trigger"
                type="button"
                onClick={() => setPickerOpen(true)}
              >
                <span>Add Model</span>
              </button>
            </section>
            <div className="vm-dialog-actions">
              <a className="secondary-button" href={closeHref}>
                <span>Cancel</span>
              </a>
              <button disabled={selectedCandidates.length === 0} type="submit">
                <span>{virtualModel ? "Save" : "Create"}</span>
              </button>
            </div>
          </ConsoleMutationForm>
        </div>
      </ConsoleDialog>

      {pickerOpen ? (
        <ConsoleDialog
          ariaLabelledby="vm-model-picker-title"
          className="console-dialog vm-model-picker"
          closeHref={closeHref}
          onRequestClose={() => setPickerOpen(false)}
          triggerId="vm-model-picker-trigger"
        >
          <div className="console-dialog-head">
            <h2 id="vm-model-picker-title">Add Model</h2>
            <button className="secondary-button" type="button" onClick={() => setPickerOpen(false)}>
              <FlatIcon name="cancel" />
              <span>Close</span>
            </button>
          </div>
          <div className="vm-model-filter-bar">
            <div>
              <label htmlFor="vm-model-provider-filter">Provider</label>
              <select
                id="vm-model-provider-filter"
                value={providerFilter}
                onChange={(event) => setProviderFilter(event.target.value)}
              >
                <option value="all">All</option>
                {providerFilters.map(([providerKey, providerDisplayName]) => (
                  <option key={providerKey} value={providerKey}>
                    {providerDisplayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="vm-model-name-filter">Model name</label>
              <input
                id="vm-model-name-filter"
                placeholder="Search model name"
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table bounded-table vm-model-picker-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model ID</th>
                  <th>Context</th>
                  <th>Input price</th>
                  <th>Output price</th>
                  <th>Function calling</th>
                  <th>Streaming</th>
                </tr>
              </thead>
              <tbody>
                {visibleOptions.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <p>No compatible models available for this endpoint.</p>
                      <a className="empty-state-action" href="/providers">
                        Open Providers
                      </a>{" "}
                      to add or refresh Provider Models.
                    </td>
                  </tr>
                ) : (
                  visibleOptions.map((option) => (
                    <tr key={option.id}>
                      <td>{option.providerDisplayName}</td>
                      <td>
                        <button
                          className="vm-model-select-button"
                          type="button"
                          onClick={() => addModel(option)}
                        >
                          <strong>{option.modelDisplayName}</strong>
                          {option.modelId !== option.modelDisplayName ? (
                            <span>{option.modelId}</span>
                          ) : null}
                        </button>
                      </td>
                      <td>{formatModelContext(option.contextWindow)}</td>
                      <td>{formatModelPrice(option.inputUsdPerMillionTokens)}</td>
                      <td>{formatModelPrice(option.outputUsdPerMillionTokens)}</td>
                      <td>{formatBooleanFeature(option.supportsFunctionCalling)}</td>
                      <td>{formatBooleanFeature(option.supportsStreaming)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </ConsoleDialog>
      ) : null}
    </>
  );
}

function formatRouteStrategyLabel(strategy: Strategy): string {
  if (strategy === "cost_first") {
    return "Cost First";
  }
  if (strategy === "random") {
    return "Random";
  }
  return strategy.charAt(0).toUpperCase() + strategy.slice(1);
}

function readInitialEndpointProtocol(routePolicy: RoutePolicy | null): EndpointProtocol {
  return (
    routePolicy?.endpointProtocol ??
    routePolicy?.candidates[0]?.supportedEndpoints[0] ??
    "chat_completions"
  );
}

function formatEndpointProtocolLabel(protocol: EndpointProtocol): string {
  if (protocol === "chat_completions") {
    return "Chat Completions";
  }
  if (protocol === "responses") {
    return "Responses";
  }
  if (protocol === "messages") {
    return "Messages";
  }
  return "Embeddings";
}

function formatRouteStrategyDescription(strategy: Strategy): string {
  if (strategy === "fixed") {
    return "Always use the first candidate";
  }
  if (strategy === "cost_first") {
    return "Prefer the lowest-cost candidate";
  }
  return "Pick a random eligible candidate each request";
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
  return `$${price.toFixed(price >= 1 ? 2 : 4)}`;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBooleanFeature(value: boolean | null): string {
  return value === null ? "Unknown" : value ? "Yes" : "No";
}

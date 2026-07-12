import {
  type ConsoleProviderModelOption,
  listProviderModelOptions,
} from "@llmingress/db/console-route-policies";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref } from "../_lib/pagination";
import { type ConsoleSearchParams, readSingleSearchParam } from "./sections";

function formatModelPriceCell(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function ModelPricePanel({ model }: { model: ConsoleProviderModelOption }) {
  const input = model.inputUsdPerMillionTokens;
  const output = model.outputUsdPerMillionTokens;
  const isPriced = input !== null && output !== null;
  const inputLabel = input === null ? "Unknown input price" : `$${input.toFixed(2)} / 1M input`;
  const outputLabel =
    output === null ? "Unknown output price" : `$${output.toFixed(2)} / 1M output`;
  const estimateLabel = isPriced ? `$${(input + output).toFixed(2)}` : "Unavailable";

  return (
    <div className="detail-panel price-panel">
      <div className="detail-panel-head">
        <div>
          <p className="detail-section-label">Prices</p>
          <h2 className="detail-panel-title">{model.modelId}</h2>
        </div>
        <span className="price-source">{model.priceStatusLabel}</span>
      </div>
      <dl className="detail-field-list">
        <div className="detail-field">
          <dt>Input</dt>
          <dd>{inputLabel}</dd>
        </div>
        <div className="detail-field">
          <dt>Output</dt>
          <dd>{outputLabel}</dd>
        </div>
        <div className="detail-field">
          <dt>1M input + 1M output</dt>
          <dd>{estimateLabel}</dd>
        </div>
      </dl>
      <ConsoleMutationForm
        action="/api/prices/override"
        className="price-form"
        fallbackError="Price override failed."
      >
        <input type="hidden" name="providerKey" value={model.providerKey} />
        <input type="hidden" name="modelId" value={model.modelId} />
        <input type="hidden" name="redirectModel" value={model.id} />
        <label htmlFor="override-input-price">Override input price</label>
        <input
          id="override-input-price"
          name="inputUsdPerMillionTokens"
          type="number"
          min="0"
          step="0.00000001"
          defaultValue={input ?? ""}
          required
        />
        <label htmlFor="override-output-price">Override output price</label>
        <input
          id="override-output-price"
          name="outputUsdPerMillionTokens"
          type="number"
          min="0"
          step="0.00000001"
          defaultValue={output ?? ""}
          required
        />
        <button type="submit">
          <span>Save</span>
        </button>
      </ConsoleMutationForm>
    </div>
  );
}
export async function ModelsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const providerModelOptions = await listProviderModelOptions();
  const providers = new Set(providerModelOptions.map((option) => option.providerKey));
  const pricedCount = providerModelOptions.filter(
    (option) => option.priceStatus !== "unknown_price",
  ).length;
  const selectedModelId = readSingleSearchParam(searchParams.model);
  const selectedModel =
    providerModelOptions.find((option) => option.id === selectedModelId) ??
    providerModelOptions[0] ??
    null;

  return (
    <section className="providers-panel" aria-label="Model directory">
      <div className="stat-grid">
        <StatCard icon="MO" label="Models" value={String(providerModelOptions.length)} />
        <StatCard icon="PR" label="Providers" value={String(providers.size)} />
        <StatCard icon="$" label="Priced models" value={String(pricedCount)} />
      </div>
      {providerModelOptions.length === 0 ? (
        <div className="chart-card">
          <h2 className="chart-card-title">Model directory</h2>
          <p>No provider models discovered yet. Refresh models on the Providers page.</p>
        </div>
      ) : (
        <div className="detail-layout">
          <div className="chart-card">
            <h2 className="chart-card-title">Model directory</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>Model ID</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th>Price source</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {providerModelOptions.map((option) => (
                    <tr
                      key={option.id}
                      className={selectedModel?.id === option.id ? "is-selected" : "is-clickable"}
                    >
                      <td>{option.providerDisplayName}</td>
                      <td>
                        <a href={buildQueryHref(searchParams, { model: option.id })}>
                          {option.modelDisplayName}
                        </a>
                      </td>
                      <td className="mono">{option.modelId}</td>
                      <td className="num">
                        {formatModelPriceCell(option.inputUsdPerMillionTokens)}
                      </td>
                      <td className="num">
                        {formatModelPriceCell(option.outputUsdPerMillionTokens)}
                      </td>
                      <td>{option.priceStatusLabel}</td>
                      <td>
                        {option.providerEnabled ? (
                          <span className="pill--ok pill">Enabled</span>
                        ) : (
                          <span className="pill">Disabled</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {selectedModel ? <ModelPricePanel model={selectedModel} /> : null}
        </div>
      )}
    </section>
  );
}

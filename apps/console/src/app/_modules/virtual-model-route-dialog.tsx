"use client";

import { type DragEvent, useMemo, useState } from "react";

type Strategy = "fixed" | "cost_first" | "balanced" | "quality_first";

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
  supportsTools: boolean;
};

type Candidate = ProviderModelOption & {
  candidateOrder: number;
  isFallback: boolean;
};

type RoutePolicy = {
  candidates: Candidate[];
  id: string;
  strategy: Strategy;
};

type VirtualModel = {
  description: string;
  id: string;
  name: string;
};

const strategies: Strategy[] = ["fixed", "cost_first", "balanced", "quality_first"];

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
  const [strategy, setStrategy] = useState<Strategy>(routePolicy?.strategy ?? "balanced");
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
    setSelectedCandidates((current) => [
      ...current,
      { ...option, candidateOrder: current.length, isFallback: false },
    ]);
    setPickerOpen(false);
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
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="virtual-model-dialog-title"
        aria-modal="true"
        className="console-dialog vm-route-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id="virtual-model-dialog-title">
            {mode === "create" ? "创建 Virtual Model" : `编辑 Virtual Model：${virtualModel?.name}`}
          </h2>
          <a className="secondary-button" href={closeHref}>
            Close
          </a>
        </div>
        <div className="vm-editor-grid">
          <form className="vm-editor-form" action="/api/virtual-models" method="post">
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
              <h3 className="chart-card-title">基本信息</h3>
              <div className="vm-editor-fields">
                <div>
                  <label htmlFor="virtual-model-dialog-name">Virtual Model 名称</label>
                  <input
                    id="virtual-model-dialog-name"
                    name="name"
                    defaultValue={virtualModel?.name ?? ""}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="virtual-model-dialog-description">描述</label>
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
              <h3 className="chart-card-title">1. 选择路由策略</h3>
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
              <h3 className="chart-card-title">2. 已选 Candidates</h3>
              {selectedCandidates.length === 0 ? (
                <p>No candidates selected.</p>
              ) : (
                <div className="data-table-wrap">
                  <table className="data-table vm-candidate-table">
                    <thead>
                      <tr>
                        <th>顺序</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Context</th>
                        <th>输入价</th>
                        <th>输出价</th>
                        <th>Tools</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedCandidates.map((candidate, index) => (
                        <tr
                          draggable
                          key={`${candidate.id}-${candidate.isFallback ? "fallback" : "primary"}`}
                          onDragOver={(event) => event.preventDefault()}
                          onDragStart={(event) =>
                            event.dataTransfer.setData("text/plain", String(index))
                          }
                          onDrop={(event) => handleCandidateDrop(event, index)}
                        >
                          <td>
                            <input
                              type="hidden"
                              name={
                                candidate.isFallback
                                  ? "fallbackProviderModelIds"
                                  : "primaryProviderModelIds"
                              }
                              value={candidate.id}
                            />
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
                          <td>{formatBooleanFeature(candidate.supportsTools)}</td>
                          <td>
                            {candidate.availability === "available" ? (
                              <span className="pill--ok pill">可用</span>
                            ) : (
                              <span className="pill--danger pill">禁用</span>
                            )}
                          </td>
                          <td>
                            <button
                              className="vm-candidate-remove"
                              type="button"
                              onClick={() => removeCandidate(index)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="callout">
                候选模型按顺序参与选择；Fallback 将继续尝试下一个可用候选模型。
              </p>
              <button
                className="secondary-button vm-add-model-button"
                type="button"
                onClick={() => setPickerOpen(true)}
              >
                Add Model
              </button>
            </section>
            <div className="vm-dialog-actions">
              <a className="secondary-button" href={closeHref}>
                取消
              </a>
              <button type="submit">保存</button>
            </div>
          </form>
          <aside className="chart-card vm-policy-note">
            <h3 className="chart-card-title">当前策略说明</h3>
            <dl className="agent-detail-fields">
              <div>
                <dt>Strategy</dt>
                <dd>{formatRouteStrategyLabel(strategy)}</dd>
              </div>
              <div>
                <dt>Candidates</dt>
                <dd>
                  {selectedCandidates.length ? `${selectedCandidates.length} 个模型` : "未配置"}
                </dd>
              </div>
              <div>
                <dt>生效方式</dt>
                <dd>保存后对新请求生效</dd>
              </div>
              <div>
                <dt>Fallback</dt>
                <dd>失败时尝试下一个候选</dd>
              </div>
            </dl>
            <section className="agent-detail-section">
              <h3>不包含的高级能力</h3>
              <p>- 任务类型规则</p>
              <p>- 上下文长度阈值</p>
              <p>- 工具调用条件</p>
              <p>- timeout / retry 设置</p>
            </section>
            <p className="callout callout--warn">当前版本仅支持 strategy + candidates。</p>
          </aside>
        </div>
      </section>

      {pickerOpen ? (
        <>
          <div className="vm-model-picker-scrim" aria-hidden="true" />
          <section
            aria-labelledby="vm-model-picker-title"
            aria-modal="true"
            className="console-dialog vm-model-picker"
            role="dialog"
          >
            <div className="console-dialog-head">
              <h2 id="vm-model-picker-title">Add Model</h2>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setPickerOpen(false)}
              >
                Close
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
              <table className="data-table vm-model-picker-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model ID</th>
                    <th>Context</th>
                    <th>输入价格</th>
                    <th>输出价格</th>
                    <th>Tools</th>
                    <th>Streaming</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOptions.length === 0 ? (
                    <tr>
                      <td colSpan={7}>No models found.</td>
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
                        <td>{formatBooleanFeature(option.supportsTools)}</td>
                        <td>不支持</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

function formatRouteStrategyLabel(strategy: Strategy): string {
  if (strategy === "cost_first") {
    return "Cost First";
  }
  if (strategy === "quality_first") {
    return "Quality First";
  }
  return strategy.charAt(0).toUpperCase() + strategy.slice(1);
}

function formatRouteStrategyDescription(strategy: Strategy): string {
  if (strategy === "fixed") {
    return "固定使用第一个候选模型";
  }
  if (strategy === "cost_first") {
    return "优先选择低成本候选模型";
  }
  if (strategy === "quality_first") {
    return "优先选择高质量候选模型";
  }
  return "综合成本、健康状态与可用性";
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
    return "未知";
  }
  return `$${price.toFixed(price >= 1 ? 2 : 4)}`;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBooleanFeature(value: boolean): string {
  return value ? "支持" : "不支持";
}

import { gatewayPublicBaseUrl } from "@llmingress/config";
import {
  type ConsoleApiKeyLimit,
  defaultApiKeyLimitFormValues,
} from "@llmingress/db/console-api-key-limits";
import type { ApiKeyVirtualModelAccess, ConsoleApiKey } from "@llmingress/db/console-api-keys";
import { formatConsoleCompactCount, formatConsoleUsd } from "@llmingress/db/console-format";
import type { ConsoleVirtualModel } from "@llmingress/db/console-virtual-models";
import { ConsoleDialog } from "../_components/console-dialog";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref } from "../_lib/pagination";
import { ApiKeyCreateDialogClient } from "./api-key-create-dialog-client";
import { ApiKeyDetailPanels } from "./api-key-detail-panels";
import { API_KEY_PLACEHOLDER } from "./api-key-integration-guide";
import { ApiKeyVirtualModelFields } from "./api-key-virtual-model-fields";
import { loadApiKeysSectionData } from "./api-keys-section-data";
import {
  type ConsoleSearchParams,
  findApiKeyLimit,
  groupByApiKeyId,
  readSingleSearchParam,
} from "./sections";

function ApiKeyViewDialog({
  access,
  apiKey,
  closeHref,
  limits,
}: {
  access: ApiKeyVirtualModelAccess | null;
  apiKey: ConsoleApiKey;
  closeHref: string;
  limits: readonly ConsoleApiKeyLimit[];
}) {
  const gatewayBaseUrl = gatewayPublicBaseUrl();
  const allowedVirtualModels = access?.allowedVirtualModels ?? [];
  const guideModel =
    access?.defaultVirtualModel?.name ?? allowedVirtualModels[0]?.name ?? "<Virtual Model Name>";

  return (
    <ConsoleDialog
      ariaLabelledby={`api-key-view-dialog-title-${apiKey.id}`}
      className="console-dialog api-key-view-dialog"
      closeHref={closeHref}
      initialFocus="close"
      triggerId={`api-key-view-${apiKey.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id={`api-key-view-dialog-title-${apiKey.id}`}>{apiKey.name}</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ApiKeyDetailPanels
        createdAt={apiKey.createdAt}
        defaultVirtualModelName={access?.defaultVirtualModel?.name ?? null}
        enabled={apiKey.enabled}
        gatewayBaseUrl={gatewayBaseUrl}
        guideApiKey={API_KEY_PLACEHOLDER}
        guideKeyPrefix={apiKey.keyPrefix}
        guideModel={guideModel}
        idPrefix={`api-key-view-${apiKey.id}`}
        limits={limits}
        secretHideable={false}
        secretLabel="API key prefix"
        secretNote="Only the prefix is stored. The full key was shown once at creation."
        secretValue={apiKey.keyPrefix}
        virtualModels={allowedVirtualModels}
      />
    </ConsoleDialog>
  );
}

function ApiKeyCreateDialog({
  closeHref,
  virtualModels,
}: {
  closeHref: string;
  virtualModels: readonly ConsoleVirtualModel[];
}) {
  return (
    <ApiKeyCreateDialogClient closeHref={closeHref}>
      <input type="hidden" name="action" value="create" />
      <label htmlFor="api-key-name">Name</label>
      <input id="api-key-name" name="name" required />
      <ApiKeyVirtualModelFields
        idPrefix="api-key"
        initialSelectedVirtualModelIds={[]}
        virtualModels={virtualModels.map(({ id, name }) => ({ id, name }))}
      />
      <label className="checkbox-label api-key-limit-toggle" htmlFor="api-key-enable-limits">
        <input id="api-key-enable-limits" name="enableLimits" type="checkbox" value="true" />
        <span>Enable limits</span>
      </label>
      <div className="api-key-create-limit-fields">
        <label htmlFor="api-key-budget-usd">Budget USD limit</label>
        <input
          id="api-key-budget-usd"
          name="budgetUsd"
          type="number"
          min="0.000001"
          step="0.000001"
          defaultValue={defaultApiKeyLimitFormValues.budgetUsd}
        />
        <label htmlFor="api-key-budget-period">Budget period</label>
        <select
          id="api-key-budget-period"
          name="budgetPeriod"
          defaultValue={defaultApiKeyLimitFormValues.budgetPeriod}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
        <label htmlFor="api-key-rpm">RPM limit</label>
        <input
          id="api-key-rpm"
          name="rpm"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultApiKeyLimitFormValues.rpm}
        />
        <label htmlFor="api-key-tpm">TPM limit</label>
        <input
          id="api-key-tpm"
          name="tpm"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultApiKeyLimitFormValues.tpm}
        />
        <label htmlFor="api-key-concurrency">Concurrency limit</label>
        <input
          id="api-key-concurrency"
          name="concurrency"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultApiKeyLimitFormValues.concurrency}
        />
        <label htmlFor="api-key-token-limit">Token limit</label>
        <input
          id="api-key-token-limit"
          name="tokenLimit"
          type="number"
          min="1"
          step="1"
          defaultValue={defaultApiKeyLimitFormValues.tokenLimit}
        />
      </div>
    </ApiKeyCreateDialogClient>
  );
}

function ApiKeyEditDialog({
  access,
  apiKey,
  closeHref,
  limits,
  virtualModels,
}: {
  access: ApiKeyVirtualModelAccess;
  apiKey: ConsoleApiKey;
  closeHref: string;
  limits: readonly ConsoleApiKeyLimit[];
  virtualModels: readonly ConsoleVirtualModel[];
}) {
  const budgetLimit = findApiKeyLimit(limits, "budget");
  const concurrencyLimit = findApiKeyLimit(limits, "concurrency");
  const rpmLimit = findApiKeyLimit(limits, "rpm");
  const tokenLimit = findApiKeyLimit(limits, "token");
  const tpmLimit = findApiKeyLimit(limits, "tpm");
  const limitsEnabled = apiKey.limitsEnabled;

  return (
    <ConsoleDialog
      ariaLabelledby={`api-key-dialog-title-${apiKey.id}`}
      className="console-dialog"
      closeHref={closeHref}
      triggerId={`api-key-edit-${apiKey.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id={`api-key-dialog-title-${apiKey.id}`}>Edit {apiKey.name}</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ConsoleMutationForm
        action="/api/api-keys"
        className="provider-edit-form"
        fallbackError="API key update failed."
      >
        <input type="hidden" name="action" value="saveAll" />
        <input type="hidden" name="id" value={apiKey.id} />
        <label htmlFor={`api-key-name-${apiKey.id}`}>Name</label>
        <input id={`api-key-name-${apiKey.id}`} name="name" defaultValue={apiKey.name} required />
        <ApiKeyVirtualModelFields
          idPrefix={`api-key-${apiKey.id}`}
          initialDefaultVirtualModelId={access.defaultVirtualModel?.id ?? ""}
          initialSelectedVirtualModelIds={access.allowedVirtualModels.map(
            (virtualModel) => virtualModel.id,
          )}
          virtualModels={virtualModels.map(({ id, name }) => ({ id, name }))}
        />
        <label
          className="checkbox-label api-key-limit-toggle"
          htmlFor={`api-key-enable-limits-${apiKey.id}`}
        >
          <input
            id={`api-key-enable-limits-${apiKey.id}`}
            name="enableLimits"
            type="checkbox"
            value="true"
            defaultChecked={limitsEnabled}
          />
          <span>Enable limits</span>
        </label>
        <div className="api-key-limit-fields">
          <label htmlFor={`api-key-budget-usd-${apiKey.id}`}>Budget USD limit</label>
          <input
            id={`api-key-budget-usd-${apiKey.id}`}
            name="budgetUsd"
            type="number"
            min="0.000001"
            step="0.000001"
            defaultValue={budgetLimit?.limitValue ?? defaultApiKeyLimitFormValues.budgetUsd}
            required
          />
          <label htmlFor={`api-key-budget-period-${apiKey.id}`}>Budget period</label>
          <select
            id={`api-key-budget-period-${apiKey.id}`}
            name="budgetPeriod"
            defaultValue={budgetLimit?.period ?? defaultApiKeyLimitFormValues.budgetPeriod}
            required
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
          <label htmlFor={`api-key-rpm-${apiKey.id}`}>RPM limit</label>
          <input
            id={`api-key-rpm-${apiKey.id}`}
            name="rpm"
            type="number"
            min="1"
            step="1"
            defaultValue={rpmLimit?.limitValue ?? defaultApiKeyLimitFormValues.rpm}
            required
          />
          <label htmlFor={`api-key-tpm-${apiKey.id}`}>TPM limit</label>
          <input
            id={`api-key-tpm-${apiKey.id}`}
            name="tpm"
            type="number"
            min="1"
            step="1"
            defaultValue={tpmLimit?.limitValue ?? defaultApiKeyLimitFormValues.tpm}
            required
          />
          <label htmlFor={`api-key-concurrency-${apiKey.id}`}>Concurrency limit</label>
          <input
            id={`api-key-concurrency-${apiKey.id}`}
            name="concurrency"
            type="number"
            min="1"
            step="1"
            defaultValue={concurrencyLimit?.limitValue ?? defaultApiKeyLimitFormValues.concurrency}
            required
          />
          <label htmlFor={`api-key-token-limit-${apiKey.id}`}>Token limit</label>
          <input
            id={`api-key-token-limit-${apiKey.id}`}
            name="tokenLimit"
            type="number"
            min="1"
            step="1"
            defaultValue={tokenLimit?.limitValue ?? defaultApiKeyLimitFormValues.tokenLimit}
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

function ApiKeyDeleteDialog({ apiKey, closeHref }: { apiKey: ConsoleApiKey; closeHref: string }) {
  return (
    <ConsoleDialog
      ariaLabelledby={`api-key-delete-dialog-title-${apiKey.id}`}
      className="console-dialog api-key-delete-dialog"
      closeHref={closeHref}
      initialFocus="cancel"
      triggerId={`api-key-delete-${apiKey.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id={`api-key-delete-dialog-title-${apiKey.id}`}>Delete {apiKey.name}?</h2>
      </div>
      <p>This permanently removes the API key.</p>
      <div className="api-key-delete-actions">
        <a className="api-key-delete-cancel" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Cancel</span>
        </a>
        <ConsoleMutationForm action="/api/api-keys" fallbackError="API key deletion failed.">
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="id" value={apiKey.id} />
          <button className="api-key-delete-confirm" type="submit">
            <FlatIcon name="delete" />
            <span>Delete</span>
          </button>
        </ConsoleMutationForm>
      </div>
    </ConsoleDialog>
  );
}

function ApiKeyEnabledToggleForm({ apiKey }: { apiKey: ConsoleApiKey }) {
  if (apiKey.enabled) {
    return (
      <ConsoleMutationForm
        action="/api/api-keys"
        errorPresentation="toast"
        fallbackError="API key disable failed."
      >
        <input type="hidden" name="action" value="disable" />
        <input type="hidden" name="id" value={apiKey.id} />
        <button
          aria-label={`Disable ${apiKey.name}`}
          className="api-key-action-toggle row-action-button"
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
      action="/api/api-keys"
      errorPresentation="toast"
      fallbackError="API key enable failed."
    >
      <input type="hidden" name="action" value="enable" />
      <input type="hidden" name="id" value={apiKey.id} />
      <button
        aria-label={`Enable ${apiKey.name}`}
        className="api-key-action-toggle row-action-button"
        title="Enable"
        type="submit"
      >
        <FlatIcon name="enable" />
      </button>
    </ConsoleMutationForm>
  );
}

function filterApiKeys(
  apiKeys: ConsoleApiKey[],
  filters: { apiKeySearch: string },
): ConsoleApiKey[] {
  const normalizedSearch = filters.apiKeySearch.toLowerCase();
  if (!normalizedSearch) {
    return apiKeys;
  }
  return apiKeys.filter((apiKey) =>
    [apiKey.name, apiKey.keyPrefix ?? ""].some((value) =>
      value.toLowerCase().includes(normalizedSearch),
    ),
  );
}

function formatApiKeyKeyPrefixDisplay(keyPrefix: string): string {
  return keyPrefix.length <= 8 ? keyPrefix : `${keyPrefix.slice(0, 6)}...${keyPrefix.slice(-4)}`;
}

export async function ApiKeysSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const { apiKeyLimits, apiKeyVirtualModelAccess, apiKeys, usageToday, virtualModels } =
    await loadApiKeysSectionData();
  const apiKeyVirtualModelAccessByApiKeyId = new Map(
    apiKeyVirtualModelAccess.map((access) => [access.apiKeyId, access]),
  );
  const apiKeyLimitsByApiKeyId = groupByApiKeyId(apiKeyLimits);
  const enabledApiKeyCount = apiKeys.filter((apiKey) => apiKey.enabled).length;
  const usageTodayByApiKeyId = new Map(
    usageToday.apiKeyBreakdowns.map((apiKey) => [apiKey.id, apiKey]),
  );
  const apiKeySearch = readSingleSearchParam(searchParams.apiKeySearch)?.trim() ?? "";
  const visibleApiKeys = filterApiKeys(apiKeys, { apiKeySearch });
  const selectedApiKeyId = readSingleSearchParam(searchParams.selected);
  const apiKeyView = readSingleSearchParam(searchParams.apiKeyView);
  const viewDialogApiKey = apiKeys.find((apiKey) => apiKey.id === apiKeyView) ?? null;
  const viewDialogAccess = viewDialogApiKey
    ? (apiKeyVirtualModelAccessByApiKeyId.get(viewDialogApiKey.id) ?? null)
    : null;
  const viewDialogLimits = viewDialogApiKey
    ? (apiKeyLimitsByApiKeyId.get(viewDialogApiKey.id) ?? [])
    : [];
  const apiKeyViewCloseHref = buildQueryHref(searchParams, { apiKeyView: undefined });
  const apiKeyDialog = readSingleSearchParam(searchParams.apiKeyDialog);
  const editDialogApiKey = apiKeys.find((apiKey) => apiKey.id === apiKeyDialog) ?? null;
  const apiKeyDialogCloseHref = buildQueryHref(searchParams, {
    apiKeyDialog: undefined,
    apiKeyView: undefined,
  });
  const deleteApiKey = readSingleSearchParam(searchParams.deleteApiKey);
  const deleteDialogApiKey = apiKeys.find((apiKey) => apiKey.id === deleteApiKey) ?? null;
  const deleteDialogCloseHref = buildQueryHref(searchParams, {
    apiKeyView: undefined,
    deleteApiKey: undefined,
  });

  return (
    <section className="api-keys-dashboard" aria-label="API Keys">
      <div className="api-keys-shell">
        <div className="api-keys-main-column">
          <div className="stat-grid api-keys-stat-grid">
            <StatCard icon="AG" label="API Keys" value={String(apiKeys.length)} />
            <StatCard icon="ON" label="Enabled" value={String(enabledApiKeyCount)} />
            <StatCard
              icon="RQ"
              label="Requests 24h"
              value={formatConsoleCompactCount(usageToday.requestCount)}
            />
            <StatCard icon="$" label="Cost 24h" value={formatConsoleUsd(usageToday.totalCostUsd)} />
          </div>
          <form action="/api-keys" method="get">
            <fieldset className="api-keys-filter-bar">
              <legend className="sr-only">API Key filters</legend>
              <div className="console-field api-keys-search-field">
                <label htmlFor="api-key-filter-search" className="sr-only">
                  Search
                </label>
                <input
                  id="api-key-filter-search"
                  name="apiKeySearch"
                  defaultValue={apiKeySearch}
                  placeholder="Search API key name or note"
                />
              </div>
              <div className="api-keys-filter-actions">
                <button type="submit">
                  <span>Filter</span>
                </button>
              </div>
            </fieldset>
          </form>
          <div className="chart-card api-keys-list-card">
            <h2 className="chart-card-title">API Key list</h2>
            {apiKeys.length === 0 ? (
              <p>
                <a className="empty-state-action" href="?apiKeyDialog=new">
                  Create an API Key
                </a>{" "}
                to issue an API key and grant Virtual Model access.
              </p>
            ) : visibleApiKeys.length === 0 ? (
              <p>No API keys match the selected filters.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table bounded-table api-keys-table">
                  <thead>
                    <tr>
                      <th>Name</th>
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
                    {visibleApiKeys.map((apiKey) => {
                      const access = apiKeyVirtualModelAccessByApiKeyId.get(apiKey.id);
                      const usage = usageTodayByApiKeyId.get(apiKey.id);
                      const apiKeyViewHref = buildQueryHref(searchParams, {
                        apiKeyDialog: undefined,
                        apiKeyView: apiKey.id,
                        deleteApiKey: undefined,
                        selected: apiKey.id,
                      });
                      const isSelectedApiKey =
                        apiKey.id === selectedApiKeyId || apiKey.id === viewDialogApiKey?.id;
                      return (
                        <tr
                          className={isSelectedApiKey ? "is-selected" : "is-clickable"}
                          key={apiKey.id}
                        >
                          <td>
                            <a
                              className="table-row-link"
                              href={apiKeyViewHref}
                              id={`api-key-view-${apiKey.id}-trigger`}
                            >
                              {apiKey.name}
                            </a>
                          </td>
                          <td className="mono">
                            <a className="table-row-link" href={apiKeyViewHref}>
                              {apiKey.keyPrefix
                                ? formatApiKeyKeyPrefixDisplay(apiKey.keyPrefix)
                                : "No key"}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={apiKeyViewHref}>
                              {access?.defaultVirtualModel?.name ?? "None"}
                            </a>
                          </td>
                          <td>
                            <a
                              className="api-key-virtual-model-names table-row-link"
                              href={apiKeyViewHref}
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
                            <a className="table-row-link" href={apiKeyViewHref}>
                              {formatConsoleCompactCount(usage?.requestCount ?? 0)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={apiKeyViewHref}>
                              {formatConsoleUsd(usage?.totalCostUsd ?? null)}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={apiKeyViewHref}>
                              {apiKey.enabled ? "True" : "False"}
                            </a>
                          </td>
                          <td>
                            <span className="api-key-table-actions">
                              <ApiKeyEnabledToggleForm apiKey={apiKey} />
                              <a
                                aria-label={`Edit ${apiKey.name}`}
                                className="link-button api-key-action-edit row-action-button"
                                href={buildQueryHref(searchParams, {
                                  apiKeyDialog: apiKey.id,
                                  apiKeyView: undefined,
                                })}
                                id={`api-key-edit-${apiKey.id}-trigger`}
                                title="Edit"
                              >
                                <FlatIcon name="edit" />
                              </a>
                              <a
                                aria-label={`Delete ${apiKey.name}`}
                                className="link-button api-key-action-delete row-action-button row-action-danger"
                                href={buildQueryHref(searchParams, {
                                  apiKeyDialog: undefined,
                                  apiKeyView: undefined,
                                  deleteApiKey: apiKey.id,
                                })}
                                id={`api-key-delete-${apiKey.id}-trigger`}
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
      {viewDialogApiKey ? (
        <ApiKeyViewDialog
          access={viewDialogAccess}
          apiKey={viewDialogApiKey}
          closeHref={apiKeyViewCloseHref}
          limits={viewDialogLimits}
        />
      ) : null}
      {apiKeyDialog === "new" ? (
        <ApiKeyCreateDialog closeHref={apiKeyDialogCloseHref} virtualModels={virtualModels} />
      ) : null}
      {editDialogApiKey ? (
        <ApiKeyEditDialog
          apiKey={editDialogApiKey}
          access={
            apiKeyVirtualModelAccessByApiKeyId.get(editDialogApiKey.id) ?? {
              apiKeyId: editDialogApiKey.id,
              allowedVirtualModels: [],
              defaultVirtualModel: null,
            }
          }
          closeHref={apiKeyDialogCloseHref}
          limits={apiKeyLimitsByApiKeyId.get(editDialogApiKey.id) ?? []}
          virtualModels={virtualModels}
        />
      ) : null}
      {deleteDialogApiKey ? (
        <ApiKeyDeleteDialog apiKey={deleteDialogApiKey} closeHref={deleteDialogCloseHref} />
      ) : null}
    </section>
  );
}

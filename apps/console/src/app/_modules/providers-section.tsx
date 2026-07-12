import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import {
  listProviderApiKeyMetadata,
  type ProviderApiKeyMetadata,
} from "@llmingress/db/console-provider-keys";
import { listConsoleProviderOAuthConnections } from "@llmingress/db/console-provider-oauth";
import { listProviderTemplateSelectorGroups } from "@llmingress/db/console-provider-templates";
import {
  type ConsoleProvider,
  getProviderDependencyImpact,
  listProviders,
  type ProviderDependencyImpact,
} from "@llmingress/db/console-providers";
import { listProviderModelPage } from "@llmingress/db/console-route-policies";
import { ConsoleDialog } from "../_components/console-dialog";
import { ConsoleMutationForm } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { buildQueryHref } from "../_lib/pagination";
import { ProviderCreateForm } from "./provider-create-form";
import { ProviderKeyCreateDialogClient } from "./provider-key-create-dialog-client";
import { ProvidersClientSection } from "./providers-client-section";
import {
  type ConsoleSearchParams,
  getConsoleProviderOrder,
  readSingleSearchParam,
} from "./sections";

const providerTemplateGroups = listProviderTemplateSelectorGroups();

const directProviderCreateChoices = [
  {
    action: "create",
    baseUrlMode: "fixed_create",
    displayName: "OpenAI",
    fixedBaseUrl: "https://api.openai.com/v1",
    groupId: "remote_api_key",
    groupLabel: "API Keys",
    id: "openai",
    providerKey: "openai",
    providerType: "api_key",
  },
  {
    action: "create",
    baseUrlMode: "fixed_create",
    displayName: "Anthropic",
    fixedBaseUrl: "https://api.anthropic.com/v1",
    groupId: "remote_api_key",
    groupLabel: "API Keys",
    id: "anthropic",
    providerKey: "anthropic",
    providerType: "api_key",
  },
] as const;

const defaultProviderCreateChoice = directProviderCreateChoices[0];

const providerCreateChoices = [
  ...directProviderCreateChoices,
  ...providerTemplateGroups.flatMap((group) =>
    group.templates.map((template) => ({
      action: "createFromTemplate",
      baseUrlMode: template.baseUrlMode,
      baseUrlPlaceholder: template.baseUrlPlaceholder,
      displayName: template.displayName,
      fixedBaseUrl: template.fixedBaseUrl,
      groupId: group.id,
      groupLabel: group.label,
      id: template.id,
      providerKey: template.providerKey,
      providerType: template.providerType,
    })),
  ),
];

function ProviderCreateDialog({
  closeHref,
  error,
  errorField,
  formValues,
}: {
  closeHref: string;
  error?: string;
  errorField?: string;
  formValues: { baseUrl: string; displayName: string; providerKey: string };
}) {
  const formError = error && errorField === "form" ? error : undefined;
  const providerKeyError = errorField === "providerKey" ? error : undefined;
  const displayNameError = errorField === "displayName" ? error : undefined;
  const baseUrlError = errorField === "baseUrl" ? error : undefined;
  const selectedChoice =
    providerCreateChoices.find((choice) => choice.providerKey === formValues.providerKey) ??
    defaultProviderCreateChoice;

  return (
    <ConsoleDialog
      ariaLabelledby="new-provider-dialog-title"
      className="console-dialog provider-create-dialog"
      closeHref={closeHref}
      triggerId="provider-create-dialog-trigger"
    >
      <div className="console-dialog-head">
        <h2 id="new-provider-dialog-title">Add Provider</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ProviderCreateForm
        baseUrlError={baseUrlError}
        choices={providerCreateChoices}
        displayNameError={displayNameError}
        formError={formError}
        initialBaseUrl={formValues.baseUrl}
        initialDisplayName={formValues.displayName}
        initialProviderKey={selectedChoice.providerKey}
        providerKeyError={providerKeyError}
      />
    </ConsoleDialog>
  );
}

function ProviderEditDialog({
  closeHref,
  error,
  errorField,
  formValues,
  provider,
}: {
  closeHref: string;
  error?: string;
  errorField?: string;
  formValues: { baseUrl: string; displayName: string };
  provider: ConsoleProvider;
}) {
  const formError = error && errorField === "form" ? error : undefined;
  const displayNameError = errorField === "displayName" ? error : undefined;
  const baseUrlError = errorField === "baseUrl" ? error : undefined;

  return (
    <ConsoleDialog
      ariaLabelledby="edit-provider-dialog-title"
      className="console-dialog provider-edit-dialog"
      closeHref={closeHref}
      triggerId={`provider-edit-${provider.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id="edit-provider-dialog-title">Edit {provider.displayName}</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <ConsoleMutationForm
        action="/api/providers"
        className="provider-create-form"
        fallbackError="Provider update failed."
      >
        <input type="hidden" name="action" value="update" />
        <input type="hidden" name="id" value={provider.id} />
        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}
        <label htmlFor="provider-edit-display-name">Provider display name</label>
        <input
          aria-describedby="provider-edit-display-name-error"
          aria-invalid={displayNameError ? true : undefined}
          className={displayNameError ? "is-invalid" : undefined}
          defaultValue={formValues.displayName}
          id="provider-edit-display-name"
          name="displayName"
          required
        />
        <p
          className={displayNameError ? "field-error is-visible" : "field-error"}
          id="provider-edit-display-name-error"
        >
          {displayNameError}
        </p>
        <label htmlFor="provider-edit-base-url">Provider base URL</label>
        <input
          aria-describedby="provider-edit-base-url-error"
          aria-invalid={baseUrlError ? true : undefined}
          className={baseUrlError ? "is-invalid" : undefined}
          defaultValue={formValues.baseUrl}
          id="provider-edit-base-url"
          name="baseUrl"
          readOnly={Boolean(provider.providerTemplateId)}
          type="url"
        />
        <p
          className={baseUrlError ? "field-error is-visible" : "field-error"}
          id="provider-edit-base-url-error"
        >
          {baseUrlError}
        </p>
        <button type="submit">
          <span>Save</span>
        </button>
      </ConsoleMutationForm>
    </ConsoleDialog>
  );
}

function ProviderOAuthCreateDialog({
  authorizeUrl,
  closeHref,
  error,
  labelValue,
  provider,
  providerOAuthId,
  priorityValue,
}: {
  authorizeUrl?: string;
  closeHref: string;
  error?: string;
  labelValue?: string;
  provider: ConsoleProvider;
  providerOAuthId?: string;
  priorityValue?: string;
}) {
  const hasPendingAuthorization = Boolean(authorizeUrl && providerOAuthId);
  const priorityDefaultValue = priorityValue ?? "100";

  return (
    <ConsoleDialog
      ariaLabelledby="provider-oauth-create-title"
      className="console-dialog provider-key-dialog"
      closeHref={closeHref}
      triggerId={`provider-key-${provider.id}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id="provider-oauth-create-title">New {provider.displayName} OAuth connection</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {hasPendingAuthorization ? (
        <>
          <div className="provider-create-form">
            <label htmlFor="provider-oauth-authorize-url">Authorization URL</label>
            <textarea
              id="provider-oauth-authorize-url"
              readOnly
              rows={4}
              defaultValue={authorizeUrl}
            />
            <a
              className="oauth-open-link secondary-button"
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
            >
              <FlatIcon name="view" />
              <span>Open authorization URL</span>
            </a>
          </div>
          <ConsoleMutationForm
            action="/api/provider-oauth"
            className="provider-create-form"
            fallbackError="Provider OAuth connection failed."
          >
            <input type="hidden" name="action" value="complete" />
            <input type="hidden" name="providerId" value={provider.id} />
            <input type="hidden" name="providerOAuthId" value={providerOAuthId} />
            <input type="hidden" name="providerAuthorizeUrl" value={authorizeUrl} />
            <label htmlFor="provider-oauth-complete-label">Label</label>
            <input
              id="provider-oauth-complete-label"
              maxLength={100}
              name="label"
              type="text"
              defaultValue={labelValue ?? ""}
            />
            <label htmlFor="provider-oauth-complete-priority">Priority</label>
            <input
              defaultValue={priorityDefaultValue}
              id="provider-oauth-complete-priority"
              max={100}
              min={0}
              name="priority"
              step={1}
              type="number"
            />
            <label htmlFor="provider-oauth-callback-input">
              Callback URL or authorization code
            </label>
            <textarea id="provider-oauth-callback-input" name="callbackInput" required rows={4} />
            <button className="oauth-action-button" type="submit">
              <FlatIcon name="confirm" />
              <span>Connect OAuth</span>
            </button>
          </ConsoleMutationForm>
        </>
      ) : null}
    </ConsoleDialog>
  );
}

function ProviderDeleteDialog({
  closeHref,
  impact,
  provider,
}: {
  closeHref: string;
  impact: ProviderDependencyImpact;
  provider: ConsoleProvider;
}) {
  const hasBlockers = impact.routePolicies.length > 0 || impact.runningJobCount > 0;

  return (
    <ConsoleDialog
      ariaLabelledby="provider-delete-title"
      className="console-dialog agent-delete-dialog"
      closeHref={closeHref}
      initialFocus="cancel"
      triggerId={`provider-delete-${provider.id}-trigger`}
    >
      <h2 id="provider-delete-title">Delete provider?</h2>
      {hasBlockers ? (
        <p>
          {provider.displayName} cannot be deleted while active Route Policies or running jobs still
          depend on it.
        </p>
      ) : (
        <p>
          This removes {provider.displayName} from the provider list and clears its credentials and
          runtime health data.
        </p>
      )}
      {impact.providerModels.length > 0 ? (
        <div className="agent-delete-warning">
          <p>Provider Models referenced by active Route Policies:</p>
          <ul>
            {impact.providerModels.map((model) => (
              <li key={model.id}>
                {model.displayName} ({model.modelId})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impact.virtualModels.length > 0 ? (
        <div className="agent-delete-warning">
          <p>Virtual Models using this provider:</p>
          <ul>
            {impact.virtualModels.map((virtualModel) => (
              <li key={virtualModel.id}>
                <a href="/models">{virtualModel.name}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impact.routePolicies.length > 0 ? (
        <div className="agent-delete-warning">
          <p>Route Policies to update first:</p>
          <ul>
            {impact.routePolicies.map((routePolicy) => (
              <li key={routePolicy.id}>
                <a href="/models">{routePolicy.virtualModelName}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impact.agents.length > 0 ? (
        <div className="agent-delete-warning">
          <p>Agents affected by those Virtual Models:</p>
          <ul>
            {impact.agents.map((agent) => (
              <li key={agent.id}>
                <a href={`/agents?selected=${agent.id}`}>{agent.name}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p>
        Cleanup impact: {impact.apiKeyCount} API keys, {impact.oauthConnectionCount} OAuth
        connections, {impact.pendingJobCount} pending jobs, {impact.runningJobCount} running jobs.
      </p>
      <div className="agent-delete-actions">
        <a className="agent-delete-cancel" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Cancel</span>
        </a>
        {hasBlockers ? null : (
          <ConsoleMutationForm action="/api/providers" fallbackError="Provider deletion failed.">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value={provider.id} />
            <button className="agent-delete-confirm" type="submit">
              <FlatIcon name="delete" />
              <span>Delete provider</span>
            </button>
          </ConsoleMutationForm>
        )}
      </div>
    </ConsoleDialog>
  );
}

function ProviderKeyDeleteDialog({
  closeHref,
  keyPrefix,
  providerApiKeyId,
  provider,
}: {
  closeHref: string;
  keyPrefix: string;
  providerApiKeyId: string;
  provider: ConsoleProvider;
}) {
  return (
    <ConsoleDialog
      ariaLabelledby="provider-key-delete-title"
      className="console-dialog agent-delete-dialog"
      closeHref={closeHref}
      initialFocus="cancel"
      triggerId={`provider-key-delete-${providerApiKeyId}-trigger`}
    >
      <h2 id="provider-key-delete-title">Delete API key?</h2>
      <p>
        This removes key {keyPrefix} from {provider.displayName}.
      </p>
      <div className="agent-delete-actions">
        <a className="agent-delete-cancel" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Cancel</span>
        </a>
        <ConsoleMutationForm
          action="/api/provider-keys"
          fallbackError="Provider API key deletion failed."
        >
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="providerApiKeyId" value={providerApiKeyId} />
          <button className="agent-delete-confirm" type="submit">
            <FlatIcon name="delete" />
            <span>Delete key</span>
          </button>
        </ConsoleMutationForm>
      </div>
    </ConsoleDialog>
  );
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

function orderProvidersForConsole(providers: ConsoleProvider[]): ConsoleProvider[] {
  return [...providers].sort((left, right) => {
    const leftOrder = getConsoleProviderOrder(left.providerKey);
    const rightOrder = getConsoleProviderOrder(right.providerKey);
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}
export async function ProvidersSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const renderedAtMs = Date.now();
  const [providerRows, providerHealthSummaries, providerKeys, providerOAuthConnections] =
    await Promise.all([
      listProviders(),
      listConsoleProviderHealthSummaries(),
      listProviderApiKeyMetadata(),
      listConsoleProviderOAuthConnections(),
    ]);
  const providers = orderProvidersForConsole(providerRows);
  const providerKeysByProviderId = groupProviderKeysByProviderId(providerKeys);
  const providerDialog = readSingleSearchParam(searchParams.providerDialog);
  const providerDelete = readSingleSearchParam(searchParams.providerDelete);
  const providerError = readSingleSearchParam(searchParams.providerError);
  const providerErrorField = readSingleSearchParam(searchParams.providerErrorField);
  const providerDialogCloseHref = buildQueryHref(searchParams, {
    providerBaseUrlValue: undefined,
    providerDialog: undefined,
    providerDisplayNameValue: undefined,
    providerError: undefined,
    providerErrorField: undefined,
    providerKeyValue: undefined,
  });
  const providerDeleteCloseHref = buildQueryHref(searchParams, {
    providerDelete: undefined,
  });
  const providerFormValues = {
    baseUrl: readSingleSearchParam(searchParams.providerBaseUrlValue) ?? "",
    displayName: readSingleSearchParam(searchParams.providerDisplayNameValue) ?? "",
    providerKey: readSingleSearchParam(searchParams.providerKeyValue) ?? "",
  };
  const providerKeyDialog = readSingleSearchParam(searchParams.providerKeyDialog);
  const providerKeyDelete = readSingleSearchParam(searchParams.providerKeyDelete);
  const providerOAuthError = readSingleSearchParam(searchParams.providerOAuthError);
  const providerOAuthId = readSingleSearchParam(searchParams.providerOAuthId);
  const providerOAuthLabelValue = readSingleSearchParam(searchParams.providerOAuthLabelValue);
  const providerOAuthPriorityValue = readSingleSearchParam(searchParams.providerOAuthPriorityValue);
  const providerAuthorizeUrl = readSingleSearchParam(searchParams.providerAuthorizeUrl);
  const providerKeyDialogCloseHref = buildQueryHref(searchParams, {
    providerKeyDelete: undefined,
    providerKeyDialog: undefined,
    providerAuthorizeUrl: undefined,
    providerOAuthError: undefined,
    providerOAuthId: undefined,
    providerOAuthLabelValue: undefined,
    providerOAuthPriorityValue: undefined,
  });
  const editDialogProvider =
    providerDialog && providerDialog !== "new"
      ? (providers.find((provider) => provider.id === providerDialog) ?? null)
      : null;
  const deleteDialogProvider = providers.find((provider) => provider.id === providerDelete) ?? null;
  const selectedProviderId = readSingleSearchParam(searchParams.selected);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers.find((provider) => provider.providerKey === "openai") ??
    providers[0] ??
    null;
  const modelQuery = readSingleSearchParam(searchParams.modelQuery)?.trim() ?? "";
  const parsedModelPage = Number.parseInt(readSingleSearchParam(searchParams.modelPage) ?? "1", 10);
  const modelPage = Number.isInteger(parsedModelPage) && parsedModelPage > 0 ? parsedModelPage : 1;
  const [providerModelPage, deleteProviderImpact] = await Promise.all([
    selectedProvider
      ? listProviderModelPage({
          page: modelPage,
          providerId: selectedProvider.id,
          query: modelQuery,
        })
      : Promise.resolve({ items: [], page: 1, pageCount: 1, total: 0 }),
    deleteDialogProvider
      ? getProviderDependencyImpact({ providerId: deleteDialogProvider.id })
      : Promise.resolve(null),
  ]);
  const selectedProviderKeys = selectedProvider
    ? (providerKeysByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const deleteProviderKey = selectedProviderKeys.find(
    (providerKey) => providerKey.id === providerKeyDelete,
  );

  return (
    <section className="providers-dashboard" aria-label="Providers & Models">
      <ProvidersClientSection
        initialSelectedProviderId={selectedProviderId ?? undefined}
        providerHealthSummaries={providerHealthSummaries}
        providerKeys={providerKeys}
        providerModelPage={providerModelPage}
        providerOAuthConnections={providerOAuthConnections}
        providers={providers}
        renderedAtMs={renderedAtMs}
        modelQuery={modelQuery}
        searchParams={searchParams}
      />
      {providerDialog === "new" ? (
        <ProviderCreateDialog
          closeHref={providerDialogCloseHref}
          error={providerError}
          errorField={providerErrorField}
          formValues={providerFormValues}
        />
      ) : null}
      {providerKeyDialog && selectedProvider ? (
        selectedProvider.providerType === "subscription" ? (
          <ProviderOAuthCreateDialog
            authorizeUrl={providerAuthorizeUrl}
            closeHref={providerKeyDialogCloseHref}
            error={providerOAuthError}
            labelValue={providerOAuthLabelValue}
            provider={selectedProvider}
            providerOAuthId={providerOAuthId}
            priorityValue={providerOAuthPriorityValue}
          />
        ) : (
          <ProviderKeyCreateDialogClient
            closeHref={providerKeyDialogCloseHref}
            providerId={selectedProvider.id}
            providerName={selectedProvider.displayName}
          />
        )
      ) : null}
      {deleteProviderKey && selectedProvider ? (
        <ProviderKeyDeleteDialog
          closeHref={providerKeyDialogCloseHref}
          keyPrefix={deleteProviderKey.keyPrefix}
          providerApiKeyId={deleteProviderKey.id}
          provider={selectedProvider}
        />
      ) : null}
      {deleteDialogProvider ? (
        <ProviderDeleteDialog
          closeHref={providerDeleteCloseHref}
          impact={
            deleteProviderImpact ?? {
              agents: [],
              apiKeyCount: 0,
              oauthConnectionCount: 0,
              pendingJobCount: 0,
              providerId: deleteDialogProvider.id,
              providerModels: [],
              routePolicies: [],
              runningJobCount: 0,
              virtualModels: [],
            }
          }
          provider={deleteDialogProvider}
        />
      ) : null}
      {editDialogProvider ? (
        <ProviderEditDialog
          closeHref={providerDialogCloseHref}
          error={providerError}
          errorField={providerErrorField}
          formValues={{
            baseUrl: providerFormValues.baseUrl || editDialogProvider.baseUrl || "",
            displayName: providerFormValues.displayName || editDialogProvider.displayName,
          }}
          provider={editDialogProvider}
        />
      ) : null}
    </section>
  );
}

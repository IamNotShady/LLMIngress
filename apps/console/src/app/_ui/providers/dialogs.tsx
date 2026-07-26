import { listDirectCreateEntries } from "@llmingress/config/provider-registry";
import type { ConsoleProviderQuotaSummary } from "@llmingress/db/console-provider-quota";
import type { ProviderTemplateSelectorGroup } from "@llmingress/db/console-provider-templates";
import type { ConsoleProvider, ProviderDependencyImpact } from "@llmingress/db/console-providers";
import type { ConsoleUsageSummary } from "@llmingress/db/console-usage";
import Link from "next/link";
import { ConfirmForm, TypeNameToConfirm } from "../confirm-form";
import { ActionButton, ActionLink, Field, SelectInput, TextInput } from "../controls";
import { CopyButton } from "../copy-button";
import { formatCost, formatCount } from "../format";
import { DetailRow } from "../layout";
import { MutationForm } from "../mutation-form";
import { Dialog, DialogActions, DialogBody, DialogImpact, DialogNote } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";
import { DeviceCodePoller } from "./device-poller";
import { ExpiryCountdown } from "./expiry-countdown";
import {
  describeProviderCapabilities,
  listAddProviderGroups,
  type ProviderConnection,
  providerIsMetered,
} from "./model";

export function ProviderDialogs({
  connections,
  dependencyImpact,
  params,
  provider,
  quotas,
  templateGroups,
  usage,
}: {
  connections: ProviderConnection[];
  dependencyImpact: ProviderDependencyImpact | null;
  params: SearchParams;
  provider: ConsoleProvider | undefined;
  quotas: ConsoleProviderQuotaSummary[];
  templateGroups: ProviderTemplateSelectorGroup[];
  usage: ConsoleUsageSummary;
}) {
  const dialog = readParam(params, "dialog");
  const credentialProviderId = readParam(params, "providerKeyDialog");
  const closeHref = buildHref("/providers", params, {
    connection: null,
    dialog: null,
    providerAuthorizeUrl: null,
    providerKeyDialog: null,
    providerOAuthError: null,
    providerOAuthErrorCode: null,
    providerOAuthId: null,
    providerOAuthInterval: null,
    providerOAuthUserCode: null,
    providerOAuthVerificationUri: null,
    template: null,
  });

  if (dialog === "new") {
    return <AddProviderDialog closeHref={closeHref} params={params} groups={templateGroups} />;
  }
  if (!provider) {
    return null;
  }
  // A link that names a connection has to find it. Falling back to "add one"
  // would ask for a new credential under a title that reads like an edit of the
  // connection that is gone.
  const namedConnectionId = readParam(params, "connection");
  const namedConnection = namedConnectionId
    ? (connections.find((entry) => entry.id === namedConnectionId) ?? null)
    : null;
  if (namedConnectionId && !namedConnection) {
    return <MissingConnectionDialog closeHref={closeHref} />;
  }
  if (credentialProviderId === provider.id) {
    return (
      <CredentialDialog
        closeHref={closeHref}
        connections={connections}
        params={params}
        provider={provider}
        quotas={quotas}
      />
    );
  }
  if (dialog === "edit") {
    return <EditProviderDialog closeHref={closeHref} provider={provider} />;
  }
  if (dialog === "delete") {
    return (
      <DeleteProviderDialog
        closeHref={closeHref}
        connections={connections}
        dependencyImpact={dependencyImpact}
        provider={provider}
        usage={usage}
      />
    );
  }
  if (dialog === "disable" || dialog === "enable") {
    return (
      <ProviderStateDialog closeHref={closeHref} enable={dialog === "enable"} provider={provider} />
    );
  }
  if (dialog === "deleteConnection") {
    const connection = namedConnection ?? undefined;
    if (connection?.kind === "local") {
      return (
        <LocalConnectionDeleteDialog
          closeHref={closeHref}
          deleteProviderHref={buildHref("/providers", params, {
            connection: null,
            dialog: "delete",
          })}
          provider={provider}
        />
      );
    }
    return connection ? (
      <DeleteConnectionDialog closeHref={closeHref} connection={connection} provider={provider} />
    ) : (
      <MissingConnectionDialog closeHref={closeHref} />
    );
  }
  return null;
}

function EndpointChips({ providerKey }: { providerKey: string }) {
  const { endpoints, quotaNote } = describeProviderCapabilities(providerKey);
  return (
    <>
      <div className="mt-4 flex items-center gap-[10px] border-b border-hair pb-[5px]">
        <span className="flex-none whitespace-nowrap font-mono text-115 font-medium tracking-[.08em] text-dim">
          SUPPORTED ENDPOINTS
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-12 text-faint">{quotaNote}</span>
      </div>
      <ul aria-label="Supported endpoints" className="mt-2 flex list-none flex-wrap gap-[6px] p-0">
        {endpoints.length === 0 ? (
          <li className="font-mono text-12 text-faint">
            No routable endpoint is declared for this template.
          </li>
        ) : (
          endpoints.map((endpoint) => (
            <li
              key={endpoint.protocol}
              className="flex items-center gap-[7px] rounded-xs border border-btnbd bg-btnbg px-[9px] py-[3px] font-mono text-12 text-ink"
            >
              <span className="font-medium">{endpoint.protocol}</span>
              <span className="text-dim">{endpoint.path}</span>
            </li>
          ))
        )}
      </ul>
      <DialogNote>
        A virtual model built on this provider must use one of these endpoint protocols — candidates
        whose protocol it does not serve are not selectable.
      </DialogNote>
    </>
  );
}

function AddProviderDialog({
  closeHref,
  groups,
  params,
}: {
  closeHref: string;
  groups: ProviderTemplateSelectorGroup[];
  params: SearchParams;
}) {
  const choiceGroups = listAddProviderGroups(groups, listDirectCreateEntries());
  const activeGroupId = readParam(params, "dialogTab") ?? "remote_api_key";
  const group = choiceGroups.find((entry) => entry.id === activeGroupId) ?? choiceGroups[0];
  const templates = group?.items ?? [];
  const selectedId = readParam(params, "template") ?? templates[0]?.id;
  const template = templates.find((entry) => entry.id === selectedId) ?? templates[0];

  return (
    <Dialog closeHref={closeHref} title="Add Provider" width={720}>
      <div
        role="tablist"
        aria-label="Provider template groups"
        className="mt-4 flex border-b border-hair"
      >
        {choiceGroups.map((entry) => (
          <Link
            key={entry.id}
            role="tab"
            aria-selected={entry.id === group?.id}
            href={buildHref("/providers", params, {
              dialog: "new",
              dialogTab: entry.id,
              template: null,
            })}
            className={`flex flex-none items-baseline gap-[7px] whitespace-nowrap px-[14px] py-[7px] font-mono text-14 ${
              entry.id === group?.id
                ? "font-medium text-ink shadow-[inset_0_-2px_0_var(--accent)]"
                : "text-dim"
            }`}
          >
            {entry.label}
            <span aria-hidden="true" className="font-mono text-12 text-faint">
              {entry.items.length}
            </span>
          </Link>
        ))}
        <span className="ml-auto self-center font-mono text-12 text-faint">
          the template fixes the wire protocol and default base url
        </span>
      </div>

      <div className="mt-[14px] grid grid-cols-4 gap-2 overflow-x-auto">
        {templates.map((entry) => (
          <Link
            key={entry.id}
            aria-pressed={entry.id === template?.id}
            href={buildHref("/providers", params, {
              dialog: "new",
              dialogTab: group?.id ?? "remote_api_key",
              template: entry.id,
            })}
            className={`flex items-center gap-2 rounded-xs border bg-btnbg px-[9px] py-[7px] ${
              entry.id === template?.id
                ? "border-accent shadow-[inset_0_0_0_1px_var(--accent)]"
                : "border-btnbd"
            }`}
          >
            <span
              aria-hidden="true"
              className="grid size-[18px] flex-none place-items-center rounded-[2px] bg-track font-mono text-12 font-medium text-dim"
            >
              {entry.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="font-mono text-13 text-ink cell-clip">{entry.displayName}</span>
          </Link>
        ))}
      </div>

      {template ? (
        <MutationForm
          action="/api/providers"
          fallbackError="The provider could not be created."
          invalidFieldOnError="baseUrl"
        >
          {/* OpenAI and Anthropic are registered directly rather than as
              templates, so they are created by provider key instead. */}
          <input
            type="hidden"
            name="action"
            value={template.mode === "direct" ? "create" : "createFromTemplate"}
          />
          {template.mode === "direct" ? (
            <>
              <input type="hidden" name="providerKey" value={template.providerKey} />
              <input type="hidden" name="providerType" value={template.providerType} />
            </>
          ) : (
            <input type="hidden" name="templateId" value={template.id} />
          )}
          <div className="mt-[18px] grid grid-cols-2 gap-3">
            <Field label="DISPLAY NAME">
              <TextInput
                key={`${template.id}-name`}
                aria-label="Provider display name"
                name="displayName"
                defaultValue={template.displayName}
                required
              />
            </Field>
            <Field label="BASE URL" labelNote="(template default)">
              <TextInput
                key={`${template.id}-base`}
                aria-label="Provider base URL"
                name="baseUrl"
                defaultValue={template.baseUrl}
              />
            </Field>
          </div>
          <EndpointChips providerKey={template.providerKey} />
          <DialogActions>
            <ActionButton size="dialog" tone="primary">
              Create
            </ActionButton>
            <ActionLink href={closeHref}>Cancel</ActionLink>
            <span className="ml-1 font-mono text-125 text-faint">
              Credentials are added per connection once the provider exists.
            </span>
          </DialogActions>
        </MutationForm>
      ) : null}
    </Dialog>
  );
}

function EditProviderDialog({
  closeHref,
  provider,
}: {
  closeHref: string;
  provider: ConsoleProvider;
}) {
  return (
    <Dialog
      closeHref={closeHref}
      title="Edit provider"
      titleNote={`${provider.displayName} · ${provider.providerType}`}
      width={720}
    >
      <MutationForm
        action="/api/providers"
        fallbackError="The provider could not be saved."
        invalidFieldOnError="baseUrl"
        onSuccessHref={closeHref}
      >
        <input type="hidden" name="action" value="update" />
        <input type="hidden" name="id" value={provider.id} />
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="DISPLAY NAME">
            <TextInput name="displayName" defaultValue={provider.displayName} required />
          </Field>
          <Field label="BASE URL" labelNote="(template default)">
            <TextInput name="baseUrl" defaultValue={provider.baseUrl ?? ""} />
          </Field>
        </div>
        <div className="mt-[14px] grid grid-cols-2 gap-4">
          <Field label="TEMPLATE" labelNote="(fixed after creation)">
            <TextInput
              defaultValue={provider.providerTemplateId ?? provider.providerKey}
              disabled
              className="opacity-55"
            />
          </Field>
          <Field label="PROVIDER TYPE" labelNote="(fixed after creation)">
            <TextInput defaultValue={provider.providerType} disabled className="opacity-55" />
          </Field>
        </div>
        <EndpointChips providerKey={provider.providerKey} />
        <DialogNote>
          Changing the base url re-probes every connection and refreshes the model list. Template
          and provider type are fixed after creation; credentials are managed per connection.
        </DialogNote>
        <DialogActions>
          <ActionButton size="dialog" tone="primary">
            Save
          </ActionButton>
          <ActionLink href={closeHref}>Cancel</ActionLink>
        </DialogActions>
      </MutationForm>
    </Dialog>
  );
}

function ProviderStateDialog({
  closeHref,
  enable,
  provider,
}: {
  closeHref: string;
  enable: boolean;
  provider: ConsoleProvider;
}) {
  return (
    <Dialog
      closeHref={closeHref}
      tag={enable ? undefined : "traffic stops"}
      title={enable ? "Enable provider" : "Disable provider"}
      width={480}
    >
      <DialogBody>
        {enable ? (
          <>
            <strong className="font-medium">{provider.displayName}</strong> re-enters routing and
            every connection is probed again. Virtual models listing its models can serve traffic
            from it as soon as a probe succeeds.
          </>
        ) : (
          <>
            Virtual models stop routing to{" "}
            <strong className="font-medium">{provider.displayName}</strong> immediately. A route
            left with no other candidate stops serving.
          </>
        )}
      </DialogBody>
      <DialogNote>
        {enable
          ? "Nothing else changes — connections, credentials and model list are already stored."
          : "Configuration, credentials and the model list are preserved. Deleting is the permanent option."}
      </DialogNote>
      <ConfirmForm
        action="/api/providers"
        confirmLabel={enable ? "Enable provider" : "Disable provider"}
        onSuccessHref={closeHref}
        hiddenFields={{ action: enable ? "enable" : "disable", id: provider.id }}
        tone="primary"
      >
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </ConfirmForm>
    </Dialog>
  );
}

function DeleteProviderDialog({
  closeHref,
  connections,
  dependencyImpact,
  provider,
  usage,
}: {
  closeHref: string;
  connections: ProviderConnection[];
  dependencyImpact: ProviderDependencyImpact | null;
  provider: ConsoleProvider;
  usage: ConsoleUsageSummary;
}) {
  const breakdown = usage.providerBreakdowns.find((entry) => entry.id === provider.id);
  // A route still pointing here is refused by the API, so the dialog says which
  // routes hold it and offers the way out rather than a button that will fail.
  const blockingRoutes = dependencyImpact?.routePolicies ?? [];
  return (
    <Dialog closeHref={closeHref} danger tag="permanent" title="Delete provider" width={520}>
      <DialogBody>
        Deleting <strong className="font-medium">{provider.displayName}</strong> removes its
        connections and stored credentials. Any virtual model candidate pointing at its models is
        dropped from the route — a route left with no candidate stops serving.
      </DialogBody>
      <DialogImpact>
        <DetailRow label="connections" value={`${connections.length} · credentials erased`} />
        <DetailRow label="models" value={formatCount(provider.providerModelCount)} />
        <DetailRow label="requests 24h" value={formatCount(breakdown?.requestCount ?? 0)} />
        <DetailRow
          label="cost 24h"
          value={formatCost(breakdown?.totalCostUsd ?? null, {
            metered: providerIsMetered(provider),
          })}
        />
        <DetailRow label="activity history" value="kept, attributed to the name snapshot" />
        {dependencyImpact ? (
          <DetailRow
            label="held by"
            value={
              blockingRoutes.length === 0
                ? "no route — nothing depends on it"
                : blockingRoutes.map((route) => route.virtualModelName).join(", ")
            }
          />
        ) : null}
      </DialogImpact>
      {blockingRoutes.length > 0 ? (
        <>
          <DialogNote>
            This cannot be deleted while a route still points at it — the save would be refused.
            Remove {provider.displayName} from{" "}
            {blockingRoutes.map((route) => route.virtualModelName).join(", ")} first, or disable the
            provider to take it out of routing and keep its configuration.
          </DialogNote>
          <DialogActions>
            <ActionLink href="/models">Open Virtual Models</ActionLink>
            <ActionLink href={closeHref}>Cancel</ActionLink>
          </DialogActions>
        </>
      ) : (
        <TypeNameToConfirm
          action="/api/providers"
          confirmLabel="Delete provider"
          onSuccessHref="/providers"
          hiddenFields={{ action: "delete", id: provider.id }}
          label="TYPE THE PROVIDER NAME TO CONFIRM"
          name={provider.displayName}
        >
          <ActionLink href={closeHref}>Cancel</ActionLink>
          <span className="ml-1 font-mono text-12 text-dim">
            Disable instead — keeps config and removes it from routing
          </span>
        </TypeNameToConfirm>
      )}
    </Dialog>
  );
}

/**
 * The URL names a connection this provider does not have — deleted in another
 * tab, or a link carrying someone else's connection. Rendering nothing would
 * leave the operator looking at a page that ignored their click, so it says
 * what it knows, which is not that anything was deleted.
 */
function MissingConnectionDialog({ closeHref }: { closeHref: string }) {
  return (
    <Dialog closeHref={closeHref} title="Connection not found" width={460}>
      <DialogBody>
        This provider has no connection with that id — it was deleted, or the link named a
        connection of another provider. Nothing was changed.
      </DialogBody>
      <DialogActions>
        <ActionLink href={closeHref} tone="primary">
          Back to the provider
        </ActionLink>
      </DialogActions>
    </Dialog>
  );
}

/**
 * A local provider stores no credential: the row in its connections table is
 * the provider itself. Deleting it is deleting the provider, so this points at
 * that rather than erasing something under a name that promises less.
 */
function LocalConnectionDeleteDialog({
  closeHref,
  deleteProviderHref,
  provider,
}: {
  closeHref: string;
  deleteProviderHref: string;
  provider: ConsoleProvider;
}) {
  return (
    <Dialog closeHref={closeHref} title="Local endpoint" width={520}>
      <DialogBody>
        <strong className="font-medium">{provider.displayName}</strong> is a local provider: its
        endpoint is the provider, not a stored credential, so there is nothing to delete on its own.
      </DialogBody>
      <DialogNote>
        To stop routing to it, disable the provider — the endpoint is kept. Deleting the provider
        removes it and its models.
      </DialogNote>
      <DialogActions>
        <ActionLink href={deleteProviderHref} size="dialog" tone="danger">
          Delete the provider
        </ActionLink>
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </DialogActions>
    </Dialog>
  );
}

function DeleteConnectionDialog({
  closeHref,
  connection,
  provider,
}: {
  closeHref: string;
  connection: ProviderConnection;
  provider: ConsoleProvider;
}) {
  const action = connection.kind === "oauth" ? "/api/provider-oauth" : "/api/provider-keys";
  const idField = connection.kind === "oauth" ? "providerOAuthId" : "providerApiKeyId";
  return (
    <Dialog closeHref={closeHref} danger tag="permanent" title="Delete connection" width={520}>
      <DialogBody>
        The stored credential for <strong className="font-medium">{connection.label}</strong> is
        erased and cannot be recovered. {provider.displayName} keeps its other connections; if this
        was the last one, the provider stops serving traffic.
      </DialogBody>
      <DialogImpact>
        <DetailRow label="credential" value={connection.credential} />
        <DetailRow label="priority" value={String(connection.priority)} />
        <DetailRow label="health history" value="removed with the connection" />
      </DialogImpact>
      <DialogNote>
        To stop traffic without losing the credential, disable the connection instead.
      </DialogNote>
      <ConfirmForm
        action={action}
        confirmLabel="Delete connection"
        onSuccessHref={closeHref}
        hiddenFields={{ action: "delete", [idField]: connection.id, providerId: provider.id }}
      >
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </ConfirmForm>
    </Dialog>
  );
}

function CredentialDialog({
  closeHref,
  connections,
  params,
  provider,
  quotas,
}: {
  closeHref: string;
  connections: ProviderConnection[];
  params: SearchParams;
  provider: ConsoleProvider;
  quotas: ConsoleProviderQuotaSummary[];
}) {
  const connectionId = readParam(params, "connection");
  const editing = connections.find((entry) => entry.id === connectionId) ?? null;
  const userCode = readParam(params, "providerOAuthUserCode");
  const verificationUri = readParam(params, "providerOAuthVerificationUri");
  const authorizeUrl = readParam(params, "providerAuthorizeUrl");
  const oauthId = readParam(params, "providerOAuthId");
  const oauthError = readParam(params, "providerOAuthError");
  const pollInterval = Number.parseInt(readParam(params, "providerOAuthInterval") ?? "5", 10);
  const quotaProbeEnabled =
    quotas.find((quota) => quota.id === connectionId)?.quotaProbeEnabled ?? true;

  const title = editing
    ? "Edit connection"
    : provider.providerType === "subscription"
      ? "Authorize token"
      : provider.providerType === "local"
        ? "Add endpoint"
        : "Add API key";

  return (
    <Dialog
      closeHref={closeHref}
      title={title}
      titleNote={provider.displayName}
      // An authorization screen carries a code and a verification url side by
      // side; at the width the key form uses, the url would be cut.
      width={provider.providerType === "subscription" ? 720 : 600}
    >
      {oauthError ? (
        <p className="mt-3 rounded-xs border border-ambbd bg-ambbg px-3 py-2 font-mono text-125 text-redtx">
          {oauthError}
        </p>
      ) : null}

      {provider.providerType === "local" ? (
        <LocalEndpointForm closeHref={closeHref} provider={provider} />
      ) : provider.providerType === "subscription" ? (
        <SubscriptionForm
          authorizeUrl={authorizeUrl}
          closeHref={closeHref}
          editing={editing}
          expiresAt={readParam(params, "providerOAuthExpiresAt")}
          oauthId={oauthId}
          pollInterval={Number.isFinite(pollInterval) ? pollInterval : 5}
          provider={provider}
          quotaProbeEnabled={quotaProbeEnabled}
          userCode={userCode}
          verificationUri={verificationUri}
        />
      ) : (
        <ApiKeyForm
          closeHref={closeHref}
          editing={editing}
          provider={provider}
          quotaProbeEnabled={quotaProbeEnabled}
        />
      )}
    </Dialog>
  );
}

function ApiKeyForm({
  closeHref,
  editing,
  provider,
  quotaProbeEnabled,
}: {
  closeHref: string;
  editing: ProviderConnection | null;
  provider: ConsoleProvider;
  quotaProbeEnabled: boolean;
}) {
  return (
    <MutationForm
      action="/api/provider-keys"
      fallbackError="The connection could not be saved."
      invalidFieldOnError="providerApiKey"
      onSuccessHref={closeHref}
    >
      <input type="hidden" name="providerId" value={provider.id} />
      {editing ? <input type="hidden" name="providerApiKeyId" value={editing.id} /> : null}
      <div className="mt-4">
        <Field
          label="API KEY"
          hint="Encrypted at rest with the console key; only the prefix is ever displayed again."
        >
          <TextInput
            name="providerApiKey"
            type="password"
            required={!editing}
            autoComplete="off"
            placeholder="paste the provider key"
          />
        </Field>
      </div>
      <div className="mt-[14px] grid grid-cols-2 gap-3">
        <Field label="LABEL" labelNote="(optional, ≤100 chars)">
          <TextInput name="label" defaultValue={editing?.label ?? ""} maxLength={100} />
        </Field>
        <Field label="PRIORITY" labelNote="(0–100)">
          <TextInput
            name="priority"
            defaultValue={String(editing?.priority ?? 100)}
            inputMode="numeric"
          />
        </Field>
      </div>
      <ConnectionStateFields enabled={editing?.enabled ?? true} probing={quotaProbeEnabled} />
      <DialogActions>
        <ActionButton size="dialog" tone="primary">
          {editing ? "Save connection" : "Add key"}
        </ActionButton>
        <ActionLink href={closeHref}>Cancel</ActionLink>
        <span className="ml-1 font-mono text-125 leading-[1.5] text-faint">
          {editing
            ? "leave the credential field empty to keep the stored one — saving re-probes the connection"
            : "a connection probe and model refresh run right after"}
        </span>
      </DialogActions>
    </MutationForm>
  );
}

/** What the connection is called and where it sits in the order. */
/** The device screen's fields are submitted by the poller once the provider confirms. */
const DEVICE_SETTINGS_FORM_ID = "provider-oauth-device-settings";

function ConnectionIdentityFields({ editing }: { editing: ProviderConnection | null }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-3">
      <Field label="LABEL" labelNote="(optional, ≤100 chars)">
        <TextInput name="label" defaultValue={editing?.label ?? ""} maxLength={100} />
      </Field>
      <Field label="PRIORITY" labelNote="(0–100)">
        <TextInput
          name="priority"
          defaultValue={String(editing?.priority ?? 100)}
          inputMode="numeric"
        />
      </Field>
    </div>
  );
}

/**
 * Whether a connection routes, and whether the console asks its provider about
 * the plan. Both are part of what a connection *is*, so they are saved with it
 * rather than being separate switches beside the form.
 */
function ConnectionStateFields({ enabled, probing }: { enabled: boolean; probing: boolean }) {
  return (
    <>
      <div className="mt-[14px] grid grid-cols-2 gap-3">
        <Field label="STATE">
          <SelectInput name="enabled" defaultValue={enabled ? "true" : "false"}>
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </SelectInput>
        </Field>
        <Field label="QUOTA PROBE">
          <SelectInput name="quotaProbeEnabled" defaultValue={probing ? "true" : "false"}>
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </SelectInput>
        </Field>
      </div>
      <DialogNote>
        Lower priority is tried first. Quota probe reads the plan or balance where the provider
        exposes it. A disabled connection keeps its credential but leaves routing.
      </DialogNote>
    </>
  );
}

function LocalEndpointForm({
  closeHref,
  provider,
}: {
  closeHref: string;
  provider: ConsoleProvider;
}) {
  return (
    <MutationForm
      action="/api/providers"
      fallbackError="The endpoint could not be saved."
      invalidFieldOnError="baseUrl"
      onSuccessHref={closeHref}
    >
      <input type="hidden" name="action" value="update" />
      <input type="hidden" name="id" value={provider.id} />
      <input type="hidden" name="displayName" value={provider.displayName} />
      <div className="mt-4">
        <Field
          label="ENDPOINT"
          hint="No credential is sent. The server must be reachable from the gateway host."
        >
          <TextInput name="baseUrl" defaultValue={provider.baseUrl ?? ""} required />
        </Field>
      </div>
      <DialogActions>
        <ActionButton size="dialog" tone="primary">
          Save endpoint
        </ActionButton>
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </DialogActions>
    </MutationForm>
  );
}

function SubscriptionForm({
  authorizeUrl,
  closeHref,
  editing,
  expiresAt,
  oauthId,
  pollInterval,
  provider,
  quotaProbeEnabled,
  userCode,
  verificationUri,
}: {
  authorizeUrl: string | undefined;
  closeHref: string;
  editing: ProviderConnection | null;
  expiresAt: string | undefined;
  oauthId: string | undefined;
  pollInterval: number;
  provider: ConsoleProvider;
  quotaProbeEnabled: boolean;
  userCode: string | undefined;
  verificationUri: string | undefined;
}) {
  // Both flows show what the connection will be called and how it will route
  // beside the authorization itself, as one screen — the operator sets them
  // while they wait rather than on a step that disappears behind them.
  if (userCode && oauthId) {
    return (
      <MutationForm
        action="/api/provider-oauth"
        fallbackError="The connection could not be saved."
        formId={DEVICE_SETTINGS_FORM_ID}
      >
        <input type="hidden" name="action" value="update" />
        <input type="hidden" name="providerOAuthId" value={oauthId} />
        <ConnectionIdentityFields editing={editing} />
        <ConnectionStateFields enabled={editing?.enabled ?? true} probing={quotaProbeEnabled} />
        <div className="mt-[18px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
          DEVICE CODE FLOW · ENTER THE CODE AT THE PROVIDER
        </div>
        <div className="mt-3 flex items-center gap-4 rounded-xs border border-rule bg-track px-4 py-[14px]">
          <div className="flex-none">
            <div
              id="device-user-code-label"
              className="whitespace-nowrap font-mono text-12 text-dim"
            >
              enter this code at the provider
            </div>
            <output
              aria-labelledby="device-user-code-label"
              className="mt-1 block font-mono text-26 font-medium tracking-[.16em] text-ink"
            >
              {userCode}
            </output>
          </div>
          <div className="ml-auto min-w-0 text-right">
            <div className="font-mono text-12 text-dim">verification url</div>
            <div className="mt-1 font-mono text-135 text-ink cell-clip">{verificationUri}</div>
            <div className="mt-2">
              <CopyButton href={verificationUri} value={userCode}>
                Open · copy code
              </CopyButton>
            </div>
          </div>
        </div>
        <DeviceCodePoller
          formId={DEVICE_SETTINGS_FORM_ID}
          intervalSeconds={pollInterval}
          oauthId={oauthId}
          providerId={provider.id}
        >
          {expiresAt ? <ExpiryCountdown expiresAt={expiresAt} label="code" /> : null}
        </DeviceCodePoller>
        <DialogNote>
          The token is stored encrypted and refreshed automatically; the console never sees your
          account password.
        </DialogNote>
        <DialogActions>
          <ActionButton disabled size="dialog" tone="primary">
            Waiting…
          </ActionButton>
          <ActionLink href={closeHref}>Cancel</ActionLink>
          <span className="ml-1 font-mono text-125 leading-[1.5] text-faint">
            these settings are saved when the provider confirms
          </span>
        </DialogActions>
      </MutationForm>
    );
  }

  if (authorizeUrl && oauthId) {
    return (
      <MutationForm
        action="/api/provider-oauth"
        fallbackError="The authorization could not be completed."
        invalidFieldOnError="callbackInput"
      >
        <input type="hidden" name="action" value="complete" />
        <input type="hidden" name="providerId" value={provider.id} />
        <input type="hidden" name="providerOAuthId" value={oauthId} />
        <input type="hidden" name="providerAuthorizeUrl" value={authorizeUrl} />
        <ConnectionIdentityFields editing={editing} />
        <ConnectionStateFields enabled={editing?.enabled ?? true} probing={quotaProbeEnabled} />
        <div className="mt-[18px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
          AUTHORIZATION CODE FLOW · STEP 1 OF 2
        </div>
        <div className="mt-3 rounded-xs border border-rule bg-track px-[14px] py-3">
          <div className="font-mono text-12 text-dim">open this url and approve access</div>
          <div className="mt-[5px] break-all font-mono text-13 leading-[1.5] text-ink">
            {authorizeUrl}
          </div>
          <div className="mt-[10px] flex gap-2">
            <a
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
              className="whitespace-nowrap rounded-xs border border-btnbd bg-btnbg px-[10px] py-1 font-mono text-135 font-medium text-ink"
            >
              Open in browser
            </a>
            <CopyButton value={authorizeUrl}>Copy url</CopyButton>
          </div>
        </div>
        <div className="mt-4 border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
          STEP 2 OF 2 · PASTE WHAT THE PROVIDER RETURNS
        </div>
        <div className="mt-[10px]">
          <Field
            label="CALLBACK VALUE"
            hint="Accepts the full redirect url or just the code. The PKCE verifier and state are held server-side and matched on submit — a mismatched state is rejected."
          >
            <TextInput
              name="callbackInput"
              required
              autoComplete="off"
              placeholder="callback url or authorization code"
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-[9px]">
          <span className="size-[7px] flex-none rounded-full bg-amber" />
          <span className="font-mono text-13 text-ink">pending · awaiting the callback value</span>
          {expiresAt ? <ExpiryCountdown expiresAt={expiresAt} label="request" /> : null}
        </div>
        <DialogActions>
          <ActionButton size="dialog" tone="primary">
            Complete authorization
          </ActionButton>
          <ActionLink href={closeHref}>Cancel</ActionLink>
        </DialogActions>
      </MutationForm>
    );
  }

  // Editing an authorized connection saves what the console owns about it. It
  // must not start an authorization: that creates a second connection rather
  // than changing the one the operator opened.
  const saving = Boolean(editing);
  return (
    <MutationForm
      action="/api/provider-oauth"
      fallbackError={
        saving ? "The connection could not be saved." : "Authorization could not be started."
      }
      onSuccessHref={saving ? closeHref : undefined}
    >
      <input type="hidden" name="action" value={saving ? "update" : "start"} />
      {editing ? (
        <input type="hidden" name="providerOAuthId" value={editing.id} />
      ) : (
        <input type="hidden" name="providerId" value={provider.id} />
      )}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="LABEL" labelNote="(optional, ≤100 chars)">
          <TextInput name="label" defaultValue={editing?.label ?? ""} maxLength={100} />
        </Field>
        <Field label="PRIORITY" labelNote="(0–100)">
          <TextInput
            name="priority"
            defaultValue={String(editing?.priority ?? 100)}
            inputMode="numeric"
          />
        </Field>
      </div>
      {editing ? (
        <ConnectionStateFields enabled={editing.enabled} probing={quotaProbeEnabled} />
      ) : (
        <DialogNote>
          Lower priority is tried first. Subscription plans are not metered — requests routed
          through this token record no cost.
        </DialogNote>
      )}
      <DialogActions>
        <ActionButton size="dialog" tone="primary">
          {saving ? "Save connection" : "Start authorization"}
        </ActionButton>
        <ActionLink href={closeHref}>Cancel</ActionLink>
        <span className="ml-1 font-mono text-125 leading-[1.5] text-faint">
          {saving
            ? "the token itself is replaced by authorizing again — saving re-probes the connection"
            : "the provider is asked to authorize this console"}
        </span>
      </DialogActions>
    </MutationForm>
  );
}

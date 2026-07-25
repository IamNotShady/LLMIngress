import type {
  ProviderTemplateSelectorGroup,
  ProviderTemplateSelectorItem,
} from "@llmingress/db/console-provider-templates";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ConsoleUsageSummary } from "@llmingress/db/console-usage";
import Link from "next/link";
import { ConfirmForm, TypeNameToConfirm } from "../confirm-form";
import { ActionButton, ActionLink, Field, SelectInput, TextInput } from "../controls";
import { formatCost, formatCount } from "../format";
import { DetailRow } from "../layout";
import { Dialog, DialogActions, DialogBody, DialogImpact, DialogNote } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";
import { DeviceCodePoller } from "./device-poller";
import { describeProviderCapabilities, type ProviderConnection, providerIsMetered } from "./model";

export function ProviderDialogs({
  connections,
  params,
  provider,
  templateGroups,
  usage,
}: {
  connections: ProviderConnection[];
  params: SearchParams;
  provider: ConsoleProvider | undefined;
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
  if (credentialProviderId === provider.id) {
    return (
      <CredentialDialog
        closeHref={closeHref}
        connections={connections}
        params={params}
        provider={provider}
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
    const connection = connections.find((entry) => entry.id === readParam(params, "connection"));
    return connection ? (
      <DeleteConnectionDialog closeHref={closeHref} connection={connection} provider={provider} />
    ) : null;
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
      <div aria-label="Supported endpoints" className="mt-2 flex flex-wrap gap-[6px]">
        {endpoints.length === 0 ? (
          <span className="font-mono text-12 text-faint">
            No routable endpoint is declared for this template.
          </span>
        ) : (
          endpoints.map((endpoint) => (
            <span
              key={endpoint.protocol}
              className="flex items-center gap-[7px] rounded-xs border border-btnbd bg-btnbg px-[9px] py-[3px] font-mono text-12 text-ink"
            >
              <span className="font-medium">{endpoint.protocol}</span>
              <span className="text-dim">{endpoint.path}</span>
            </span>
          ))
        )}
      </div>
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
  const activeGroupId = readParam(params, "dialogTab") ?? "remote_api_key";
  const group = groups.find((entry) => entry.id === activeGroupId) ?? groups[0];
  const templates: ProviderTemplateSelectorItem[] = group?.templates ?? [];
  const selectedId = readParam(params, "template") ?? templates[0]?.id;
  const template = templates.find((entry) => entry.id === selectedId) ?? templates[0];

  return (
    <Dialog closeHref={closeHref} title="Add Provider" width={720}>
      <div
        role="tablist"
        aria-label="Provider template groups"
        className="mt-4 flex border-b border-hair"
      >
        {groups.map((entry) => (
          <Link
            key={entry.id}
            role="tab"
            aria-selected={entry.id === group?.id}
            href={buildHref("/providers", params, {
              dialog: "new",
              dialogTab: entry.id,
              template: null,
            })}
            className={`flex items-baseline gap-[7px] px-[14px] py-[7px] font-mono text-14 ${
              entry.id === group?.id
                ? "font-medium text-ink shadow-[inset_0_-2px_0_var(--accent)]"
                : "text-dim"
            }`}
          >
            {entry.label}
            <span aria-hidden="true" className="font-mono text-12 text-faint">
              {entry.templates.length}
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
        <form action="/api/providers" method="post">
          <input type="hidden" name="action" value="createFromTemplate" />
          <input type="hidden" name="templateId" value={template.id} />
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
                defaultValue={template.fixedBaseUrl ?? ""}
                placeholder={template.baseUrlPlaceholder ?? ""}
              />
            </Field>
          </div>
          <EndpointChips providerKey={template.providerKey} />
          <DialogActions>
            <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
              Create
            </ActionButton>
            <ActionLink href={closeHref}>Cancel</ActionLink>
            <span className="ml-1 font-mono text-125 text-faint">
              Credentials are added per connection once the provider exists.
            </span>
          </DialogActions>
        </form>
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
      <form action="/api/providers" method="post">
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
          <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
            Save
          </ActionButton>
          <ActionLink href={closeHref}>Cancel</ActionLink>
        </DialogActions>
      </form>
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
  provider,
  usage,
}: {
  closeHref: string;
  connections: ProviderConnection[];
  provider: ConsoleProvider;
  usage: ConsoleUsageSummary;
}) {
  const breakdown = usage.providerBreakdowns.find((entry) => entry.id === provider.id);
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
      </DialogImpact>
      <TypeNameToConfirm
        action="/api/providers"
        confirmLabel="Delete provider"
        hiddenFields={{ action: "delete", id: provider.id }}
        label="TYPE THE PROVIDER NAME TO CONFIRM"
        name={provider.displayName}
      >
        <ActionLink href={closeHref}>Cancel</ActionLink>
        <span className="ml-1 font-mono text-12 text-dim">
          Disable instead — keeps config and removes it from routing
        </span>
      </TypeNameToConfirm>
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
}: {
  closeHref: string;
  connections: ProviderConnection[];
  params: SearchParams;
  provider: ConsoleProvider;
}) {
  const connectionId = readParam(params, "connection");
  const editing = connections.find((entry) => entry.id === connectionId) ?? null;
  const userCode = readParam(params, "providerOAuthUserCode");
  const verificationUri = readParam(params, "providerOAuthVerificationUri");
  const authorizeUrl = readParam(params, "providerAuthorizeUrl");
  const oauthId = readParam(params, "providerOAuthId");
  const oauthError = readParam(params, "providerOAuthError");
  const pollInterval = Number.parseInt(readParam(params, "providerOAuthInterval") ?? "5", 10);

  const title = editing
    ? "Edit connection"
    : provider.providerType === "subscription"
      ? "Authorize token"
      : provider.providerType === "local"
        ? "Add endpoint"
        : "Add key";

  return (
    <Dialog closeHref={closeHref} title={title} titleNote={provider.displayName} width={600}>
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
          oauthId={oauthId}
          pollInterval={Number.isFinite(pollInterval) ? pollInterval : 5}
          provider={provider}
          userCode={userCode}
          verificationUri={verificationUri}
        />
      ) : (
        <ApiKeyForm closeHref={closeHref} editing={editing} provider={provider} />
      )}
    </Dialog>
  );
}

function ApiKeyForm({
  closeHref,
  editing,
  provider,
}: {
  closeHref: string;
  editing: ProviderConnection | null;
  provider: ConsoleProvider;
}) {
  return (
    <form action="/api/provider-keys" method="post">
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
            required
            autoComplete="off"
            placeholder={editing ? "paste a new key to rotate" : "paste the provider key"}
          />
        </Field>
      </div>
      <div className="mt-[14px] grid grid-cols-2 gap-3">
        <Field label="LABEL" labelNote="(optional, ≤100 chars)">
          <TextInput name="label" defaultValue={editing?.label ?? ""} maxLength={100} />
        </Field>
        <Field label="PRIORITY" labelNote="(0–100)" hint="Lower priority is tried first.">
          <TextInput
            name="priority"
            defaultValue={String(editing?.priority ?? 100)}
            inputMode="numeric"
          />
        </Field>
      </div>
      <DialogNote>
        Quota probe reads the plan or balance where the provider exposes it. A disabled connection
        keeps its credential but leaves routing.
      </DialogNote>
      <DialogActions>
        <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
          {editing ? "Save connection" : "Add key"}
        </ActionButton>
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </DialogActions>
      {editing ? (
        <ConnectionStateActions closeHref={closeHref} connection={editing} provider={provider} />
      ) : null}
    </form>
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
    <form action="/api/providers" method="post">
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
        <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
          Save endpoint
        </ActionButton>
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </DialogActions>
    </form>
  );
}

function SubscriptionForm({
  authorizeUrl,
  closeHref,
  editing,
  oauthId,
  pollInterval,
  provider,
  userCode,
  verificationUri,
}: {
  authorizeUrl: string | undefined;
  closeHref: string;
  editing: ProviderConnection | null;
  oauthId: string | undefined;
  pollInterval: number;
  provider: ConsoleProvider;
  userCode: string | undefined;
  verificationUri: string | undefined;
}) {
  if (userCode && oauthId) {
    return (
      <div>
        <div className="mt-[18px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
          DEVICE CODE FLOW · ENTER THE CODE AT THE PROVIDER
        </div>
        <div className="mt-3 flex items-center gap-4 rounded-xs border border-rule bg-track px-4 py-[14px]">
          <div>
            <div className="font-mono text-12 text-dim">enter this code at the provider</div>
            <div className="mt-1 font-mono text-26 font-medium tracking-[.16em] text-ink">
              {userCode}
            </div>
          </div>
          <div className="ml-auto text-right">
            <div className="font-mono text-12 text-dim">verification url</div>
            <div className="mt-1 font-mono text-135 text-ink">{verificationUri}</div>
            {verificationUri ? (
              <a
                href={verificationUri}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block rounded-xs border border-btnbd bg-btnbg px-[10px] py-1 font-mono text-135 font-medium text-ink"
              >
                Open
              </a>
            ) : null}
          </div>
        </div>
        <DeviceCodePoller
          intervalSeconds={pollInterval}
          oauthId={oauthId}
          providerId={provider.id}
        />
        <DialogNote>
          The token is stored encrypted and refreshed automatically; the console never sees your
          account password.
        </DialogNote>
      </div>
    );
  }

  if (authorizeUrl && oauthId) {
    return (
      <form action="/api/provider-oauth" method="post">
        <input type="hidden" name="action" value="complete" />
        <input type="hidden" name="providerId" value={provider.id} />
        <input type="hidden" name="providerOAuthId" value={oauthId} />
        <input type="hidden" name="providerAuthorizeUrl" value={authorizeUrl} />
        <div className="mt-[18px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
          AUTHORIZATION CODE FLOW · STEP 1 OF 2
        </div>
        <div className="mt-3 rounded-xs border border-rule bg-track px-[14px] py-3">
          <div className="font-mono text-12 text-dim">open this url and approve access</div>
          <div className="mt-[5px] break-all font-mono text-13 leading-[1.5] text-ink">
            {authorizeUrl}
          </div>
          <a
            href={authorizeUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-[10px] inline-block rounded-xs border border-btnbd bg-btnbg px-[10px] py-1 font-mono text-135 font-medium text-ink"
          >
            Open in browser
          </a>
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
        <DialogActions>
          <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
            Complete authorization
          </ActionButton>
          <ActionLink href={closeHref}>Cancel</ActionLink>
        </DialogActions>
      </form>
    );
  }

  return (
    <form action="/api/provider-oauth" method="post">
      <input type="hidden" name="action" value="start" />
      <input type="hidden" name="providerId" value={provider.id} />
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="LABEL" labelNote="(optional)">
          <TextInput name="label" defaultValue={editing?.label ?? ""} maxLength={100} />
        </Field>
        <Field label="PRIORITY" hint="Lower priority is tried first.">
          <TextInput
            name="priority"
            defaultValue={String(editing?.priority ?? 100)}
            inputMode="numeric"
          />
        </Field>
      </div>
      <DialogNote>
        Subscription plans are not metered — requests routed through this token record no cost.
      </DialogNote>
      <DialogActions>
        <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
          Start authorization
        </ActionButton>
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </DialogActions>
    </form>
  );
}

/** Enable/disable lives outside the credential form so it posts on its own. */
function ConnectionStateActions({
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
    <div className="mt-4 border-t border-hair pt-3">
      <p className="font-mono text-12 leading-[1.6] text-faint">
        Disabling keeps the stored credential and removes this connection from routing; deleting
        erases the credential permanently.
      </p>
      <form action={action} method="post" className="mt-2 flex gap-2">
        <input type="hidden" name="action" value={connection.enabled ? "disable" : "enable"} />
        <input type="hidden" name={idField} value={connection.id} />
        <input type="hidden" name="providerId" value={provider.id} />
        <ActionButton>
          {connection.enabled ? "Disable connection" : "Enable connection"}
        </ActionButton>
      </form>
    </div>
  );
}

import type { ConsoleApiKeyLimit } from "@llmingress/db/console-api-key-limits";
import type { ConsoleApiKey } from "@llmingress/db/console-api-keys";
import type { ConsoleRoutePolicy } from "@llmingress/db/console-route-policies";
import type { ConsoleUsageSummary } from "@llmingress/db/console-usage";
import type {
  ConsoleApiKeyVirtualModelGrant,
  ConsoleVirtualModel,
} from "@llmingress/db/console-virtual-models";
import Link from "next/link";
import { ConfirmForm, TypeNameToConfirm } from "../confirm-form";
import { ActionButton, ActionLink, Field, SelectInput, TextInput } from "../controls";
import { formatCost, formatCount, formatDateOnly } from "../format";
import { DetailRow } from "../layout";
import { Dialog, DialogActions, DialogBody, DialogImpact, DialogNote } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";
import { ApiKeyEditorForm } from "./editor-form";
import { buildApiKeyLimitsView, ENFORCEMENT_NOTE, limitFieldValue } from "./limits-view";

const BUDGET_PERIODS = ["day", "week", "month"] as const;

export function ApiKeyDialogs({
  apiKey,
  grants,
  limits,
  params,
  routePolicies,
  usage,
  virtualModels,
}: {
  apiKey: ConsoleApiKey | undefined;
  grants: ConsoleApiKeyVirtualModelGrant[];
  limits: ConsoleApiKeyLimit[];
  params: SearchParams;
  routePolicies: ConsoleRoutePolicy[];
  usage: ConsoleUsageSummary;
  virtualModels: ConsoleVirtualModel[];
}) {
  const dialog = readParam(params, "dialog");
  const closeHref = buildHref("/api-keys", params, {
    defaultGrant: null,
    dialog: null,
    grantIds: null,
  });

  if (dialog === "new") {
    return (
      <ApiKeyEditorDialog
        closeHref={closeHref}
        params={params}
        routePolicies={routePolicies}
        virtualModels={virtualModels}
      />
    );
  }
  if (!apiKey) {
    return null;
  }
  if (dialog === "edit") {
    return (
      <ApiKeyEditorDialog
        apiKey={apiKey}
        closeHref={closeHref}
        grants={grants.filter((grant) => grant.apiKeyId === apiKey.id)}
        limits={limits}
        params={params}
        routePolicies={routePolicies}
        virtualModels={virtualModels}
      />
    );
  }
  if (dialog === "delete") {
    return (
      <DeleteApiKeyDialog
        apiKey={apiKey}
        closeHref={closeHref}
        grants={grants.filter((grant) => grant.apiKeyId === apiKey.id)}
        usage={usage}
      />
    );
  }
  if (dialog === "disable" || dialog === "enable") {
    return <ApiKeyStateDialog apiKey={apiKey} closeHref={closeHref} enable={dialog === "enable"} />;
  }
  return null;
}

function ApiKeyEditorDialog({
  apiKey,
  closeHref,
  grants = [],
  limits = [],
  params,
  routePolicies,
  virtualModels,
}: {
  apiKey?: ConsoleApiKey;
  closeHref: string;
  grants?: ConsoleApiKeyVirtualModelGrant[];
  limits?: ConsoleApiKeyLimit[];
  params: SearchParams;
  routePolicies: ConsoleRoutePolicy[];
  virtualModels: ConsoleVirtualModel[];
}) {
  const editing = Boolean(apiKey);
  const policyByVirtualModelId = new Map(
    routePolicies.map((policy) => [policy.virtualModelId, policy]),
  );

  // Grants and the default live in the URL, so toggling one is a plain link and
  // the dialog stays server-rendered from the selected key's real values.
  const grantParam = readParam(params, "grantIds");
  const selectedGrantIds =
    grantParam === undefined
      ? grants.map((grant) => grant.virtualModelId)
      : grantParam.split(",").filter(Boolean);
  const defaultParam = readParam(params, "defaultGrant");
  const defaultGrantId =
    defaultParam ?? grants.find((grant) => grant.isDefault)?.virtualModelId ?? "";

  const view = buildApiKeyLimitsView({
    budgetPeriod: undefined,
    limits,
    limitsEnabled: apiKey?.limitsEnabled ?? true,
  });
  const pathname = "/api-keys";
  const withGrants = (ids: string[], nextDefault?: string) =>
    buildHref(pathname, params, {
      defaultGrant: nextDefault ?? (ids.includes(defaultGrantId) ? defaultGrantId : ""),
      grantIds: ids.join(","),
    });

  return (
    <Dialog
      closeHref={closeHref}
      title={editing ? "Edit API key" : "New API Key"}
      titleNote={
        apiKey ? `${apiKey.keyPrefix} · created ${formatDateOnly(apiKey.createdAt)}` : undefined
      }
      width={editing ? 720 : 900}
    >
      <ApiKeyEditorForm editing={Boolean(editing)} formError={readParam(params, "formError")}>
        <input type="hidden" name="action" value={editing ? "saveAll" : "create"} />
        {apiKey ? <input type="hidden" name="id" value={apiKey.id} /> : null}
        {selectedGrantIds.map((id) => (
          <input key={id} type="hidden" name="allowedVirtualModelIds" value={id} />
        ))}
        <input type="hidden" name="defaultVirtualModelId" value={defaultGrantId} />

        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="NAME" hint="Shown in Activity and Usage; the secret itself is never shown.">
            <TextInput
              name="name"
              data-autofocus=""
              id="api-key-name"
              aria-label="API key name"
              defaultValue={readParam(params, "keyName") ?? apiKey?.name ?? ""}
              required
            />
          </Field>
          {editing ? (
            <Field label="STATE" hint="Disabling stops traffic and keeps the configuration.">
              <TextInput defaultValue={apiKey?.enabled ? "enabled" : "disabled"} disabled />
            </Field>
          ) : null}
        </div>

        <div className="mt-4 flex items-baseline gap-[10px] border-b border-hair pb-[5px]">
          <span className="font-mono text-115 font-medium tracking-[.08em] text-dim">
            VIRTUAL MODEL GRANTS
          </span>
          <span className="ml-auto font-mono text-12 text-faint">
            the default is used when a client sends no model
          </span>
        </div>
        {virtualModels.length === 0 ? (
          <p className="py-4 font-mono text-13 text-dim">
            No virtual model exists yet — create one before issuing a key.
          </p>
        ) : (
          virtualModels.map((model) => {
            const policy = policyByVirtualModelId.get(model.id);
            const granted = selectedGrantIds.includes(model.id);
            const isDefault = defaultGrantId === model.id;
            const toggled = granted
              ? selectedGrantIds.filter((id) => id !== model.id)
              : [...selectedGrantIds, model.id];
            return (
              <div
                key={model.id}
                className="flex items-center gap-[10px] border-b border-rule2 py-2 font-mono text-13 text-ink"
              >
                <Link
                  href={withGrants(toggled, granted && isDefault ? "" : undefined)}
                  aria-label={`${granted ? "Revoke" : "Grant"} ${model.name}`}
                  className={`grid size-[13px] flex-none place-items-center rounded-[2px] border font-mono text-[10px] ${
                    granted ? "border-accent bg-accent text-segfg" : "border-btnbd bg-btnbg"
                  }`}
                >
                  {granted ? "✓" : ""}
                </Link>
                <span
                  className={`min-w-0 flex-1 cell-clip ${granted ? "font-medium" : "text-dim"}`}
                >
                  {model.name}
                </span>
                <span className="whitespace-nowrap text-dim">
                  {policy ? `${policy.endpointProtocol} · ${policy.strategy}` : "no route yet"}
                </span>
                {granted ? (
                  <Link
                    href={withGrants(selectedGrantIds, model.id)}
                    className={`whitespace-nowrap ${isDefault ? "text-ambtx" : "text-faint"}`}
                  >
                    {isDefault ? "★ default" : "☆ set default"}
                  </Link>
                ) : (
                  <span className="whitespace-nowrap text-faint">☆</span>
                )}
              </div>
            );
          })
        )}

        <div className="mt-4 flex items-center gap-[10px]">
          <span className="flex-none whitespace-nowrap font-mono text-115 font-medium tracking-[.08em] text-dim">
            ENABLE LIMITS
          </span>
          <span className="block w-[130px] flex-none">
            <SelectInput
              name="enableLimits"
              aria-label="Enable limits"
              defaultValue={apiKey ? String(apiKey.limitsEnabled) : "true"}
            >
              <option value="true">on</option>
              <option value="false">off</option>
            </SelectInput>
          </span>
          <span className="min-w-0 flex-1 font-mono text-12 text-faint">
            Off keeps the rules below and enforces none of them.
          </span>
        </div>
        <div className="mt-[10px] grid grid-cols-3 gap-3">
          <Field label="BUDGET USD / PERIOD" hint="spend cap per period · blocks past it">
            <span className="flex items-center gap-[6px] [&>select]:w-[110px] [&>select]:flex-none">
              <TextInput
                name="budgetUsd"
                defaultValue={limitFieldValue(view.budgetLimit, editing ? null : 25)}
                inputMode="decimal"
                placeholder="unlimited"
              />
              <SelectInput
                name="budgetPeriod"
                aria-label="Budget period"
                defaultValue={view.budgetPeriod ?? "month"}
              >
                {BUDGET_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {period}
                  </option>
                ))}
              </SelectInput>
            </span>
          </Field>
          <Field label="RPM" hint="requests per minute">
            <TextInput
              name="rpm"
              defaultValue={limitFieldValue(view.rpm, editing ? null : 120)}
              inputMode="numeric"
              placeholder="unlimited"
            />
          </Field>
          <Field label="TPM" hint="tokens per minute (input + output)">
            <TextInput
              name="tpm"
              defaultValue={limitFieldValue(view.tpm, editing ? null : 50_000)}
              inputMode="numeric"
              placeholder="unlimited"
            />
          </Field>
          <Field label="TOKENS / REQUEST" hint="max tokens a single request may use">
            <TextInput
              name="tokenLimit"
              defaultValue={limitFieldValue(view.tokensPerRequest, editing ? null : 16_384)}
              inputMode="numeric"
              placeholder="unlimited"
            />
          </Field>
          <Field label="CONCURRENCY" hint="in-flight requests at the same time">
            <TextInput
              name="concurrency"
              defaultValue={limitFieldValue(view.concurrency, editing ? null : 4)}
              inputMode="numeric"
              placeholder="unlimited"
            />
          </Field>
          <Field label="ENFORCEMENT" hint={ENFORCEMENT_NOTE}>
            <TextInput defaultValue={view.enforcement} disabled className="opacity-55" />
            <input type="hidden" name="enforcementPolicy" value={view.enforcement} />
          </Field>
        </div>

        <DialogActions>
          <ActionButton size="dialog" disabled={selectedGrantIds.length === 0} tone="primary">
            {editing ? "Save" : "Create key"}
          </ActionButton>
          <ActionLink href={closeHref}>Cancel</ActionLink>
          <span className="ml-1 font-mono text-12 text-faint">
            {editing
              ? "the llmi_ secret cannot be shown or changed — delete the key and issue a new one to rotate it"
              : "the secret is shown once, on the next screen"}
          </span>
        </DialogActions>
      </ApiKeyEditorForm>
    </Dialog>
  );
}

function ApiKeyStateDialog({
  apiKey,
  closeHref,
  enable,
}: {
  apiKey: ConsoleApiKey;
  closeHref: string;
  enable: boolean;
}) {
  return (
    <Dialog
      closeHref={closeHref}
      tag={enable ? undefined : "traffic stops"}
      title={enable ? "Enable API key" : "Disable API key"}
      width={480}
    >
      <DialogBody>
        {enable ? (
          <>
            Requests presenting <strong className="font-medium">{apiKey.name}</strong> are accepted
            again, under the grants and limits it already has.
          </>
        ) : (
          <>
            Requests presenting <strong className="font-medium">{apiKey.name}</strong> start failing
            with 401 immediately. Recorded activity and usage are kept.
          </>
        )}
      </DialogBody>
      <DialogNote>
        Grants, limits and the stored hash are preserved either way — only deleting is permanent.
      </DialogNote>
      <ConfirmForm
        action="/api/api-keys"
        confirmLabel={enable ? "Enable key" : "Disable key"}
        onSuccessHref={closeHref}
        hiddenFields={{ action: enable ? "enable" : "disable", id: apiKey.id }}
        tone="primary"
      >
        <ActionLink href={closeHref}>Cancel</ActionLink>
      </ConfirmForm>
    </Dialog>
  );
}

function DeleteApiKeyDialog({
  apiKey,
  closeHref,
  grants,
  usage,
}: {
  apiKey: ConsoleApiKey;
  closeHref: string;
  grants: ConsoleApiKeyVirtualModelGrant[];
  usage: ConsoleUsageSummary;
}) {
  const breakdown = usage.apiKeyBreakdowns.find((entry) => entry.id === apiKey.id);
  return (
    <Dialog closeHref={closeHref} danger tag="permanent" title="Delete API key" width={520}>
      <DialogBody>
        Requests presenting <strong className="font-medium">{apiKey.name}</strong> will fail with
        401 as soon as this is saved. The secret cannot be recovered and a new key will not inherit
        its grants or limits.
      </DialogBody>
      <DialogImpact>
        <DetailRow label="prefix" value={apiKey.keyPrefix} />
        <DetailRow label="grants" value={formatCount(grants.length)} />
        <DetailRow
          label="requests 24h"
          value={`${formatCount(breakdown?.requestCount ?? 0)} · ${formatCost(
            breakdown?.totalCostUsd ?? null,
          )}`}
        />
        <DetailRow label="activity history" value="kept, attributed to the name snapshot" />
      </DialogImpact>
      <TypeNameToConfirm
        action="/api/api-keys"
        confirmLabel="Delete key"
        onSuccessHref="/api-keys"
        hiddenFields={{ action: "delete", id: apiKey.id }}
        label="TYPE THE KEY NAME TO CONFIRM"
        name={apiKey.name}
      >
        <ActionLink href={closeHref}>Cancel</ActionLink>
        <span className="ml-1 font-mono text-12 text-dim">
          Disable instead — keeps configuration and stops traffic
        </span>
      </TypeNameToConfirm>
    </Dialog>
  );
}

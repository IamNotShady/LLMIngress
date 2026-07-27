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
import {
  ActionButton,
  ActionLink,
  Field,
  filterControlClass,
  SelectInput,
  TextInput,
} from "../controls";
import { EditorNav } from "../editor-nav";
import { formatCost, formatCount, formatDateOnly } from "../format";
import { DetailRow } from "../layout";
import { Dialog, DialogActions, DialogBody, DialogImpact, DialogNote } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";
import { SyncedSearchInput } from "../synced-search";
import { SyncedSelect } from "../synced-select";
import { formatRange } from "../table";
import { ApiKeyEditorForm } from "./editor-form";
import { grantParamChanges, readDefaultGrantId, readGrantIds } from "./grant-params";
import { IntegrationPanel } from "./integration-panel";
import {
  BUDGET_PERIOD_OPTIONS,
  buildApiKeyLimitsView,
  ENFORCEMENT_NOTE,
  limitFieldValue,
} from "./limits-view";

const GRANT_FILTERS = [
  { label: "Show: all", value: "all" },
  { label: "granted only", value: "granted" },
  { label: "not granted", value: "ungranted" },
] as const;

/** The name is typed here, and every filter click re-renders from the server. */
const PRESERVED_EDITOR_FIELDS = ["name"] as const;

const GRANT_PAGE_SIZE = 8;

/** One line, in one place: a wrapped copy is a copy that can drift. */
const ROTATE_NOTE =
  "the llmi_ secret cannot be shown or changed — delete the key and issue a new one to rotate it";

/** Why the save is unavailable, next to the button that is unavailable. */
const NO_GRANT_NOTE = "grant at least one Virtual Model — a key with none can call nothing";

/**
 * What a refused creation carries back so the dialog can be reopened as it was
 * left. They belong to that one round trip: closing the dialog drops them.
 */
const DRAFT_PARAMS = [
  "draft",
  "draft_budgetPeriod",
  "draft_budgetUsd",
  "draft_concurrency",
  "draft_enableLimits",
  "draft_enforcementPolicy",
  "draft_rpm",
  "draft_tokenLimit",
  "draft_tpm",
] as const;

export function ApiKeyDialogs({
  apiKey,
  gatewayBaseUrl,
  grants,
  limits,
  params,
  routePolicies,
  usage,
  virtualModels,
}: {
  apiKey: ConsoleApiKey | undefined;
  gatewayBaseUrl: string;
  grants: ConsoleApiKeyVirtualModelGrant[];
  limits: ConsoleApiKeyLimit[];
  params: SearchParams;
  routePolicies: ConsoleRoutePolicy[];
  usage: ConsoleUsageSummary;
  virtualModels: ConsoleVirtualModel[];
}) {
  const dialog = readParam(params, "dialog");
  // Closing drops the whole draft: the grants picked but not saved, the name
  // typed but not saved, the browser's own filters. What is left behind is the
  // list the operator was looking at before they opened it.
  const closeHref = buildHref("/api-keys", params, {
    defaultGrant: null,
    dialog: null,
    editor_name: null,
    formError: null,
    grantIds: null,
    guide: null,
    grantPage: null,
    grantQuery: null,
    grantShow: null,
    keyName: null,
    ...Object.fromEntries(DRAFT_PARAMS.map((param) => [param, null])),
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
  if (dialog === "guide") {
    return (
      <AgentSetupDialog
        apiKey={apiKey}
        closeHref={closeHref}
        gatewayBaseUrl={gatewayBaseUrl}
        grants={grants.filter((grant) => grant.apiKeyId === apiKey.id)}
        params={params}
        routePolicies={routePolicies}
      />
    );
  }
  if (dialog === "delete") {
    return (
      <DeleteApiKeyDialog
        apiKey={apiKey}
        closeHref={closeHref}
        grants={grants.filter((grant) => grant.apiKeyId === apiKey.id)}
        params={params}
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
  const selectedGrantIds = readGrantIds(
    params,
    grants.map((grant) => grant.virtualModelId),
  );
  const defaultGrantId = readDefaultGrantId(
    params,
    grants.find((grant) => grant.isDefault)?.virtualModelId ?? "",
  );

  const view = buildApiKeyLimitsView({
    budgetPeriod: undefined,
    limits,
    limitsEnabled: apiKey?.limitsEnabled ?? true,
  });
  // A refused creation comes back through the URL, carrying what was typed: one
  // field was wrong, and retyping the other six is the console losing work it
  // was handed. An existing key has its own saved values to show instead.
  //
  // While the marker is there the draft is the whole answer: a ceiling the
  // operator cleared has nothing to put in the query string, so its parameter
  // is absent, and reading that as "no draft" put the suggested default back
  // under a field they had deliberately emptied.
  const hasDraft = readParam(params, "draft") !== undefined;
  const draft = (field: string) => readParam(params, `draft_${field}`);
  const limitField = (field: string, saved: number | null, fresh: number | null) =>
    draft(field) ?? (hasDraft ? "" : limitFieldValue(saved, editing ? null : fresh));
  const pathname = "/api-keys";
  const withGrants = (ids: string[], nextDefault?: string) =>
    buildHref(
      pathname,
      params,
      grantParamChanges(ids, nextDefault ?? (ids.includes(defaultGrantId) ? defaultGrantId : "")),
    );

  // A console with many virtual models would otherwise put a scroll of rows
  // between the name and the limits. Searching, filtering and paging narrow the
  // rows on screen; what is granted lives in the URL, so a grant made on page
  // one is still granted while page two is being read.
  const grantQuery = readParam(params, "grantQuery") ?? "";
  const grantShow = readParam(params, "grantShow") ?? "all";
  const needle = grantQuery.trim().toLowerCase();
  const matching = virtualModels.filter((model) => {
    if (needle && !model.name.toLowerCase().includes(needle)) {
      return false;
    }
    if (grantShow === "granted") {
      return selectedGrantIds.includes(model.id);
    }
    if (grantShow === "ungranted") {
      return !selectedGrantIds.includes(model.id);
    }
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(matching.length / GRANT_PAGE_SIZE));
  const grantPage = Math.min(
    Math.max(1, Number.parseInt(readParam(params, "grantPage") ?? "1", 10) || 1),
    pageCount,
  );
  const visibleModels = matching.slice(
    (grantPage - 1) * GRANT_PAGE_SIZE,
    grantPage * GRANT_PAGE_SIZE,
  );

  return (
    <Dialog
      closeHref={closeHref}
      title={editing ? "Edit API key" : "New API Key"}
      titleNote={
        apiKey ? `${apiKey.keyPrefix} · created ${formatDateOnly(apiKey.createdAt)}` : undefined
      }
      width={editing ? 720 : 900}
    >
      <EditorNav>
        <ApiKeyEditorForm
          closeHref={closeHref}
          editing={Boolean(editing)}
          formError={readParam(params, "formError")}
        >
          <input type="hidden" name="action" value={editing ? "saveAll" : "create"} />
          {apiKey ? <input type="hidden" name="id" value={apiKey.id} /> : null}
          {selectedGrantIds.map((id) => (
            <input key={id} type="hidden" name="allowedVirtualModelIds" value={id} />
          ))}
          <input type="hidden" name="defaultVirtualModelId" value={defaultGrantId} />

          <div className={editing ? "mt-4 grid grid-cols-2 gap-4" : "mt-4"}>
            <Field label="NAME">
              <TextInput
                name="name"
                data-autofocus=""
                id="api-key-name"
                aria-label="API key name"
                defaultValue={
                  readParam(params, "editor_name") ??
                  readParam(params, "keyName") ??
                  apiKey?.name ??
                  ""
                }
                required
              />
            </Field>
            {editing ? (
              <Field label="STATE" hint="Disabling stops traffic and keeps the configuration.">
                <TextInput defaultValue={apiKey?.enabled ? "enabled" : "disabled"} disabled />
              </Field>
            ) : null}
          </div>

          <div className="mt-4 flex items-center gap-[10px]">
            <span className="flex-none whitespace-nowrap font-mono text-115 font-medium tracking-[.08em] text-dim">
              VIRTUAL MODEL GRANTS
            </span>
            <SyncedSearchInput
              aria-label="Search virtual models"
              // Shrinkable, so the narrower edit dialog squeezes the search box
              // rather than pushing the pager off the row.
              className={`${filterControlClass} w-[150px]`}
              href={buildHref(pathname, params, { grantPage: null, grantQuery: "__value__" })}
              name="grantQuery"
              placeholder="search model name…"
              preserveFields={PRESERVED_EDITOR_FIELDS}
              value={grantQuery}
            />
            <span className="block w-[150px] flex-none">
              <SyncedSelect
                aria-label="Filter virtual models by grant"
                className={filterControlClass}
                href={buildHref(pathname, params, { grantPage: null, grantShow: "__value__" })}
                name="grantShow"
                preserveFields={PRESERVED_EDITOR_FIELDS}
                value={grantShow}
              >
                {GRANT_FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </SyncedSelect>
            </span>
            <GrantPager
              page={grantPage}
              pageCount={pageCount}
              params={params}
              rangeLabel={formatRange({
                page: grantPage,
                pageSize: GRANT_PAGE_SIZE,
                total: matching.length,
              })}
            />
          </div>

          <div className="mt-2 flex items-baseline gap-[10px] border-b border-hair pb-[5px]">
            <span className="font-mono text-115 font-medium tracking-[.08em] text-dim">MODEL</span>
            <span className="ml-auto font-mono text-12 text-faint">
              {editing
                ? "the default is used when a client sends no model"
                : "star one as the default"}
            </span>
          </div>
          {virtualModels.length === 0 ? (
            <p className="py-4 font-mono text-13 text-dim">
              No virtual model exists yet — create one before issuing a key.
            </p>
          ) : visibleModels.length === 0 ? (
            <p className="py-4 font-mono text-13 text-dim">
              No virtual model matches that search and filter.
            </p>
          ) : (
            visibleModels.map((model) => {
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
            <input
              type="checkbox"
              name="enableLimits"
              value="true"
              aria-label="Enable limits"
              defaultChecked={
                hasDraft ? draft("enableLimits") === "true" : (apiKey?.limitsEnabled ?? true)
              }
              className="size-[13px] flex-none accent-accent"
            />
            <span className="font-mono text-12 text-faint">
              all fields below are required when enabled; otherwise they are ignored
            </span>
          </div>
          <div className="mt-[10px] grid grid-cols-3 gap-3">
            <Field label="BUDGET USD / PERIOD" hint="spend cap per period · blocks past it">
              <span className="flex items-center gap-[6px] [&>select]:w-[110px] [&>select]:flex-none">
                <TextInput
                  name="budgetUsd"
                  aria-label="Budget USD"
                  defaultValue={limitField("budgetUsd", view.budgetLimit, 25)}
                  inputMode="decimal"
                  placeholder="required when enabled"
                />
                <SelectInput
                  name="budgetPeriod"
                  aria-label="Budget period"
                  defaultValue={draft("budgetPeriod") ?? view.budgetPeriod ?? "month"}
                >
                  {BUDGET_PERIOD_OPTIONS.map((period) => (
                    <option key={period.value} value={period.value}>
                      {period.label}
                    </option>
                  ))}
                </SelectInput>
              </span>
            </Field>
            <Field label="RPM" hint="requests per minute">
              <TextInput
                name="rpm"
                defaultValue={limitField("rpm", view.rpm, 120)}
                inputMode="numeric"
                placeholder="required when enabled"
              />
            </Field>
            <Field label="TPM" hint="tokens per minute (input + output)">
              <TextInput
                name="tpm"
                defaultValue={limitField("tpm", view.tpm, 50_000)}
                inputMode="numeric"
                placeholder="required when enabled"
              />
            </Field>
            <Field label="TOKENS / REQUEST" hint="max tokens a single request may use">
              <TextInput
                name="tokenLimit"
                defaultValue={limitField("tokenLimit", view.tokensPerRequest, 16_384)}
                inputMode="numeric"
                placeholder="required when enabled"
              />
            </Field>
            <Field label="CONCURRENCY" hint="in-flight requests at the same time">
              <TextInput
                name="concurrency"
                defaultValue={limitField("concurrency", view.concurrency, 4)}
                inputMode="numeric"
                placeholder="required when enabled"
              />
            </Field>
            <Field label="ENFORCEMENT" hint={ENFORCEMENT_NOTE}>
              <SelectInput
                name="enforcementPolicy"
                aria-label="Enforcement policy"
                defaultValue={draft("enforcementPolicy") ?? view.enforcement}
              >
                <option value="block">block</option>
                <option value="warn_only">warn_only</option>
              </SelectInput>
            </Field>
          </div>

          <DialogActions>
            <ActionButton size="dialog" disabled={selectedGrantIds.length === 0} tone="primary">
              {editing ? "Save" : "Create key"}
            </ActionButton>
            <ActionLink href={closeHref}>Cancel</ActionLink>
            {selectedGrantIds.length === 0 ? (
              <span className="ml-1 font-mono text-12 text-ambtx">{NO_GRANT_NOTE}</span>
            ) : editing ? (
              <span className="ml-1 font-mono text-12 text-faint">{ROTATE_NOTE}</span>
            ) : null}
          </DialogActions>
        </ApiKeyEditorForm>
      </EditorNav>
    </Dialog>
  );
}

/**
 * The grants pager, in the section header rather than under the rows: it reads
 * as part of the browser's controls, and the rows below stay a plain list. Both
 * arrows are always drawn so the row does not change width at the ends.
 */
function GrantPager({
  page,
  pageCount,
  params,
  rangeLabel,
}: {
  page: number;
  pageCount: number;
  params: SearchParams;
  rangeLabel: string;
}) {
  const stepClass = "rounded-xs border border-btnbd bg-btnbg px-2 py-[2px]";
  const stepHref = (target: number) =>
    buildHref("/api-keys", params, { grantPage: String(target) });

  return (
    <span className="ml-auto flex flex-none items-center gap-2 whitespace-nowrap font-mono text-12 text-dim">
      <span>{rangeLabel}</span>
      {page > 1 ? (
        <Link
          aria-label="Previous page of models"
          href={stepHref(page - 1)}
          className={`${stepClass} text-ink`}
        >
          ←
        </Link>
      ) : (
        <span className={`${stepClass} text-faint`}>←</span>
      )}
      {page < pageCount ? (
        <Link
          aria-label="Next page of models"
          href={stepHref(page + 1)}
          className={`${stepClass} text-ink`}
        >
          →
        </Link>
      ) : (
        <span className={`${stepClass} text-faint`}>→</span>
      )}
    </span>
  );
}

/**
 * How to point an agent at this key. It is a dialog rather than a slab under
 * the detail: eight platforms of instructions dwarfed the key's own state, and
 * an operator reads exactly one of them, once.
 */
function AgentSetupDialog({
  apiKey,
  closeHref,
  gatewayBaseUrl,
  grants,
  params,
  routePolicies,
}: {
  apiKey: ConsoleApiKey;
  closeHref: string;
  gatewayBaseUrl: string;
  grants: ConsoleApiKeyVirtualModelGrant[];
  params: SearchParams;
  routePolicies: ConsoleRoutePolicy[];
}) {
  const nameByVirtualModelId = new Map(
    routePolicies.map((policy) => [policy.virtualModelId, policy.virtualModelName]),
  );
  const grantName = (grant: ConsoleApiKeyVirtualModelGrant) =>
    nameByVirtualModelId.get(grant.virtualModelId) ?? "unknown model";
  const defaultModel = grants.find((grant) => grant.isDefault);
  const defaultModelName = defaultModel ? grantName(defaultModel) : null;
  const firstGranted = grants[0];

  return (
    <Dialog
      closeHref={closeHref}
      title="Set up an agent"
      titleNote={`${apiKey.name} · gateway ${gatewayBaseUrl
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "")} · default model ${
        defaultModelName ?? "none — clients must send a model"
      }`}
      width={900}
    >
      <div className="mt-4">
        <IntegrationPanel
          gatewayBaseUrl={gatewayBaseUrl}
          keyPrefix={apiKey.keyPrefix}
          model={
            defaultModelName ??
            (firstGranted ? grantName(firstGranted) : null) ??
            "your-virtual-model"
          }
          params={params}
          pathname="/api-keys"
        />
      </div>
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
  params,
  usage,
}: {
  apiKey: ConsoleApiKey;
  closeHref: string;
  grants: ConsoleApiKeyVirtualModelGrant[];
  params: SearchParams;
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
        {/* The safer way out is offered as the thing itself, not as advice
            about a control the operator now has to go and find. */}
        <ActionLink href={buildHref("/api-keys", params, { dialog: "disable" })}>
          Disable instead
        </ActionLink>
        <span className="ml-1 font-mono text-12 text-dim">
          keeps configuration and stops traffic
        </span>
      </TypeNameToConfirm>
    </Dialog>
  );
}

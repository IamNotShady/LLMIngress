import type { ConsoleProvider } from "@llmingress/db/console-providers";
import {
  type ConsoleProviderModelOption,
  type ConsoleProviderModelPage,
  type ConsoleRoutePolicy,
  listProviderModelOptionsByIds,
  type RoutePolicyStrategy,
  routePolicyStrategies,
} from "@llmingress/db/console-route-policies";
import type { ConsoleUsageSummary } from "@llmingress/db/console-usage";
import type {
  ConsoleApiKeyVirtualModelGrant,
  ConsoleVirtualModel,
} from "@llmingress/db/console-virtual-models";
import Link from "next/link";
import { TypeNameToConfirm } from "../confirm-form";
import { ActionButton, ActionLink, Field, filterControlClass, TextInput } from "../controls";
import { formatCost, formatCount, formatPricePair } from "../format";
import { DetailRow } from "../layout";
import { formatModelContextTokens } from "../model-capability-format";
import { MutationForm } from "../mutation-form";
import { Dialog, DialogActions, DialogBody, DialogImpact, DialogNote } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";
import { providerIsMetered } from "../providers/model";
import { SyncedSelect } from "../synced-select";
import { formatRange, Pagination } from "../table";
import { EditorNav } from "./editor-nav";
import { strategyRouteNote } from "./strategy";

const PROTOCOLS = ["chat_completions", "messages", "responses"] as const;

/** The candidate filters submit as GET while the editor posts, so they own a
 * separate form element and the controls associate with it by id. */
const CANDIDATE_FILTER_FORM_ID = "virtual-model-candidate-filters";

const PRESERVED_EDITOR_FIELDS = ["name", "description"] as const;

/** A strategy carried in the URL is only honoured when it is one the router has. */
function readRoutePolicyStrategy(value: string | undefined): RoutePolicyStrategy | null {
  return routePolicyStrategies.find((entry) => entry === value) ?? null;
}

/** Selection lives in the URL as an ordered id list, so paging never drops it. */
function readSelection(params: SearchParams): string[] {
  const raw = readParam(params, "candidates");
  return raw ? raw.split(",").filter(Boolean) : [];
}

export async function VirtualModelDialogs({
  candidatePage,
  grants,
  params,
  policy,
  providers,
  usage,
  virtualModel,
}: {
  candidatePage: ConsoleProviderModelPage | null;
  grants: ConsoleApiKeyVirtualModelGrant[];
  params: SearchParams;
  policy: ConsoleRoutePolicy | null;
  providers: ConsoleProvider[];
  usage: ConsoleUsageSummary;
  virtualModel: ConsoleVirtualModel | undefined;
}) {
  const dialog = readParam(params, "dialog");
  const closeHref = buildHref("/models", params, {
    candidateAvailability: null,
    candidatePage: null,
    candidateProvider: null,
    candidateQuery: null,
    candidates: null,
    dialog: null,
  });

  if (dialog === "delete" && virtualModel) {
    return (
      <DeleteVirtualModelDialog
        closeHref={closeHref}
        grants={grants.filter((grant) => grant.virtualModelId === virtualModel.id)}
        policy={policy}
        usage={usage}
        virtualModel={virtualModel}
      />
    );
  }

  if (dialog !== "new" && dialog !== "edit") {
    return null;
  }
  const editing = dialog === "edit" ? virtualModel : undefined;
  // On first open, the editor starts from the route that is already stored.
  const selection =
    readParam(params, "candidates") === undefined && editing && policy
      ? policy.candidates.map((candidate) => candidate.id)
      : readSelection(params);

  const selectedModels = await listProviderModelOptionsByIds({ providerModelIds: selection });
  const selectedById = new Map(selectedModels.map((model) => [model.id, model]));
  const orderedSelection = selection
    .map((id) => selectedById.get(id))
    .filter((model): model is ConsoleProviderModelOption => Boolean(model));

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const protocol = readParam(params, "protocol") ?? policy?.endpointProtocol ?? PROTOCOLS[0];
  const strategy =
    readRoutePolicyStrategy(readParam(params, "editorStrategy")) ??
    policy?.strategy ??
    "load_balance";

  const withSelection = (ids: string[]) =>
    buildHref("/models", params, { candidates: ids.join(","), candidatePage: null });

  return (
    <Dialog
      closeHref={closeHref}
      title={editing ? `Virtual Model · ${editing.name}` : "New Virtual Model"}
      width={980}
    >
      <EditorNav>
        <MutationForm
          action="/api/virtual-models"
          fallbackError="The virtual model could not be saved."
          invalidFieldOnError="name"
          onSuccessHref={closeHref}
        >
          <input
            type="hidden"
            name="action"
            value={editing ? "updateWithRoute" : "createWithRoute"}
          />
          {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
          {editing && policy ? (
            <input type="hidden" name="routePolicyId" value={policy.id} />
          ) : null}
          {orderedSelection.map((model) => (
            <input key={model.id} type="hidden" name="providerModelIds" value={model.id} />
          ))}

          <div className="mt-[18px] grid grid-cols-2 gap-4">
            <Field label="NAME" labelNote='(what clients send as "model")'>
              <TextInput
                name="name"
                defaultValue={readParam(params, "editor_name") ?? editing?.name ?? ""}
                required
              />
            </Field>
            <Field label="DESCRIPTION">
              <TextInput
                name="description"
                defaultValue={readParam(params, "editor_description") ?? editing?.description ?? ""}
              />
            </Field>
          </div>
          <div className="mt-[14px] grid grid-cols-2 gap-4">
            <Field
              label="ENDPOINT PROTOCOL"
              hint="Candidates that do not serve this protocol cannot be selected."
            >
              <SyncedSelect
                id="virtual-model-dialog-endpoint"
                name="endpointProtocol"
                href={buildHref("/models", params, { candidatePage: null, protocol: "__value__" })}
                preserveFields={PRESERVED_EDITOR_FIELDS}
                value={protocol}
              >
                {PROTOCOLS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </SyncedSelect>
            </Field>
            <Field label="STRATEGY" hint={strategyRouteNote[strategy]}>
              <SyncedSelect
                id="virtual-model-dialog-strategy"
                name="strategy"
                href={buildHref("/models", params, { editorStrategy: "__value__" })}
                preserveFields={PRESERVED_EDITOR_FIELDS}
                value={strategy}
              >
                {routePolicyStrategies.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </SyncedSelect>
            </Field>
          </div>

          <div className="mt-4 flex items-baseline gap-[10px]">
            <span className="font-mono text-115 font-medium tracking-[.08em] text-dim">
              CANDIDATES · AT LEAST ONE — KNOWN CAPABILITIES MUST AGREE
            </span>
            <span className="ml-auto font-mono text-12 text-faint">
              {formatCount(orderedSelection.length)} selected
            </span>
          </div>

          <div
            data-testid="virtual-model-selected"
            className="mt-2 rounded-xs border border-rule bg-track px-3 pb-2 pt-1"
          >
            <div className="flex items-baseline gap-[10px] border-b border-rule pb-[5px] pt-[6px]">
              <span className="font-mono text-115 font-medium tracking-[.08em] text-dim">
                SELECTED · TRIED IN THIS ORDER
              </span>
              <span className="ml-auto whitespace-nowrap font-mono text-12 text-faint">
                use ↑↓ to reorder
              </span>
            </div>
            {orderedSelection.length === 0 ? (
              <p className="py-3 font-mono text-13 text-dim">
                Nothing selected yet — a route with no candidate cannot serve a request.
              </p>
            ) : (
              orderedSelection.map((model, index) => {
                const provider = providerById.get(model.providerId);
                const ids = orderedSelection.map((entry) => entry.id);
                const up = swap(ids, index, index - 1);
                const down = swap(ids, index, index + 1);
                return (
                  <div
                    key={model.id}
                    className="flex items-center gap-[10px] border-b border-rule2 py-[7px] font-mono text-13 text-ink last:border-b-0"
                  >
                    <span className="w-3 text-faint tabnum">{index + 1}</span>
                    <span className="min-w-0 flex-1 font-medium cell-clip">
                      {model.providerDisplayName} · {model.modelId}
                    </span>
                    <span className="whitespace-nowrap text-dim">
                      {formatPricePair({
                        inputUsdPerMillionTokens: model.inputUsdPerMillionTokens,
                        metered: provider ? providerIsMetered(provider) : true,
                        outputUsdPerMillionTokens: model.outputUsdPerMillionTokens,
                      })}
                    </span>
                    <span className="whitespace-nowrap text-dim">
                      ctx {formatModelContextTokens(model.contextWindow)}
                    </span>
                    <span className="flex flex-none gap-[5px] text-dim">
                      <Link
                        href={withSelection(up)}
                        aria-label={`Move ${model.modelId} up`}
                        className={index === 0 ? "opacity-35" : undefined}
                      >
                        ↑
                      </Link>
                      <Link
                        href={withSelection(down)}
                        aria-label={`Move ${model.modelId} down`}
                        className={index === ids.length - 1 ? "opacity-35" : undefined}
                      >
                        ↓
                      </Link>
                      <Link
                        href={withSelection(ids.filter((id) => id !== model.id))}
                        aria-label={`Remove ${model.modelId}`}
                        className="ml-1 text-redtx"
                      >
                        ✕
                      </Link>
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <CandidateBrowser
            candidatePage={candidatePage}
            params={params}
            protocol={protocol}
            providerById={providerById}
            providers={providers}
            selection={orderedSelection.map((model) => model.id)}
          />

          <DialogActions>
            <ActionButton
              className="px-4 py-[6px] text-135"
              disabled={orderedSelection.length === 0}
              tone="primary"
            >
              {editing ? "Save virtual model" : "Create virtual model"}
            </ActionButton>
            <ActionLink href={closeHref}>Cancel</ActionLink>
          </DialogActions>
        </MutationForm>
      </EditorNav>
      <form id={CANDIDATE_FILTER_FORM_ID} method="get" action="/models" hidden>
        {passthroughFields(params, [
          "selected",
          "dialog",
          "candidates",
          "protocol",
          "editorStrategy",
          "editor_name",
          "editor_description",
        ])}
      </form>
    </Dialog>
  );
}

function CandidateBrowser({
  candidatePage,
  params,
  protocol,
  providerById,
  providers,
  selection,
}: {
  candidatePage: ConsoleProviderModelPage | null;
  params: SearchParams;
  protocol: string;
  providerById: Map<string, ConsoleProvider>;
  providers: ConsoleProvider[];
  selection: string[];
}) {
  const activeProviderId = readParam(params, "candidateProvider") ?? providers[0]?.id;
  const pageSize = 8;

  return (
    <>
      <div className="mt-[14px] flex items-center gap-2">
        <span className="flex items-center gap-2">
          <select
            form={CANDIDATE_FILTER_FORM_ID}
            name="candidateProvider"
            defaultValue={activeProviderId}
            aria-label="Filter candidates by provider"
            className={filterControlClass}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
          <input
            form={CANDIDATE_FILTER_FORM_ID}
            name="candidateQuery"
            defaultValue={readParam(params, "candidateQuery") ?? ""}
            placeholder="search model id…"
            aria-label="Search candidate models"
            className={`${filterControlClass} w-[170px]`}
          />
          <select
            form={CANDIDATE_FILTER_FORM_ID}
            name="candidateAvailability"
            defaultValue={readParam(params, "candidateAvailability") ?? "available"}
            aria-label="Filter candidates by availability"
            className={filterControlClass}
          >
            <option value="available">Availability: available</option>
            <option value="all">all</option>
            <option value="deprecated">deprecated</option>
          </select>
          <button
            form={CANDIDATE_FILTER_FORM_ID}
            type="submit"
            className="whitespace-nowrap rounded-xs border border-btnbd bg-btnbg px-2 py-1 font-mono text-12 text-ink"
          >
            Apply
          </button>
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-12 text-faint">
          {candidatePage ? `${formatCount(candidatePage.total)} matches` : null}
        </span>
      </div>

      <div className="mt-[10px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
        ADD FROM MATCHING MODELS
      </div>
      <div data-testid="virtual-model-candidates">
        {candidatePage && candidatePage.items.length > 0 ? (
          candidatePage.items.map((model) => {
            const provider = providerById.get(model.providerId);
            const selected = selection.includes(model.id);
            const supported = model.supportedEndpoints.includes(
              protocol as (typeof model.supportedEndpoints)[number],
            );
            const next = selected
              ? selection.filter((id) => id !== model.id)
              : [...selection, model.id];
            const row = (
              <>
                <span
                  aria-hidden="true"
                  className={`grid size-[13px] flex-none place-items-center rounded-[2px] border ${
                    selected ? "border-accent bg-accent text-segfg" : "border-btnbd bg-btnbg"
                  } font-mono text-[10px]`}
                >
                  {selected ? "✓" : ""}
                </span>
                <span className={`min-w-0 flex-1 cell-clip ${selected ? "font-medium" : ""}`}>
                  {model.providerDisplayName} · {model.modelId}
                  {supported ? null : ` — does not serve ${protocol}`}
                </span>
                <span className="whitespace-nowrap text-dim">
                  {formatPricePair({
                    inputUsdPerMillionTokens: model.inputUsdPerMillionTokens,
                    metered: provider ? providerIsMetered(provider) : true,
                    outputUsdPerMillionTokens: model.outputUsdPerMillionTokens,
                  })}
                </span>
                <span className="whitespace-nowrap text-dim">
                  ctx {formatModelContextTokens(model.contextWindow)}
                </span>
              </>
            );
            return supported ? (
              <Link
                key={model.id}
                href={buildHref("/models", params, { candidates: next.join(",") })}
                className="flex items-center gap-[10px] border-b border-rule2 py-2 font-mono text-13 text-ink"
              >
                {row}
              </Link>
            ) : (
              <div
                key={model.id}
                className="flex items-center gap-[10px] border-b border-rule2 py-2 font-mono text-13 text-faint"
              >
                {row}
              </div>
            );
          })
        ) : (
          <p className="py-5 font-mono text-13 text-dim">
            No model matches this provider, search and availability filter.
          </p>
        )}
      </div>
      {candidatePage && candidatePage.items.length > 0 ? (
        <Pagination
          buildHref={(page) => buildHref("/models", params, { candidatePage: String(page) })}
          page={candidatePage.page}
          pageCount={candidatePage.pageCount}
          rangeLabel={formatRange({
            page: candidatePage.page,
            pageSize,
            total: candidatePage.total,
          })}
        />
      ) : null}
      <p className="mt-2 font-mono text-12 text-faint">
        Already-selected models stay checked here and appear in the list above.
      </p>
    </>
  );
}

/** Reorder helper: out of range is a no-op, which is what the end rows want. */
function swap(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  const moved = next[from];
  const target = next[to];
  if (moved === undefined || target === undefined) {
    return next;
  }
  next[from] = target;
  next[to] = moved;
  return next;
}

/** Keeps dialog state alive across the browser's own GET submissions. */
function passthroughFields(params: SearchParams, keys: string[]) {
  return keys.map((key) => {
    const value = readParam(params, key);
    return value === undefined ? null : <input key={key} type="hidden" name={key} value={value} />;
  });
}

function DeleteVirtualModelDialog({
  closeHref,
  grants,
  policy,
  usage,
  virtualModel,
}: {
  closeHref: string;
  grants: ConsoleApiKeyVirtualModelGrant[];
  policy: ConsoleRoutePolicy | null;
  usage: ConsoleUsageSummary;
  virtualModel: ConsoleVirtualModel;
}) {
  const breakdown = usage.virtualModelBreakdowns.find((entry) => entry.id === virtualModel.id);
  const defaultFor = grants.filter((grant) => grant.isDefault).map((grant) => grant.apiKeyName);

  return (
    <Dialog closeHref={closeHref} danger tag="permanent" title="Delete virtual model" width={520}>
      <DialogBody>
        Clients sending <strong className="font-medium">{virtualModel.name}</strong> as the model
        will fail with 404 once this is saved. Its route and candidate order are deleted; keys
        holding it as their default fall back to no default.
      </DialogBody>
      <DialogImpact>
        <DetailRow
          label="route"
          value={
            policy
              ? `${policy.strategy} · ${policy.candidates.length} candidates`
              : "no route stored"
          }
        />
        <DetailRow
          clip
          label="granted to"
          value={grants.length > 0 ? grants.map((grant) => grant.apiKeyName).join(", ") : "no keys"}
          valueClassName={grants.length > 0 ? "text-redtx" : "text-ink"}
        />
        <DetailRow
          clip
          label="default for"
          value={defaultFor.length > 0 ? defaultFor.join(", ") : "no keys"}
          valueClassName={defaultFor.length > 0 ? "text-redtx" : "text-ink"}
        />
        <DetailRow
          label="requests 24h"
          value={`${formatCount(virtualModel.requestCount24h)} · ${formatCost(
            breakdown?.totalCostUsd ?? null,
          )}`}
        />
        <DetailRow label="activity history" value="kept, attributed to the name snapshot" />
      </DialogImpact>
      <TypeNameToConfirm
        action="/api/virtual-models"
        confirmLabel="Delete model"
        onSuccessHref="/models"
        hiddenFields={{ action: "delete", id: virtualModel.id }}
        label="TYPE THE MODEL NAME TO CONFIRM"
        name={virtualModel.name}
      >
        <ActionLink href={closeHref}>Cancel</ActionLink>
        <span className="ml-1 font-mono text-12 text-dim">
          Revoke the grants instead — keeps the route intact
        </span>
      </TypeNameToConfirm>
      <DialogNote>
        Disabling a key or removing its grant stops traffic without losing this route.
      </DialogNote>
    </Dialog>
  );
}

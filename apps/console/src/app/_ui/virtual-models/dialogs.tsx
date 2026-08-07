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
import { EditorNav } from "../editor-nav";
import { formatCost, formatCount, formatPricePair } from "../format";
import { DetailRow } from "../layout";
import { formatModelContextTokens } from "../model-capability-format";
import { MutationForm } from "../mutation-form";
import { Dialog, DialogActions, DialogBody, DialogImpact, DialogNote } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";
import { providerIsMetered } from "../providers/model";
import { SyncedSearchInput } from "../synced-search";
import { SyncedSelect } from "../synced-select";
import { formatRange, Pagination } from "../table";
import { candidateParamChange, readCandidateSelection } from "./candidate-params";
import {
  activeCandidateProviderId,
  providersServingProtocol,
  ROUTE_PROTOCOLS,
  readRouteProtocol,
} from "./candidate-providers";
import { strategyRouteNote } from "./strategy";
import { WeightInput } from "./weight-input";

const PRESERVED_EDITOR_FIELDS = ["name", "description"] as const;

/** A strategy carried in the URL is only honoured when it is one the router has. */
function readRoutePolicyStrategy(value: string | undefined): RoutePolicyStrategy | null {
  return routePolicyStrategies.find((entry) => entry === value) ?? null;
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
  // Closing drops the whole draft: the candidates picked but not saved, the
  // name and description typed into the editor, and the protocol and strategy
  // it was reading. What is left behind belongs to the model it was typed for,
  // and the next model has to open on its own values.
  const closeHref = buildHref("/models", params, {
    candidateAvailability: null,
    candidatePage: null,
    candidateProvider: null,
    candidateQuery: null,
    candidates: null,
    dialog: null,
    editor_description: null,
    editor_name: null,
    editorStrategy: null,
    protocol: null,
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
  const selection = readCandidateSelection(
    params,
    editing && policy ? policy.candidates.map((candidate) => candidate.id) : [],
  );

  const selectedModels = await listProviderModelOptionsByIds({ providerModelIds: selection });
  const selectedById = new Map(selectedModels.map((model) => [model.id, model]));
  const orderedSelection = selection
    .map((id) => selectedById.get(id))
    .filter((model): model is ConsoleProviderModelOption => Boolean(model));

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const protocol =
    readRouteProtocol(readParam(params, "protocol")) ??
    policy?.endpointProtocol ??
    ROUTE_PROTOCOLS[0];
  const strategy =
    readRoutePolicyStrategy(readParam(params, "editorStrategy")) ??
    policy?.strategy ??
    "load_balance";
  const routesByTag = strategy === "tag";
  const routesByWeight = strategy === "weighted";
  // candidate.id is the provider model id, which is what the selection carries.
  const storedTagsByModelId = new Map(
    (policy?.candidates ?? []).map((candidate) => [candidate.id, candidate.tags.join(", ")]),
  );
  // Weight re-displays exactly as stored: numeric(3,2) round-trips as a
  // two-decimal string, so the editor shows 0.25 for a stored 0.25.
  const storedWeightsByModelId = new Map(
    (policy?.candidates ?? []).map((candidate) => [
      candidate.id,
      candidate.weight === null ? "" : candidate.weight.toFixed(2),
    ]),
  );

  const withSelection = (ids: string[]) =>
    buildHref("/models", params, {
      candidatePage: null,
      candidates: candidateParamChange(ids),
    });

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
              hint="Only providers that serve this protocol are offered below."
            >
              <SyncedSelect
                id="virtual-model-dialog-endpoint"
                name="endpointProtocol"
                href={buildHref("/models", params, { candidatePage: null, protocol: "__value__" })}
                preserveFields={PRESERVED_EDITOR_FIELDS}
                value={protocol}
              >
                {ROUTE_PROTOCOLS.map((value) => (
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
              {routesByTag
                ? "CANDIDATES · TAGS ROUTE REQUESTS · EXACTLY ONE DEFAULT"
                : routesByWeight
                  ? "CANDIDATES · WEIGHTS SUM TO 1.00 — KNOWN CAPABILITIES MUST AGREE"
                  : "CANDIDATES · AT LEAST ONE — KNOWN CAPABILITIES MUST AGREE"}
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
                {routesByTag
                  ? "SELECTED · ROUTED BY TAG · FAILURES FALL TO DEFAULT"
                  : routesByWeight
                    ? "SELECTED · SPLIT BY WEIGHT · FAILURES FALL THROUGH IN DRAWN ORDER"
                    : "SELECTED · TRIED IN THIS ORDER"}
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
                    {/* One candidateTags field per row, in the same order as the
                        providerModelIds hidden inputs above, so FormData pairs a
                        tag list with the model it was typed for. Non-tag
                        strategies still emit an empty entry to keep that pairing.
                        The wrapper fixes the width: the input's own class is
                        w-full, which would otherwise eat the whole row.
                        Known limit: this field cannot join
                        PRESERVED_EDITOR_FIELDS (repeated names read back as a
                        RadioNodeList), so reordering, adding, removing a
                        candidate or switching strategy drops unsaved tag text —
                        the same as NAME and DESCRIPTION under plain Link
                        navigation. */}
                    {routesByTag ? (
                      <span className="block w-[190px] flex-none">
                        <TextInput
                          aria-label={`Tags for ${model.modelId}`}
                          defaultValue={storedTagsByModelId.get(model.id) ?? ""}
                          name="candidateTags"
                          placeholder="default / fast, cheap"
                        />
                      </span>
                    ) : (
                      <input type="hidden" name="candidateTags" value="" />
                    )}
                    {/* One draft-constrained candidateWeights field per row,
                        index-aligned with the providerModelIds hidden inputs
                        exactly like candidateTags above; non-weighted
                        strategies still emit an empty entry to keep that
                        pairing. The wrapper fixes the width: the input's own
                        class is w-full. Known limit: this field cannot join
                        PRESERVED_EDITOR_FIELDS (repeated names read back as a
                        RadioNodeList), so reordering, adding, removing a
                        candidate or switching strategy drops unsaved weight
                        text — the same as NAME and DESCRIPTION under plain
                        Link navigation. */}
                    {routesByWeight ? (
                      <span className="block w-[72px] flex-none">
                        <WeightInput
                          aria-label={`Weight for ${model.modelId}`}
                          defaultValue={storedWeightsByModelId.get(model.id) ?? ""}
                          name="candidateWeights"
                        />
                      </span>
                    ) : (
                      <input type="hidden" name="candidateWeights" value="" />
                    )}
                    {/* Fixed-width trailing columns so the tag field lines up
                        across rows instead of drifting with each row's price. */}
                    <span className="w-[180px] flex-none whitespace-nowrap text-right text-dim cell-clip">
                      {formatPricePair({
                        inputUsdPerMillionTokens: model.inputUsdPerMillionTokens,
                        metered: provider ? providerIsMetered(provider) : true,
                        outputUsdPerMillionTokens: model.outputUsdPerMillionTokens,
                      })}
                    </span>
                    <span className="w-[76px] flex-none whitespace-nowrap text-right text-dim">
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
            <ActionButton size="dialog" disabled={orderedSelection.length === 0} tone="primary">
              {editing ? "Save virtual model" : "Create virtual model"}
            </ActionButton>
            <ActionLink href={closeHref}>Cancel</ActionLink>
          </DialogActions>
        </MutationForm>
      </EditorNav>
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
  // Only the providers that speak this protocol, and only one of those can be
  // the active one — a stored choice that stops serving after a protocol change
  // does not survive it.
  const serving = providersServingProtocol(providers, protocol);
  const activeProviderId = activeCandidateProviderId(
    providers,
    protocol,
    readParam(params, "candidateProvider"),
  );
  const pageSize = 8;

  return (
    <>
      <div className="mt-[14px] flex items-center gap-2">
        <span className="flex items-center gap-2">
          {/* Picking a provider shows that provider's models straight away:
              waiting for Apply left the list describing someone else. The
              wrapper fixes the width: the select's own class is w-full, which
              would otherwise let it eat the rest of the filter row. */}
          <span className="block w-[190px] flex-none">
            <SyncedSelect
              aria-label="Filter candidates by provider"
              className={filterControlClass}
              href={buildHref("/models", params, {
                candidatePage: null,
                candidateProvider: "__value__",
              })}
              name="candidateProvider"
              preserveFields={PRESERVED_EDITOR_FIELDS}
              value={activeProviderId ?? ""}
            >
              {serving.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))}
            </SyncedSelect>
          </span>
          <SyncedSearchInput
            aria-label="Search candidate models"
            className={`${filterControlClass} w-[170px]`}
            href={buildHref("/models", params, {
              candidatePage: null,
              candidateQuery: "__value__",
            })}
            name="candidateQuery"
            placeholder="search model id…"
            preserveFields={PRESERVED_EDITOR_FIELDS}
            value={readParam(params, "candidateQuery") ?? ""}
          />
          <span className="block w-[232px] flex-none">
            <SyncedSelect
              aria-label="Filter candidates by availability"
              className={filterControlClass}
              href={buildHref("/models", params, {
                candidateAvailability: "__value__",
                candidatePage: null,
              })}
              name="candidateAvailability"
              preserveFields={PRESERVED_EDITOR_FIELDS}
              value={readParam(params, "candidateAvailability") ?? "available"}
            >
              <option value="available">Availability: available</option>
              <option value="all">all</option>
              <option value="deprecated">deprecated</option>
            </SyncedSelect>
          </span>
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-12 text-faint">
          {candidatePage ? `${formatCount(candidatePage.total)} matches` : null}
        </span>
      </div>

      <div className="mt-[10px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
        ADD FROM MATCHING MODELS
      </div>
      <div data-testid="virtual-model-candidates">
        {serving.length === 0 ? (
          <p className="py-5 font-mono text-13 leading-[1.6] text-dim">
            No connected provider serves {protocol}. Add one that does, or pick a protocol your
            providers already speak.
          </p>
        ) : candidatePage && candidatePage.items.length > 0 ? (
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

import type { ConsoleProviderQuotaSummary } from "@llmingress/db/console-provider-quota";
import type {
  ConsoleProvider,
  ConsoleProviderModelRefreshStatus,
} from "@llmingress/db/console-providers";
import type { ConsoleProviderModelPage } from "@llmingress/db/console-route-policies";
import type { ConsoleUsageSummary } from "@llmingress/db/console-usage";
import {
  ActionButton,
  ActionLink,
  FilterButton,
  filterControlClass,
  RowActionButton,
  StatusDot,
} from "../controls";
import {
  formatCapabilities,
  formatCost,
  formatCount,
  formatDateOnly,
  formatPricePerMillion,
  formatRelative,
} from "../format";
import { DetailRow, SectionTitle } from "../layout";
import { formatModelContextTokens } from "../model-capability-format";
import { MutationForm } from "../mutation-form";
import {
  buildHref,
  readPageSizeParam,
  readParam,
  type SearchParams,
  urlFormStateKey,
} from "../params";
import { PlanQuotaPanel } from "../quota-panel";
import { formatRange, GridRow, Pagination } from "../table";
import {
  describeConnectionHealth,
  describeProbeSchedule,
  describeProviderHealth,
  type ProviderConnection,
  providerIsMetered,
} from "./model";

const CONNECTION_COLUMNS = "116px minmax(0,1fr) 64px 244px 88px 104px 218px";
const MODEL_COLUMNS = "258px 146px 146px 104px 1fr";

export function ProviderDetail({
  connections,
  modelPage,
  now,
  params,
  provider,
  quotas,
  refreshStatus,
  usage,
}: {
  connections: ProviderConnection[];
  modelPage: ConsoleProviderModelPage | null;
  now: Date;
  params: SearchParams;
  provider: ConsoleProvider;
  quotas: ConsoleProviderQuotaSummary[];
  refreshStatus: ConsoleProviderModelRefreshStatus | null;
  usage: ConsoleUsageSummary;
}) {
  const health = describeProviderHealth(connections);
  const metered = providerIsMetered(provider);
  const breakdown = usage.providerBreakdowns.find((entry) => entry.id === provider.id);
  const href = (changes: Record<string, string | null>) => buildHref("/providers", params, changes);

  const modelQuery = readParam(params, "modelQuery") ?? "";
  const availability = readParam(params, "availability") ?? "available";
  const providerModelFilterFormKey = urlFormStateKey(provider.id, modelQuery, availability);
  // The same bound the page applies before it queries: what this renders is a
  // page of models, and its controls have to name the page that was fetched.
  const pageSize = readPageSizeParam(params, "modelPageSize", 20);

  return (
    <div key={provider.id} className="min-w-0 pl-6 pt-[18px]">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 font-sans text-19 font-semibold text-ink">{provider.displayName}</h2>
        <span className="font-mono text-13 text-dim">{provider.providerType}</span>
        <span
          className={`flex items-center gap-[5px] font-mono text-125 font-medium ${healthTextClass(health.tone)}`}
        >
          <StatusDot tone={health.tone} />
          {health.text}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <ActionLink href={href({ dialog: "edit" })}>Edit</ActionLink>
          <ActionLink href={href({ dialog: provider.enabled ? "disable" : "enable" })}>
            {provider.enabled ? "Disable" : "Enable"}
          </ActionLink>
          <ActionLink href={href({ dialog: "delete" })} tone="danger">
            Delete
          </ActionLink>
        </div>
      </div>
      <MutationForm
        action="/api/provider-model-refresh"
        className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2"
        errorPresentation="toast"
        fallbackError="The model refresh could not be queued."
      >
        <input type="hidden" name="providerId" value={provider.id} />
        <ActionButton className="col-start-2 row-start-1">Refresh models</ActionButton>
      </MutationForm>

      {refreshStatus?.failure ? (
        <div className="mt-[14px] flex flex-wrap items-start gap-[10px] rounded-sm border border-ambbd bg-ambbg px-[13px] py-[11px]">
          <span className="mt-[5px] size-[7px] flex-none rounded-full bg-red" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-13 font-medium text-ink">
              Model refresh failed · {refreshStatus.failure.errorCode ?? "unknown_error"}
            </div>
            <div className="mt-[3px] font-mono text-125 leading-[1.6] text-dim">
              {refreshStatus.failure.errorMessage ??
                "The worker could not read this provider's model list."}{" "}
              Showing the list from the last successful refresh{" "}
              {formatRelative(refreshStatus.lastSucceededAt, now)}.
            </div>
          </div>
          <MutationForm
            action="/api/provider-model-refresh"
            className="max-w-full flex-[0_1_auto]"
            errorPresentation="toast"
            fallbackError="The model refresh could not be queued."
          >
            <input type="hidden" name="providerId" value={provider.id} />
            <ActionButton className="bg-bg">Retry now</ActionButton>
          </MutationForm>
        </div>
      ) : null}

      <div className="mt-[14px] grid grid-cols-3 gap-x-6 border-t border-hair">
        <DetailRow label="type" value={provider.providerType} />
        <DetailRow label="models" value={formatCount(provider.providerModelCount)} />
        <DetailRow
          label="refreshed"
          value={formatRelative(refreshStatus?.modelsUpdatedAt ?? null, now)}
        />
        <DetailRow clip label="base url" value={provider.baseUrl ?? "template default"} />
        <DetailRow label="requests 24h" value={formatCount(breakdown?.requestCount ?? 0)} />
        <DetailRow
          label="cost 24h"
          value={formatCost(breakdown?.totalCostUsd ?? null, { metered })}
        />
      </div>

      <SectionTitle
        className="mt-5"
        note={
          metered
            ? "lower priority is tried first"
            : provider.providerType === "local"
              ? "a server on your own network — no cost is recorded"
              : "subscription plans are not metered — no cost is recorded"
        }
        trailing={
          // A local provider has exactly one endpoint, which is the provider's
          // own base url — there is no second one to add, only this one to edit.
          provider.providerType === "local" ? null : (
            // Adding names no connection: the parameter is dropped rather than
            // set to a placeholder, because a value that names nothing is what
            // the "connection is gone" guard exists to catch.
            <ActionLink href={href({ connection: null, providerKeyDialog: provider.id })}>
              {addConnectionLabel(provider)}
            </ActionLink>
          )
        }
      >
        Connections
      </SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={CONNECTION_COLUMNS} head>
          <span>LABEL</span>
          <span>CREDENTIAL</span>
          <span className="text-right">PRIORITY</span>
          <span>HEALTH</span>
          <span>STATUS</span>
          <span>LAST USED</span>
          <span className="text-right">ACTIONS</span>
        </GridRow>
        {connections.length === 0 ? (
          <p className="py-6 text-center font-mono text-13 text-dim">
            No connection yet — add a credential so this provider can serve traffic.
          </p>
        ) : (
          connections.map((connection) => {
            const connectionHealth = describeConnectionHealth(connection);
            const probeSchedule = describeProbeSchedule(connection, now);
            return (
              <GridRow key={connection.id} columns={CONNECTION_COLUMNS} className="py-2">
                <span className="font-medium cell-clip">{connection.label}</span>
                <span className="text-dim cell-clip">
                  {connection.credential}
                  {connection.tokenExpiresAt
                    ? ` · exp ${formatDateOnly(connection.tokenExpiresAt)}`
                    : ""}
                </span>
                <span className="text-right tabnum">{connection.priority}</span>
                <span
                  className={`flex items-center gap-[6px] cell-clip ${healthTextClass(connectionHealth.tone)}`}
                >
                  <StatusDot tone={connectionHealth.tone} />
                  {connectionHealth.text}
                  {probeSchedule ? <span className="text-faint">· {probeSchedule}</span> : null}
                </span>
                <span className={connection.enabled ? "text-green" : "text-faint"}>
                  {connection.enabled ? "enabled" : "disabled"}
                </span>
                {/* Which credential is actually serving. Only a stored key
                    records it — an authorized connection has no such column,
                    and saying "never" for one would be a claim, not a fact. */}
                <span className="text-dim cell-clip">
                  {connection.kind === "api_key"
                    ? connection.lastUsedAt
                      ? formatRelative(connection.lastUsedAt, now)
                      : "never"
                    : "—"}
                </span>
                <span className="flex flex-wrap items-center justify-end gap-[6px]">
                  <MutationForm
                    action="/api/provider-health-probes"
                    errorPresentation="toast"
                    fallbackError="The re-check could not be queued."
                  >
                    <input type="hidden" name="providerId" value={provider.id} />
                    <input type="hidden" name="providerConnectionId" value={connection.id} />
                    <RowActionButton>Re-check</RowActionButton>
                  </MutationForm>
                  <ActionLink
                    size="row"
                    href={href({ providerKeyDialog: provider.id, connection: connection.id })}
                  >
                    Edit
                  </ActionLink>
                  {/* A local provider's endpoint is the provider: there is no
                      credential row to erase, and deleting it means deleting
                      the provider, which its own Delete above already does. */}
                  {connection.kind === "local" ? null : (
                    <ActionLink
                      size="row"
                      href={href({ dialog: "deleteConnection", connection: connection.id })}
                      tone="danger"
                    >
                      Delete
                    </ActionLink>
                  )}
                </span>
              </GridRow>
            );
          })
        )}
      </div>

      <PlanQuotaPanel now={now} summaries={quotas} />

      <div className="mt-5 flex items-center gap-[10px]">
        <span className="flex-none font-sans text-155 font-semibold text-ink">Models</span>
        <form
          key={providerModelFilterFormKey}
          method="get"
          action="/providers"
          className="flex items-center gap-2"
        >
          <input type="hidden" name="selected" value={provider.id} />
          <input type="hidden" name="modelPageSize" value={String(pageSize)} />
          <input
            name="modelQuery"
            defaultValue={modelQuery}
            placeholder="search model id…"
            aria-label="Search models"
            className={`${filterControlClass} w-[150px]`}
          />
          <select
            name="availability"
            defaultValue={availability}
            aria-label="Filter by availability"
            className={filterControlClass}
          >
            <option value="available">Availability: available</option>
            <option value="all">all</option>
            <option value="deprecated">deprecated</option>
            <option value="not_listed">not_listed</option>
            <option value="unavailable">unavailable</option>
          </select>
          <FilterButton>Apply</FilterButton>
        </form>
        <span className="whitespace-nowrap font-mono text-12 text-faint">
          {modelPage ? `${formatCount(modelPage.total)} matching` : null}
        </span>
        <span className="ml-auto flex flex-none items-center gap-2 whitespace-nowrap font-mono text-12 text-dim">
          {[20, 50, 100].map((size) => (
            <a
              key={size}
              href={href({ modelPage: null, modelPageSize: String(size) })}
              className={size === pageSize ? "text-ink" : undefined}
            >
              {size}
            </a>
          ))}
          <span className="text-faint">/ page</span>
        </span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={MODEL_COLUMNS} head>
          <span>MODEL ID</span>
          <span className="text-right">PRICE IN / M</span>
          <span className="text-right">PRICE OUT / M</span>
          <span className="text-right">CONTEXT</span>
          <span className="text-right">CAPABILITIES</span>
        </GridRow>
        {modelPage && modelPage.items.length > 0 ? (
          modelPage.items.map((model) => (
            <GridRow key={model.id} columns={MODEL_COLUMNS}>
              <span className="font-medium cell-clip">{model.modelId}</span>
              <span className="text-right text-dim tabnum">
                {metered ? formatPricePerMillion(model.inputUsdPerMillionTokens) : "plan"}
              </span>
              <span className="text-right text-dim tabnum">
                {metered ? formatPricePerMillion(model.outputUsdPerMillionTokens) : "plan"}
              </span>
              <span className="text-right text-dim tabnum">
                {formatModelContextTokens(model.contextWindow)}
              </span>
              <span className="text-right text-dim cell-clip">{formatCapabilities(model)}</span>
            </GridRow>
          ))
        ) : (
          <p className="py-8 text-center font-mono text-13 text-dim">
            No models match this search and availability filter.
          </p>
        )}
      </div>
      {modelPage && modelPage.items.length > 0 ? (
        <Pagination
          buildHref={(page) => href({ modelPage: String(page) })}
          page={modelPage.page}
          pageCount={modelPage.pageCount}
          rangeLabel={formatRange({
            page: modelPage.page,
            pageSize,
            total: modelPage.total,
          })}
        />
      ) : null}
    </div>
  );
}

/** Local providers have no second connection to add, so they are not here. */
function addConnectionLabel(provider: ConsoleProvider): string {
  return provider.providerType === "subscription" ? "+ Authorize token" : "+ Add key";
}

function healthTextClass(tone: "amber" | "dim" | "green" | "red"): string {
  return tone === "green"
    ? "text-green"
    : tone === "amber"
      ? "text-ambtx"
      : tone === "red"
        ? "text-redtx"
        : "text-faint";
}

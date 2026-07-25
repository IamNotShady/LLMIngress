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
  filterControlClass,
  RowActionButton,
  StatusDot,
} from "../controls";
import {
  formatCapabilities,
  formatCost,
  formatCount,
  formatPricePerMillion,
  formatRelative,
} from "../format";
import { DetailRow, SectionTitle } from "../layout";
import { formatModelContextTokens } from "../model-capability-format";
import { buildHref, readIntParam, readParam, type SearchParams } from "../params";
import { PlanQuotaPanel } from "../quota-panel";
import { formatRange, GridRow, Pagination } from "../table";
import {
  describeConnectionHealth,
  describeProviderHealth,
  type ProviderConnection,
  providerIsMetered,
} from "./model";

const CONNECTION_COLUMNS = "128px 214px 68px 226px 92px 1fr";
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
  const pageSize = readIntParam(params, "modelPageSize", 20);

  return (
    <div className="pl-6 pt-[18px]">
      <div className="flex items-center gap-3">
        <span className="font-sans text-19 font-semibold text-ink">{provider.displayName}</span>
        <span className="font-mono text-13 text-dim">{provider.providerType}</span>
        <span
          className={`flex items-center gap-[5px] font-mono text-125 font-medium ${healthTextClass(health.tone)}`}
        >
          <StatusDot tone={health.tone} />
          {health.text}
        </span>
        <div className="ml-auto flex gap-2">
          <form action="/api/provider-model-refresh" method="post">
            <input type="hidden" name="providerId" value={provider.id} />
            <ActionButton>Refresh models</ActionButton>
          </form>
          <ActionLink href={href({ dialog: "edit" })}>Edit</ActionLink>
          <ActionLink href={href({ dialog: provider.enabled ? "disable" : "enable" })}>
            {provider.enabled ? "Disable" : "Enable"}
          </ActionLink>
          <ActionLink href={href({ dialog: "delete" })} tone="danger">
            Delete
          </ActionLink>
        </div>
      </div>

      {refreshStatus?.failure ? (
        <div className="mt-[14px] flex items-start gap-[10px] rounded-sm border border-ambbd bg-ambbg px-[13px] py-[11px]">
          <span className="mt-[5px] size-[7px] flex-none rounded-full bg-red" />
          <div className="flex-1">
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
          <form action="/api/provider-model-refresh" method="post" className="flex-none">
            <input type="hidden" name="providerId" value={provider.id} />
            <ActionButton className="bg-bg">Retry now</ActionButton>
          </form>
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
            : "subscription plans are not metered — no cost is recorded"
        }
        trailing={
          <ActionLink href={href({ providerKeyDialog: provider.id, connection: "new" })}>
            {addConnectionLabel(provider)}
          </ActionLink>
        }
      >
        Connections
      </SectionTitle>
      <div className="mt-2">
        <GridRow columns={CONNECTION_COLUMNS} head>
          <span>LABEL</span>
          <span>CREDENTIAL</span>
          <span className="text-right">PRIORITY</span>
          <span>HEALTH</span>
          <span>STATUS</span>
          <span className="text-right">ACTIONS</span>
        </GridRow>
        {connections.length === 0 ? (
          <p className="py-6 text-center font-mono text-13 text-dim">
            No connection yet — add a credential so this provider can serve traffic.
          </p>
        ) : (
          connections.map((connection) => {
            const connectionHealth = describeConnectionHealth(connection);
            return (
              <GridRow key={connection.id} columns={CONNECTION_COLUMNS} className="py-2">
                <span className="font-medium cell-clip">{connection.label}</span>
                <span className="text-dim cell-clip">{connection.credential}</span>
                <span className="text-right tabnum">{connection.priority}</span>
                <span
                  className={`flex items-center gap-[6px] cell-clip ${healthTextClass(connectionHealth.tone)}`}
                >
                  <StatusDot tone={connectionHealth.tone} />
                  {connectionHealth.text}
                </span>
                <span className={connection.enabled ? "text-green" : "text-faint"}>
                  {connection.enabled ? "enabled" : "disabled"}
                </span>
                <span className="flex justify-end gap-[6px]">
                  <form action="/api/provider-health-probes" method="post">
                    <input type="hidden" name="providerId" value={provider.id} />
                    <input type="hidden" name="providerConnectionId" value={connection.id} />
                    <RowActionButton>Re-check</RowActionButton>
                  </form>
                  <ActionLink
                    className="px-2 py-[2px]"
                    href={href({ providerKeyDialog: provider.id, connection: connection.id })}
                  >
                    Edit
                  </ActionLink>
                  <ActionLink
                    className="px-2 py-[2px]"
                    href={href({ dialog: "deleteConnection", connection: connection.id })}
                    tone="danger"
                  >
                    Delete
                  </ActionLink>
                </span>
              </GridRow>
            );
          })
        )}
      </div>

      <PlanQuotaPanel now={now} summaries={quotas} />

      <div className="mt-5 flex items-center gap-[10px]">
        <span className="flex-none font-sans text-155 font-semibold text-ink">Models</span>
        <form method="get" action="/providers" className="flex items-center gap-2">
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
          <ActionButton className="px-2 py-1">Apply</ActionButton>
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
      <div className="mt-2">
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

function addConnectionLabel(provider: ConsoleProvider): string {
  if (provider.providerType === "subscription") {
    return "+ Authorize token";
  }
  return provider.providerType === "local" ? "+ Add endpoint" : "+ Add key";
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

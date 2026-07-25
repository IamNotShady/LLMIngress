import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import { listProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import { listConsoleProviderOAuthConnections } from "@llmingress/db/console-provider-oauth";
import { listConsoleProviderQuotaSummaries } from "@llmingress/db/console-provider-quota";
import { listProviderTemplateSelectorGroups } from "@llmingress/db/console-provider-templates";
import {
  listConsoleProviderModelRefreshStatuses,
  listProviders,
} from "@llmingress/db/console-providers";
import { listProviderModelPage } from "@llmingress/db/console-route-policies";
import { getConsoleUsageSummary } from "@llmingress/db/console-usage";
import { ActionLink } from "../../_ui/controls";
import { EmptyState, PageShell, PageTitleRow } from "../../_ui/layout";
import { buildHref, readIntParam, readParam, type SearchParams } from "../../_ui/params";
import { ProviderDetail } from "../../_ui/providers/detail";
import { ProviderDialogs } from "../../_ui/providers/dialogs";
import { buildProviderConnections, describeProviderHealth } from "../../_ui/providers/model";
import { PickRow } from "../../_ui/table";

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();

  const [providers, health, quotas, apiKeys, oauth, refreshStatuses, usage] = await Promise.all([
    listProviders(),
    listConsoleProviderHealthSummaries(),
    listConsoleProviderQuotaSummaries(),
    listProviderApiKeyMetadata(),
    listConsoleProviderOAuthConnections(),
    listConsoleProviderModelRefreshStatuses(),
    getConsoleUsageSummary({ now, window: "24h" }),
  ]);
  const templateGroups = listProviderTemplateSelectorGroups();

  const connectionsByProvider = new Map(
    providers.map((provider) => [
      provider.id,
      buildProviderConnections({ apiKeys, health, oauth, provider }),
    ]),
  );
  const connectionCount = [...connectionsByProvider.values()].reduce(
    (sum, rows) => sum + rows.length,
    0,
  );

  const requestedId = readParam(params, "selected");
  const selected = providers.find((provider) => provider.id === requestedId) ?? providers[0];
  const selectedConnections = selected ? (connectionsByProvider.get(selected.id) ?? []) : [];

  const modelQuery = readParam(params, "modelQuery") ?? "";
  const availability = readParam(params, "availability") ?? "available";
  const modelPage = selected
    ? await listProviderModelPage({
        availability,
        page: readIntParam(params, "modelPage", 1),
        pageSize: readIntParam(params, "modelPageSize", 20),
        providerId: selected.id,
        query: modelQuery || null,
      })
    : null;

  return (
    <PageShell label="Providers">
      <PageTitleRow
        title="Providers"
        meta={
          providers.length > 0
            ? `${providers.length} providers · ${connectionCount} connections`
            : undefined
        }
        actions={
          <ActionLink
            id="provider-create-dialog-trigger"
            href={buildHref("/providers", params, { dialog: "new" })}
            tone="primary"
          >
            + Add Provider
          </ActionLink>
        }
      />

      {providers.length === 0 ? (
        <EmptyState
          title="No providers yet"
          body="A provider is where requests actually go — an API key vendor, a subscription plan you already pay for, or a model server on your own machine. Add one and LLMIngress probes it and lists its models for you."
          actions={
            <ActionLink href={buildHref("/providers", params, { dialog: "new" })} tone="primary">
              + Add Provider
            </ActionLink>
          }
        />
      ) : (
        <div className="mt-4 grid grid-cols-[344px_minmax(0,1fr)] border-t border-hair overflow-x-auto">
          <div className="border-r border-rule pr-5">
            {providers.map((provider) => {
              const connections = connectionsByProvider.get(provider.id) ?? [];
              const providerHealth = describeProviderHealth(connections);
              return (
                <PickRow
                  key={provider.id}
                  href={buildHref("/providers", params, {
                    availability: null,
                    modelPage: null,
                    modelQuery: null,
                    selected: provider.id,
                  })}
                  selected={provider.id === selected?.id}
                >
                  <span
                    className={`size-[7px] flex-none rounded-full ${dotClass(providerHealth.tone)}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-14 font-medium text-ink cell-clip">
                      {provider.displayName}
                    </span>
                    <span className="mt-px block font-mono text-12 text-faint cell-clip">
                      {provider.providerType} · {connections.length} connections
                    </span>
                  </span>
                  <span className="flex-none font-mono text-12 text-faint">
                    {provider.providerModelCount}
                  </span>
                </PickRow>
              );
            })}
            <p className="px-2 py-[10px] font-mono text-12 leading-[1.6] text-faint">
              Health belongs to a connection — each key or token is probed on its own.
            </p>
          </div>

          {selected ? (
            <ProviderDetail
              connections={selectedConnections}
              modelPage={modelPage}
              now={now}
              params={params}
              provider={selected}
              quotas={quotas.filter((quota) => quota.providerId === selected.id)}
              refreshStatus={
                refreshStatuses.find((status) => status.providerId === selected.id) ?? null
              }
              usage={usage}
            />
          ) : null}
        </div>
      )}

      <ProviderDialogs
        connections={selectedConnections}
        params={params}
        quotas={selected ? quotas.filter((quota) => quota.providerId === selected.id) : []}
        provider={selected}
        templateGroups={templateGroups}
        usage={usage}
      />
    </PageShell>
  );
}

function dotClass(tone: "amber" | "dim" | "green" | "red"): string {
  return tone === "green"
    ? "bg-green"
    : tone === "amber"
      ? "bg-amber"
      : tone === "red"
        ? "bg-red"
        : "bg-dim";
}

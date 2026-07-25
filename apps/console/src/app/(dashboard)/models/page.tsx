import { listConsoleActivities } from "@llmingress/db/console-activity";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import { listProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import { listConsoleProviderOAuthConnections } from "@llmingress/db/console-provider-oauth";
import { listProviders } from "@llmingress/db/console-providers";
import {
  listProviderModelPage,
  listRoutePolicies,
  routePolicyStrategies,
} from "@llmingress/db/console-route-policies";
import {
  getConsoleUsageSummary,
  listConsoleVirtualModelCandidateTraffic,
} from "@llmingress/db/console-usage";
import {
  listConsoleApiKeyVirtualModelGrants,
  listVirtualModels,
} from "@llmingress/db/console-virtual-models";
import { ActionLink, filterControlClass } from "../../_ui/controls";
import { formatCount } from "../../_ui/format";
import { EmptyState, PageShell, PageTitleRow } from "../../_ui/layout";
import { buildHref, readIntParam, readParam, type SearchParams } from "../../_ui/params";
import { PickRow } from "../../_ui/table";
import { VirtualModelDetail } from "../../_ui/virtual-models/detail";
import { VirtualModelDialogs } from "../../_ui/virtual-models/dialogs";
import { RETRY_NOTE } from "../../_ui/virtual-models/strategy";

export default async function VirtualModelsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();

  const [virtualModels, routePolicies, grants, usage, providers, health, providerApiKeys, oauth] =
    await Promise.all([
      listVirtualModels(),
      listRoutePolicies(),
      listConsoleApiKeyVirtualModelGrants(),
      getConsoleUsageSummary({ now, window: "24h" }),
      listProviders(),
      listConsoleProviderHealthSummaries(),
      listProviderApiKeyMetadata(),
      listConsoleProviderOAuthConnections(),
    ]);

  const policyByVirtualModelId = new Map(
    routePolicies.map((policy) => [policy.virtualModelId, policy]),
  );

  const strategyFilter = readParam(params, "strategy") ?? "all";
  const visible = virtualModels.filter((model) => {
    if (strategyFilter === "all") {
      return true;
    }
    return policyByVirtualModelId.get(model.id)?.strategy === strategyFilter;
  });

  const requestedId = readParam(params, "selected");
  const selected = visible.find((model) => model.id === requestedId) ?? visible[0];
  const selectedPolicy = selected ? (policyByVirtualModelId.get(selected.id) ?? null) : null;

  const [candidateTraffic, recentFailures] = selected
    ? await Promise.all([
        listConsoleVirtualModelCandidateTraffic({
          now,
          virtualModelId: selected.id,
          window: "24h",
        }),
        listConsoleActivities({
          filters: { status: "failed", virtualModelId: selected.id },
          limit: 5,
        }),
      ])
    : [[], []];

  // The candidate browser inside the editor pages one provider at a time.
  const editorProviderId = readParam(params, "candidateProvider") ?? providers[0]?.id;
  const candidatePage =
    readParam(params, "dialog") && editorProviderId
      ? await listProviderModelPage({
          availability: readParam(params, "candidateAvailability") ?? "available",
          page: readIntParam(params, "candidatePage", 1),
          pageSize: 8,
          providerId: editorProviderId,
          query: readParam(params, "candidateQuery") ?? null,
        })
      : null;

  return (
    <PageShell label="Virtual Models">
      <PageTitleRow
        title="Virtual Models"
        meta={
          virtualModels.length > 0
            ? `${virtualModels.length} models · one stable name per route`
            : undefined
        }
        actions={
          <ActionLink href={buildHref("/models", params, { dialog: "new" })} tone="primary">
            + New Virtual Model
          </ActionLink>
        }
      />

      {virtualModels.length === 0 ? (
        <EmptyState
          title="No virtual models yet"
          body='A virtual model is the stable name your agents send as "model". It owns the endpoint protocol and an ordered list of provider models to route to, so you can swap providers without touching any agent config.'
          actions={
            <>
              <ActionLink href={buildHref("/models", params, { dialog: "new" })} tone="primary">
                + New Virtual Model
              </ActionLink>
              <ActionLink href="/providers">Connect a provider first</ActionLink>
            </>
          }
        />
      ) : (
        <div className="mt-4 grid grid-cols-[344px_minmax(0,1fr)] border-t border-hair overflow-x-auto">
          <div className="border-r border-rule pr-5">
            <form method="get" action="/models" className="flex items-center gap-2 py-2 pb-[10px]">
              <select
                name="strategy"
                defaultValue={strategyFilter}
                aria-label="Filter by strategy"
                className={`${filterControlClass} flex-1`}
              >
                <option value="all">Strategy: all</option>
                {routePolicyStrategies.map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {strategy}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="flex-none whitespace-nowrap rounded-xs border border-btnbd bg-btnbg px-2 py-1 font-mono text-12 text-ink"
              >
                Apply
              </button>
              <span className="flex-none whitespace-nowrap font-mono text-12 text-faint">
                {formatCount(visible.length)} of {formatCount(virtualModels.length)}
              </span>
            </form>

            {visible.length === 0 ? (
              <p className="px-2 py-6 font-mono text-13 leading-[1.6] text-dim">
                No virtual model uses this strategy.
              </p>
            ) : (
              visible.map((model) => {
                const policy = policyByVirtualModelId.get(model.id);
                return (
                  <PickRow
                    key={model.id}
                    href={buildHref("/models", params, { selected: model.id })}
                    selected={model.id === selected?.id}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-14 font-medium text-ink cell-clip">
                        {model.name}
                      </span>
                      <span className="mt-px block font-mono text-12 text-faint cell-clip">
                        {policy
                          ? `${policy.endpointProtocol ?? "no protocol"} · ${policy.strategy}`
                          : "no route yet"}
                      </span>
                    </span>
                    <span className="flex-none font-mono text-12 text-faint tabnum">
                      {formatCount(model.requestCount24h)}
                    </span>
                  </PickRow>
                );
              })
            )}
            <p className="px-2 py-[10px] font-mono text-12 leading-[1.6] text-faint">
              {RETRY_NOTE}
            </p>
          </div>

          {selected ? (
            <VirtualModelDetail
              candidateTraffic={candidateTraffic}
              grants={grants.filter((grant) => grant.virtualModelId === selected.id)}
              health={health}
              now={now}
              oauth={oauth}
              params={params}
              policy={selectedPolicy}
              providerApiKeys={providerApiKeys}
              providers={providers}
              recentFailures={recentFailures}
              usage={usage}
              virtualModel={selected}
            />
          ) : null}
        </div>
      )}

      <VirtualModelDialogs
        candidatePage={candidatePage}
        grants={grants}
        params={params}
        policy={selectedPolicy}
        providers={providers}
        usage={usage}
        virtualModel={selected}
      />
    </PageShell>
  );
}

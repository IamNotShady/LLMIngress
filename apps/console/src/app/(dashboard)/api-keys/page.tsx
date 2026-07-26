import { gatewayPublicBaseUrl } from "@llmingress/config";
import {
  listConsoleCurrentBudgetPeriods,
  listSavedApiKeyLimits,
} from "@llmingress/db/console-api-key-limits";
import { listApiKeys } from "@llmingress/db/console-api-keys";
import { listRoutePolicies } from "@llmingress/db/console-route-policies";
import { getConsoleUsageSummary } from "@llmingress/db/console-usage";
import {
  listConsoleApiKeyVirtualModelGrants,
  listVirtualModels,
} from "@llmingress/db/console-virtual-models";
import { ApiKeyDetail } from "../../_ui/api-keys/detail";
import { ApiKeyDialogs } from "../../_ui/api-keys/dialogs";
import { ActionLink, FilterButton, filterControlClass } from "../../_ui/controls";
import { formatCount } from "../../_ui/format";
import { EmptyState, PageShell, PageTitleRow } from "../../_ui/layout";
import { buildHref, readParam, type SearchParams } from "../../_ui/params";
import { PickRow } from "../../_ui/table";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();

  const [apiKeys, grants, limits, budgetPeriods, usage, routePolicies, virtualModels] =
    await Promise.all([
      listApiKeys(),
      listConsoleApiKeyVirtualModelGrants(),
      listSavedApiKeyLimits(),
      listConsoleCurrentBudgetPeriods({ now }),
      getConsoleUsageSummary({ now, window: "24h" }),
      listRoutePolicies(),
      listVirtualModels(),
    ]);

  const query = (readParam(params, "q") ?? "").trim().toLowerCase();
  const visible = query ? apiKeys.filter((key) => key.name.toLowerCase().includes(query)) : apiKeys;

  const requestedId = readParam(params, "selected");
  const selected = visible.find((key) => key.id === requestedId) ?? visible[0];

  return (
    <PageShell label="API Keys">
      <PageTitleRow
        title="API Keys"
        meta={apiKeys.length > 0 ? `${apiKeys.length} keys · one secret per agent` : undefined}
        actions={
          <ActionLink
            id="api-key-create-dialog-trigger"
            href={buildHref("/api-keys", params, { dialog: "new" })}
            tone="primary"
          >
            + New API Key
          </ActionLink>
        }
      />

      {apiKeys.length === 0 ? (
        <EmptyState
          title="No API keys yet"
          body="Issue one llmi_ secret per agent or tool, granting only the virtual models it should reach. The secret is shown once at creation, together with the setup snippet for Codex, Claude Code, Cursor and the rest."
          actions={
            <ActionLink href={buildHref("/api-keys", params, { dialog: "new" })} tone="primary">
              + New API Key
            </ActionLink>
          }
        />
      ) : (
        <div className="mt-4 grid grid-cols-[384px_minmax(0,1fr)] border-t border-hair overflow-x-auto">
          <div className="border-r border-rule pr-5">
            <form
              method="get"
              action="/api-keys"
              className="flex items-center gap-2 py-2 pb-[10px]"
            >
              <input
                name="q"
                defaultValue={readParam(params, "q") ?? ""}
                placeholder="filter by name…"
                aria-label="Filter API keys by name"
                className={`${filterControlClass} min-w-0 flex-1`}
              />
              <FilterButton>Apply</FilterButton>
              <span className="flex-none whitespace-nowrap font-mono text-125 text-faint">
                {formatCount(visible.length)} of {formatCount(apiKeys.length)}
              </span>
            </form>

            {visible.length === 0 ? (
              <p className="px-2 py-6 font-mono text-13 leading-[1.6] text-dim">
                No API key matches that name.
              </p>
            ) : (
              visible.map((key) => {
                const keyUsage = usage.apiKeyBreakdowns.find((entry) => entry.id === key.id);
                return (
                  <PickRow
                    key={key.id}
                    href={buildHref("/api-keys", params, { selected: key.id })}
                    selected={key.id === selected?.id}
                  >
                    <span
                      className={`size-[7px] flex-none rounded-full ${
                        key.enabled ? "bg-green" : "bg-faint"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block font-mono text-14 font-medium cell-clip ${
                          key.enabled ? "text-ink" : "text-dim"
                        }`}
                      >
                        {key.name}
                      </span>
                      <span className="mt-px block font-mono text-12 text-faint cell-clip">
                        {key.keyPrefix}
                      </span>
                    </span>
                    <span className="flex-none font-mono text-125 text-faint tabnum">
                      {formatCount(keyUsage?.requestCount ?? 0)}
                    </span>
                  </PickRow>
                );
              })
            )}
          </div>

          {selected ? (
            <ApiKeyDetail
              apiKey={selected}
              gatewayBaseUrl={gatewayPublicBaseUrl()}
              grants={grants.filter((grant) => grant.apiKeyId === selected.id)}
              limits={limits.filter((limit) => limit.apiKeyId === selected.id)}
              budgetPeriod={budgetPeriods.find((period) => period.apiKeyId === selected.id)}
              now={now}
              params={params}
              routePolicies={routePolicies}
              usage={usage}
            />
          ) : null}
        </div>
      )}

      <ApiKeyDialogs
        apiKey={selected}
        grants={grants}
        limits={limits.filter((limit) => limit.apiKeyId === selected?.id)}
        params={params}
        usage={usage}
        virtualModels={virtualModels}
        routePolicies={routePolicies}
      />
    </PageShell>
  );
}

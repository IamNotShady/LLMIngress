import {
  listConsoleCurrentBudgetPeriods,
  listSavedApiKeyLimits,
} from "@llmingress/db/console-api-key-limits";
import { listApiKeys } from "@llmingress/db/console-api-keys";
import { buildApiKeyLimitsView, formatLimitValue } from "../../_ui/api-keys/limits-view";
import { filterControlClass, Meter } from "../../_ui/controls";
import { formatCost, formatCount } from "../../_ui/format";
import { EmptyState, PageShell, PageTitleRow } from "../../_ui/layout";
import { LimitsDrawer } from "../../_ui/limits/drawer";
import { buildHref, readParam, type SearchParams } from "../../_ui/params";
import { GridRow } from "../../_ui/table";

const COLUMNS = "172px 104px 170px 190px 80px 92px 104px 80px 1fr";

export default async function LimitsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();

  const [apiKeys, limits, budgetPeriods] = await Promise.all([
    listApiKeys(),
    listSavedApiKeyLimits(),
    listConsoleCurrentBudgetPeriods({ now }),
  ]);

  const rows = apiKeys.map((apiKey) => ({
    apiKey,
    view: buildApiKeyLimitsView({
      budgetPeriod: budgetPeriods.find((period) => period.apiKeyId === apiKey.id),
      limits: limits.filter((limit) => limit.apiKeyId === apiKey.id),
      limitsEnabled: apiKey.limitsEnabled,
    }),
  }));

  const query = (readParam(params, "q") ?? "").trim().toLowerCase();
  const stateFilter = readParam(params, "state") ?? "all";
  const visible = rows.filter((row) => {
    if (query && !row.apiKey.name.toLowerCase().includes(query)) {
      return false;
    }
    if (stateFilter === "on") {
      return row.view.state === "enabled";
    }
    if (stateFilter === "off") {
      return row.view.state !== "enabled";
    }
    return true;
  });

  const selectedId = readParam(params, "selected");
  const selectedRow = rows.find((row) => row.apiKey.id === selectedId);

  return (
    <PageShell label="Limits">
      <PageTitleRow
        title="Limits"
        meta="per-key budget, rate, token and concurrency rules · disabling Limits preserves rules and skips enforcement"
      />

      {apiKeys.length === 0 ? (
        <EmptyState
          title="No keys to limit yet"
          body="Limits are per API key: a budget with its period, request and token ceilings, and a concurrency cap. Issue a key first, then set its rules here — enforcement can be block or warn_only."
        />
      ) : (
        <>
          <form
            method="get"
            action="/limits"
            className="mt-[14px] flex items-center gap-2 overflow-x-auto"
          >
            <input
              name="q"
              defaultValue={readParam(params, "q") ?? ""}
              placeholder="filter by API key name…"
              aria-label="Filter by API key name"
              className={`${filterControlClass} w-[260px]`}
            />
            <select
              name="state"
              defaultValue={stateFilter}
              aria-label="Filter by limit state"
              className={filterControlClass}
            >
              <option value="all">Limits: all</option>
              <option value="on">enabled</option>
              <option value="off">disabled or none</option>
            </select>
            <button
              type="submit"
              className="whitespace-nowrap rounded-xs border border-btnbd bg-btnbg px-2 py-1 font-mono text-12 text-ink"
            >
              Apply
            </button>
            <span className="whitespace-nowrap font-mono text-125 text-faint">
              {formatCount(visible.length)} of {formatCount(rows.length)}
            </span>
          </form>

          <div className="mt-[10px] overflow-x-auto">
            <GridRow columns={COLUMNS} head className="border-t border-hair">
              <span>API KEY</span>
              <span>LIMITS</span>
              <span>BUDGET</span>
              <span>SPENT</span>
              <span className="text-right">RPM</span>
              <span className="text-right">TPM</span>
              <span className="text-right">TOK/REQ</span>
              <span className="text-right">CONC</span>
              <span className="text-right">ACTIONS</span>
            </GridRow>
            {visible.length === 0 ? (
              <p className="py-8 text-center font-mono text-13 leading-[1.6] text-dim">
                No API key matches this name and limit state.
              </p>
            ) : (
              visible.map(({ apiKey, view }) => {
                const unset = view.state === "none" ? "text-faint" : "text-ink";
                return (
                  <GridRow
                    key={apiKey.id}
                    columns={COLUMNS}
                    className="py-[9px] text-135"
                    href={buildHref("/limits", params, { selected: apiKey.id })}
                    selected={apiKey.id === selectedId}
                  >
                    <span className="font-medium cell-clip">{apiKey.name}</span>
                    <span
                      className={
                        view.state === "enabled"
                          ? view.enforcement === "warn_only"
                            ? "text-ambtx"
                            : "text-green"
                          : "text-faint"
                      }
                    >
                      {view.label}
                    </span>
                    <span className={view.budgetLimit === null ? "text-faint" : "text-ink"}>
                      {view.budgetLimit === null
                        ? "no rules"
                        : `${formatCost(view.budgetLimit)} ${view.budgetPeriod}`}
                    </span>
                    <span className="flex items-center gap-2">
                      <Meter
                        className="flex-1"
                        fillClassName={(view.spentRatio ?? 0) >= 0.8 ? "bg-amber" : "bg-green"}
                        height={6}
                        ratio={view.spentRatio ?? 0}
                      />
                      <span className={`${unset} whitespace-nowrap tabnum`}>
                        {view.state === "none" ? "—" : formatCost(view.spentUsd)}
                      </span>
                    </span>
                    <span className={`text-right tabnum ${unset}`}>
                      {formatLimitValue(view.rpm)}
                    </span>
                    <span className={`text-right tabnum ${unset}`}>
                      {formatLimitValue(view.tpm)}
                    </span>
                    <span className={`text-right tabnum ${unset}`}>
                      {formatLimitValue(view.tokensPerRequest)}
                    </span>
                    <span className={`text-right tabnum ${unset}`}>
                      {formatLimitValue(view.concurrency)}
                    </span>
                    <span className="text-right text-dim">Edit ▸</span>
                  </GridRow>
                );
              })
            )}
          </div>
        </>
      )}

      {selectedRow ? (
        <LimitsDrawer
          apiKey={selectedRow.apiKey}
          budgetPeriod={budgetPeriods.find((period) => period.apiKeyId === selectedRow.apiKey.id)}
          params={params}
          view={selectedRow.view}
        />
      ) : null}
    </PageShell>
  );
}

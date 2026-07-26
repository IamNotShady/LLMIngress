import type {
  ConsoleApiKeyLimit,
  ConsoleBudgetPeriod,
} from "@llmingress/db/console-api-key-limits";
import type { ConsoleApiKey } from "@llmingress/db/console-api-keys";
import type { ConsoleRoutePolicy } from "@llmingress/db/console-route-policies";
import type { ConsoleUsageSummary } from "@llmingress/db/console-usage";
import type { ConsoleApiKeyVirtualModelGrant } from "@llmingress/db/console-virtual-models";
import Link from "next/link";
import { ActionLink, Meter, StatusDot } from "../controls";
import { formatCompact, formatCost, formatCount, formatDateOnly, formatRelative } from "../format";
import { DetailRow, SectionTitle } from "../layout";
import { buildHref, type SearchParams } from "../params";
import { GridRow } from "../table";
import { buildApiKeyLimitsView, formatLimitValue } from "./limits-view";

const GRANT_COLUMNS = "190px 170px 136px 114px 1fr";

export function ApiKeyDetail({
  apiKey,
  budgetPeriod,
  gatewayBaseUrl,
  grants,
  limits,
  now,
  params,
  routePolicies,
  usage,
}: {
  apiKey: ConsoleApiKey;
  budgetPeriod: ConsoleBudgetPeriod | undefined;
  gatewayBaseUrl: string;
  grants: ConsoleApiKeyVirtualModelGrant[];
  limits: ConsoleApiKeyLimit[];
  now: Date;
  params: SearchParams;
  routePolicies: ConsoleRoutePolicy[];
  usage: ConsoleUsageSummary;
}) {
  const href = (changes: Record<string, string | null>) => buildHref("/api-keys", params, changes);
  const breakdown = usage.apiKeyBreakdowns.find((entry) => entry.id === apiKey.id);
  const view = buildApiKeyLimitsView({
    budgetPeriod,
    limits,
    limitsEnabled: apiKey.limitsEnabled,
  });
  const policyByVirtualModelId = new Map(
    routePolicies.map((policy) => [policy.virtualModelId, policy]),
  );
  return (
    <div className="min-w-0 pl-6 pt-[18px]">
      <div className="flex items-center gap-3">
        <h2 className="m-0 font-sans text-19 font-semibold text-ink">{apiKey.name}</h2>
        <span className="font-mono text-13 text-dim">{apiKey.keyPrefix}</span>
        <span
          className={`flex items-center gap-[5px] font-mono text-125 font-medium ${
            apiKey.enabled ? "text-green" : "text-faint"
          }`}
        >
          <StatusDot tone={apiKey.enabled ? "green" : "dim"} />
          {apiKey.enabled ? "enabled" : "disabled"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ActionLink href={href({ dialog: "edit" })}>Edit</ActionLink>
          <ActionLink href={href({ dialog: "guide" })}>Set up an agent</ActionLink>
          <ActionLink href="/playground">Test in Playground</ActionLink>
          <ActionLink href={href({ dialog: apiKey.enabled ? "disable" : "enable" })}>
            {apiKey.enabled ? "Disable" : "Enable"}
          </ActionLink>
          <ActionLink href={href({ dialog: "delete" })} tone="danger">
            Delete
          </ActionLink>
        </div>
      </div>

      <div className="mt-2 flex gap-7 font-mono text-13 text-dim">
        <span>created {formatDateOnly(apiKey.createdAt)}</span>
        <span>last used {formatRelative(apiKey.lastUsedAt, now)}</span>
        <span className="cell-clip">
          integration: OpenAI-compatible base {gatewayBaseUrl.replace(/\/+$/, "")}/v1
        </span>
      </div>

      <SectionTitle className="mt-5">Virtual Model access</SectionTitle>
      <div className="mt-2 border-t border-hair">
        {grants.length === 0 ? (
          <p className="py-4 font-mono text-13 text-dim">
            This key grants no virtual model, so every request it sends is rejected.
          </p>
        ) : (
          grants.map((grant) => {
            const policy = policyByVirtualModelId.get(grant.virtualModelId);
            const virtualModelUsage = usage.virtualModelBreakdowns.find(
              (entry) => entry.id === grant.virtualModelId,
            );
            return (
              <GridRow key={grant.virtualModelId} columns={GRANT_COLUMNS} className="py-2">
                <span className="font-medium cell-clip">
                  {policy?.virtualModelName ?? "unknown model"}{" "}
                  {grant.isDefault ? <span className="text-ambtx">★ default</span> : null}
                </span>
                <span className="text-dim cell-clip">{policy?.endpointProtocol ?? "—"}</span>
                <span className="text-dim cell-clip">{policy?.strategy ?? "—"}</span>
                <span className="text-right tabnum">
                  {formatCount(virtualModelUsage?.requestCount ?? 0)} reqs
                </span>
                <span className="text-right text-dim">granted</span>
              </GridRow>
            );
          })
        )}
        <div className="py-2">
          <ActionLink href={href({ dialog: "edit" })} size="row">
            Edit access
          </ActionLink>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-6">
        <div>
          <SectionTitle
            note={view.label}
            trailing={
              <Link href="/limits" className="font-mono text-13 text-dim">
                edit → Limits
              </Link>
            }
          >
            Limits
          </SectionTitle>
          <div className="mt-2 border-t border-hair">
            {view.state === "none" ? (
              <p className="py-3 font-mono text-13 leading-[1.6] text-dim">
                No rules — this key runs unlimited. Set a budget and rate ceiling in Limits before
                handing it over.
              </p>
            ) : (
              <>
                <div className="border-b border-rule2 py-[9px]">
                  <div className="flex justify-between font-mono text-13 text-ink">
                    <span>budget · {view.budgetPeriod ?? "no period"}</span>
                    <span>
                      <span
                        className={`font-medium ${
                          (view.spentRatio ?? 0) >= 0.8 ? "text-ambtx" : "text-ink"
                        }`}
                      >
                        {formatCost(view.spentUsd)}
                      </span>{" "}
                      / {view.budgetLimit === null ? "unlimited" : formatCost(view.budgetLimit)}
                    </span>
                  </div>
                  <Meter
                    className="mt-[5px]"
                    fillClassName={(view.spentRatio ?? 0) >= 0.8 ? "bg-amber" : "bg-green"}
                    ratio={view.spentRatio ?? 0}
                  />
                  {view.state === "disabled" ? (
                    <p className="mt-1 font-mono text-12 text-faint">
                      Limits are off — the rules are kept but nothing is enforced.
                    </p>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <DetailRow label="rpm" value={formatLimitValue(view.rpm)} />
                  <DetailRow label="tpm" value={formatLimitValue(view.tpm)} />
                  <DetailRow
                    label="tokens / request"
                    value={formatLimitValue(view.tokensPerRequest)}
                  />
                  <DetailRow label="concurrency" value={formatLimitValue(view.concurrency)} />
                </div>
              </>
            )}
          </div>
        </div>

        <div>
          <SectionTitle
            trailing={
              <Link href="/activity" className="font-mono text-13 text-dim">
                → Activity
              </Link>
            }
          >
            Usage · 24h
          </SectionTitle>
          <div className="mt-2 border-t border-hair">
            <DetailRow label="requests" value={formatCount(breakdown?.requestCount ?? 0)} />
            <DetailRow label="tokens" value={formatCompact(breakdown?.totalTokens ?? 0)} />
            <DetailRow label="cost" value={formatCost(breakdown?.totalCostUsd ?? null)} />
            <DetailRow
              label="failures"
              value={formatCount(breakdown?.failureCount ?? 0)}
              valueClassName="text-redtx"
            />
          </div>
          <p className="mt-[10px] font-mono text-125 leading-[1.6] text-faint">
            The llmi_ secret is shown once at creation and stored hashed. Disabling preserves
            configuration; deleting is permanent.
          </p>
        </div>
      </div>
    </div>
  );
}

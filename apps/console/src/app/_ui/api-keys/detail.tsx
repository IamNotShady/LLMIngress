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
import { IntegrationPanel } from "./integration-panel";
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
  const grantName = (grant: ConsoleApiKeyVirtualModelGrant) =>
    policyByVirtualModelId.get(grant.virtualModelId)?.virtualModelName ?? "unknown model";
  const defaultModelName = grants.find((grant) => grant.isDefault)
    ? grantName(grants.find((grant) => grant.isDefault) as ConsoleApiKeyVirtualModelGrant)
    : null;
  const otherModelNames = grants.filter((grant) => !grant.isDefault).map(grantName);

  return (
    <div className="min-w-0 pl-6 pt-[18px]">
      <div className="flex items-center gap-3">
        <span className="font-sans text-19 font-semibold text-ink">{apiKey.name}</span>
        <span className="font-mono text-13 text-dim">{apiKey.keyPrefix}</span>
        <span
          className={`flex items-center gap-[5px] font-mono text-125 font-medium ${
            apiKey.enabled ? "text-green" : "text-faint"
          }`}
        >
          <StatusDot tone={apiKey.enabled ? "green" : "dim"} />
          {apiKey.enabled ? "enabled" : "disabled"}
        </span>
        <div className="ml-auto flex gap-2">
          <ActionLink href={href({ dialog: "edit" })}>Edit</ActionLink>
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
          <ActionLink className="px-[10px] py-[3px]" href={href({ dialog: "edit" })}>
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

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_300px] items-start gap-6 overflow-x-auto">
        <div>
          <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">
            SECRET · STORED HASHED
          </div>
          <div className="mt-[6px] flex items-center gap-[10px] rounded-xs border border-rule bg-track px-[14px] py-3">
            <span className="min-w-0 flex-1 break-all font-mono text-15 font-medium text-ink">
              {apiKey.keyPrefix}
            </span>
          </div>
          <p className="mt-[6px] font-mono text-125 text-faint">
            Only the prefix is kept. To rotate, delete this key and issue a new one.
          </p>
        </div>
        <div>
          <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">
            CONFIGURATION
          </div>
          <div className="mt-[6px] border-t border-hair">
            <DetailRow clip label="gateway" value={gatewayBaseUrl.replace(/\/+$/, "")} />
            <DetailRow
              clip
              label="default model"
              value={defaultModelName ?? "none — clients must send a model"}
            />
            <DetailRow
              clip
              label="also granted"
              value={otherModelNames.length > 0 ? otherModelNames.join(", ") : "—"}
            />
            <DetailRow label="limits" value={view.label} />
          </div>
        </div>
      </div>

      <IntegrationPanel
        gatewayBaseUrl={gatewayBaseUrl}
        model={defaultModelName ?? otherModelNames[0] ?? "your-virtual-model"}
        params={params}
        pathname="/api-keys"
      />
    </div>
  );
}

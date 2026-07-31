import type { ConsoleActivity } from "@llmingress/db/console-activity";
import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ConsoleRoutePolicy } from "@llmingress/db/console-route-policies";
import type {
  ConsoleUsageSummary,
  ConsoleVirtualModelCandidateTraffic,
} from "@llmingress/db/console-usage";
import type {
  ConsoleApiKeyVirtualModelGrant,
  ConsoleVirtualModel,
} from "@llmingress/db/console-virtual-models";
import type { ProviderOAuthMetadata } from "@llmingress/db/providers";
import Link from "next/link";
import { ActionLink, Meter, StatusDot } from "../controls";
import { activityHref } from "../cross-links";
import {
  formatCapabilities,
  formatClock,
  formatCost,
  formatCount,
  formatPricePair,
} from "../format";
import { DetailRow, SectionTitle } from "../layout";
import { formatModelContextTokens } from "../model-capability-format";
import { buildHref, type SearchParams } from "../params";
import {
  buildProviderConnections,
  describeProviderHealth,
  providerIsMetered,
} from "../providers/model";
import { GridRow } from "../table";
import { strategyRouteNote } from "./strategy";

const ROUTE_COLUMNS = "26px 252px 150px 156px 78px 140px 1fr";
/** A tag route is read by tag first, so the tags sit right after the candidate.
    The extra TAGS column is paid for by HEALTH (a dot and one word) and a wider
    PRICE, so "$21.00 / $168.00 per M" renders unclipped. */
const TAG_ROUTE_COLUMNS = "26px 252px 120px 176px 96px 78px 140px 1fr";
const KEY_COLUMNS = "148px 104px 1fr";
const FAILURE_COLUMNS = "64px 1fr 126px";

export function VirtualModelDetail({
  candidateTraffic,
  grants,
  health,
  now,
  oauth,
  params,
  policy,
  providerApiKeys,
  providers,
  recentFailures,
  usage,
  virtualModel,
}: {
  candidateTraffic: ConsoleVirtualModelCandidateTraffic[];
  grants: ConsoleApiKeyVirtualModelGrant[];
  health: ConsoleProviderHealthSummary[];
  now: Date;
  oauth: ProviderOAuthMetadata[];
  params: SearchParams;
  policy: ConsoleRoutePolicy | null;
  providerApiKeys: ProviderApiKeyMetadata[];
  providers: ConsoleProvider[];
  recentFailures: ConsoleActivity[];
  usage: ConsoleUsageSummary;
  virtualModel: ConsoleVirtualModel;
}) {
  const breakdown = usage.virtualModelBreakdowns.find((entry) => entry.id === virtualModel.id);
  const trafficByModelId = new Map(candidateTraffic.map((entry) => [entry.providerModelId, entry]));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const healthByProviderId = new Map(
    providers.map((provider) => [
      provider.id,
      describeProviderHealth(
        buildProviderConnections({ apiKeys: providerApiKeys, health, oauth, provider }),
      ),
    ]),
  );
  const href = (changes: Record<string, string | null>) => buildHref("/models", params, changes);
  const routesByTag = policy?.strategy === "tag";
  const routeColumns = routesByTag ? TAG_ROUTE_COLUMNS : ROUTE_COLUMNS;

  return (
    <div className="min-w-0 pl-6 pt-[18px]">
      <div className="flex items-center gap-3">
        <h2 className="m-0 font-sans text-19 font-semibold text-ink">{virtualModel.name}</h2>
        <span className="font-mono text-13 text-dim cell-clip">{virtualModel.description}</span>
        <div className="ml-auto flex items-center gap-2">
          <ActionLink href={href({ dialog: "edit" })}>Edit route</ActionLink>
          <ActionLink href={href({ dialog: "delete" })} tone="danger">
            Delete
          </ActionLink>
        </div>
      </div>

      <div className="mt-[14px] grid grid-cols-3 gap-x-6 border-t border-hair">
        <DetailRow label="protocol" value={policy?.endpointProtocol ?? "no route yet"} />
        <DetailRow label="strategy" value={policy?.strategy ?? "—"} />
        <DetailRow label="candidates" value={formatCount(policy?.candidates.length ?? 0)} />
        <DetailRow label="requests 24h" value={formatCount(virtualModel.requestCount24h)} />
        <DetailRow
          label="failures"
          value={formatCount(breakdown?.failureCount ?? 0)}
          valueClassName="text-redtx"
        />
        <DetailRow label="cost 24h" value={formatCost(virtualModel.cost24hUsd)} />
      </div>

      <SectionTitle className="mt-5" note={policy ? strategyRouteNote[policy.strategy] : undefined}>
        Route
      </SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={routeColumns} head>
          <span>#</span>
          <span>CANDIDATE</span>
          {routesByTag ? <span>TAGS</span> : null}
          <span>PRICE</span>
          <span>HEALTH</span>
          <span className="text-right">CTX</span>
          <span>CAPABILITIES</span>
          <span className="text-right">TRAFFIC 24H</span>
        </GridRow>
        {policy && policy.candidates.length > 0 ? (
          policy.candidates.map((candidate) => {
            const provider = providerById.get(candidate.providerId);
            const candidateHealth = healthByProviderId.get(candidate.providerId);
            const traffic = trafficByModelId.get(candidate.id);
            const metered = provider ? providerIsMetered(provider) : true;
            return (
              <GridRow key={candidate.id} columns={routeColumns} className="py-2">
                <span className="text-faint tabnum">{candidate.candidateOrder}</span>
                <span className="font-medium cell-clip">
                  {candidate.providerDisplayName} · {candidate.modelId}
                </span>
                {routesByTag ? (
                  <span
                    className={`cell-clip ${
                      candidate.tags.includes("default") ? "text-ambtx" : "text-dim"
                    }`}
                  >
                    {candidate.tags.join(", ") || "—"}
                  </span>
                ) : null}
                <span className="text-dim cell-clip">
                  {formatPricePair({
                    inputUsdPerMillionTokens: candidate.inputUsdPerMillionTokens,
                    metered,
                    outputUsdPerMillionTokens: candidate.outputUsdPerMillionTokens,
                  })}
                </span>
                <span
                  className={`flex items-center gap-[6px] cell-clip ${
                    candidateHealth?.tone === "green"
                      ? "text-green"
                      : candidateHealth?.tone === "red"
                        ? "text-redtx"
                        : candidateHealth?.tone === "amber"
                          ? "text-ambtx"
                          : "text-faint"
                  }`}
                >
                  <StatusDot tone={candidateHealth?.tone ?? "dim"} />
                  {candidateHealth?.text ?? "unknown"}
                </span>
                <span className="text-right text-dim tabnum">
                  {formatModelContextTokens(candidate.contextWindow)}
                </span>
                <span className="text-dim cell-clip">{formatCapabilities(candidate)}</span>
                <span className="flex items-center justify-end gap-2">
                  <Meter className="w-[90px]" height={6} ratio={traffic?.share ?? 0} />
                  <span className="w-[56px] text-right text-dim tabnum">
                    {formatCount(traffic?.requestCount ?? 0)}
                  </span>
                </span>
              </GridRow>
            );
          })
        ) : (
          <p className="py-6 font-mono text-13 leading-[1.6] text-dim">
            This virtual model has no candidate yet, so requests naming it fail. Add at least one
            provider model to its route.
          </p>
        )}
      </div>

      {/* Soft warnings: the route saved, but these candidates behave in a way the
          operator would otherwise only discover from a failed request. */}
      {policy && policy.routeWarnings.length > 0 ? (
        <ul data-testid="route-warnings" className="mt-3 list-none space-y-1 p-0">
          {policy.routeWarnings.map((warning) => (
            <li key={warning} className="font-mono text-12 leading-[1.6] text-ambtx">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-x-8">
        <div>
          <SectionTitle
            trailing={
              <Link href="/api-keys" className="font-mono text-13 text-dim">
                → API Keys
              </Link>
            }
          >
            API keys with access
          </SectionTitle>
          <div className="mt-2 overflow-x-auto">
            <GridRow columns={KEY_COLUMNS} head>
              <span>API KEY</span>
              <span className="text-right">REQS 24H</span>
              <span className="text-right">DEFAULT MODEL</span>
            </GridRow>
            {grants.length === 0 ? (
              <p className="py-4 font-mono text-13 text-dim">
                No API key grants this model — no client can call it yet.
              </p>
            ) : (
              grants.map((grant) => {
                const keyUsage = usage.apiKeyBreakdowns.find(
                  (entry) => entry.id === grant.apiKeyId,
                );
                return (
                  <GridRow key={grant.apiKeyId} columns={KEY_COLUMNS}>
                    <span className="font-medium cell-clip">{grant.apiKeyName}</span>
                    <span className="text-right tabnum">
                      {formatCount(keyUsage?.requestCount ?? 0)}
                    </span>
                    <span className={`text-right ${grant.isDefault ? "text-ambtx" : "text-dim"}`}>
                      {grant.isDefault ? "default" : "granted"}
                    </span>
                  </GridRow>
                );
              })
            )}
          </div>
        </div>

        <div>
          <SectionTitle
            trailing={
              <Link
                href={activityHref({ status: "failed", virtualModelId: virtualModel.id })}
                className="font-mono text-13 text-dim"
              >
                → Activity
              </Link>
            }
          >
            Recent failures
          </SectionTitle>
          <div className="mt-2 border-t border-hair">
            {recentFailures.length === 0 ? (
              <p className="py-4 font-mono text-13 text-dim">
                No failed request in the retention window.
              </p>
            ) : (
              recentFailures.map((activity) => (
                <GridRow key={activity.id} columns={FAILURE_COLUMNS} gap={10}>
                  <span className="text-faint tabnum">{formatClock(activity.startedAt)}</span>
                  <span className="cell-clip">
                    {activity.apiKeyName ?? "unknown key"} →{" "}
                    {activity.providerDisplayName ?? "no candidate"}
                  </span>
                  <span className="text-right text-redtx cell-clip">
                    {activity.httpStatus ?? "—"} {activity.errorCode ?? "failed"}
                  </span>
                </GridRow>
              ))
            )}
          </div>
          <p className="mt-2 font-mono text-12 leading-[1.6] text-faint">
            Requests are attributed to {virtualModel.name} by name snapshot, so history survives a
            rename. {now.toISOString().slice(11, 16)} UTC
          </p>
        </div>
      </div>
    </div>
  );
}

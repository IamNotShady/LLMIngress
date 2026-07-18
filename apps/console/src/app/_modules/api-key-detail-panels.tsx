// Rendered by both the API key detail dialog (a server component) and the
// created-key dialog (a client component), so this module must stay free of
// server-only dependencies: `gatewayPublicBaseUrl` pulls in node:fs and is
// resolved by the caller, then passed down as a prop.

import type { ConsoleApiKeyLimit } from "@llmingress/db/console-api-key-limits";
import type { ApiKeyAllowedVirtualModel } from "@llmingress/db/console-api-keys";
import { formatConsoleCompactCount } from "@llmingress/db/console-format";
import { SecretRevealField } from "../_components/secret-reveal-field";
import { groupVirtualModelEndpoints } from "./api-key-integration-guide";
import { IntegrationGuideTabs } from "./api-key-integration-guide-tabs";
import { findApiKeyLimit, formatRouteEndpointProtocolLabel } from "./sections";

export function formatApiKeyDetailDate(value: Date | string): string {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatApiKeyBudgetLimit(limit: ConsoleApiKeyLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `$${limit.limitValue.toLocaleString()} / ${limit.period}`;
}

export function formatApiKeyCountLimit(limit: ConsoleApiKeyLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `${formatConsoleCompactCount(limit.limitValue)} / ${limit.period}`;
}

export function ApiKeyDetailPanels({
  createdAt,
  defaultVirtualModelName,
  enabled,
  gatewayBaseUrl,
  guideApiKey,
  guideKeyPrefix,
  guideModel,
  idPrefix,
  limits,
  secretHideable,
  secretLabel,
  secretNote,
  secretValue,
  virtualModels,
}: {
  createdAt: Date | string;
  defaultVirtualModelName: string | null;
  enabled: boolean;
  gatewayBaseUrl: string;
  guideApiKey: string;
  guideKeyPrefix?: string | null;
  guideModel: string;
  idPrefix: string;
  limits: readonly ConsoleApiKeyLimit[];
  secretHideable: boolean;
  secretLabel: string;
  secretNote: string;
  secretValue: string;
  virtualModels: readonly ApiKeyAllowedVirtualModel[];
}) {
  const endpointGroups = groupVirtualModelEndpoints({ gatewayBaseUrl, virtualModels });

  return (
    <>
      <div className="api-key-view-columns">
        <div className="api-key-view-column">
          <dl className="api-key-detail-fields">
            <div>
              <dt>Created</dt>
              <dd>{formatApiKeyDetailDate(createdAt)}</dd>
            </div>
            <div>
              <dt>Enabled</dt>
              <dd>{enabled ? "True" : "False"}</dd>
            </div>
            <div>
              <dt>Default model</dt>
              <dd>{defaultVirtualModelName ?? "None"}</dd>
            </div>
          </dl>
          <section className="api-key-detail-section">
            <h3>Budget / Limit</h3>
            <div className="api-key-limit-row">
              <span>Budget</span>
              <strong>{formatApiKeyBudgetLimit(findApiKeyLimit(limits, "budget"))}</strong>
            </div>
            <div className="api-key-limit-row">
              <span>RPM</span>
              <strong>{formatApiKeyCountLimit(findApiKeyLimit(limits, "rpm"))}</strong>
            </div>
            <div className="api-key-limit-row">
              <span>TPM</span>
              <strong>{formatApiKeyCountLimit(findApiKeyLimit(limits, "tpm"))}</strong>
            </div>
            <div className="api-key-limit-row">
              <span>Token limit</span>
              <strong>{formatApiKeyCountLimit(findApiKeyLimit(limits, "token"))}</strong>
            </div>
          </section>
        </div>
        <div className="api-key-view-column">
          <section className="api-key-detail-section">
            <h3>Endpoints</h3>
            {virtualModels.length === 0 ? (
              <p>No Virtual Models are allowed for this API key.</p>
            ) : null}
            {endpointGroups.configured.map((group) => (
              <div className="api-key-endpoint-group" key={group.protocol}>
                <p className="api-key-endpoint-url mono">{group.url}</p>
                <p className="api-key-endpoint-protocol">
                  {formatRouteEndpointProtocolLabel(group.protocol)}
                </p>
                <div className="api-key-chip-list">
                  {group.virtualModels.map((virtualModel) => (
                    <span className="api-key-chip" key={virtualModel.id}>
                      {virtualModel.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {endpointGroups.unrouted.length > 0 ? (
              <div className="api-key-endpoint-group api-key-endpoint-group-unrouted">
                <p className="api-key-endpoint-url">No route policy configured</p>
                <div className="api-key-chip-list">
                  {endpointGroups.unrouted.map((virtualModel) => (
                    <span className="api-key-chip" key={virtualModel.id}>
                      {virtualModel.name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <section className="api-key-detail-section">
        <h3>{secretLabel}</h3>
        <SecretRevealField hideable={secretHideable} label={secretLabel} value={secretValue} />
        <p className="api-key-secret-note">{secretNote}</p>
      </section>
      <section className="api-key-detail-section">
        <h3>Integration guide</h3>
        <IntegrationGuideTabs
          apiKey={guideApiKey}
          gatewayBaseUrl={gatewayBaseUrl}
          idPrefix={idPrefix}
          keyPrefix={guideKeyPrefix}
          model={guideModel}
        />
      </section>
    </>
  );
}

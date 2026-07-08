import {
  formatGatewayConfigVersion,
  formatGatewayHeartbeatStatus,
  formatRuntimeReloadResult,
  getConsoleRuntimeSnapshot,
} from "@llmingress/db/console-runtime";
import { StatCard } from "../_components/stat-card";
import { formatDateTime } from "./sections";

const runtimeSecurityNotes = [
  "Provider API keys are encrypted with AES-256-GCM and decrypted only in memory.",
  "Agent API keys are stored as a hash; the full key is shown once at creation.",
  "Gateway runtime config is applied from the deployed config version; the Console cannot restart processes.",
  "This page is read-only runtime status — it does not change any stored settings.",
];

function getPlaygroundGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

function formatConfigVersion(value: number | null): string {
  return value === null ? "None" : `v${value}`;
}
export async function RuntimeSection() {
  const runtimeSnapshot = await getConsoleRuntimeSnapshot();
  const gateway = runtimeSnapshot.gateways[0] ?? null;

  return (
    <section className="providers-panel" id="runtime" aria-labelledby="runtime-title">
      <h2 className="sr-only" id="runtime-title">
        Gateway Runtime
      </h2>
      <div className="stat-grid">
        <StatCard
          icon="ST"
          label="Gateway status"
          value={gateway ? gateway.status : "No gateway"}
        />
        <StatCard icon="URL" label="Configured Gateway URL" value={getPlaygroundGatewayBaseUrl()} />
        <StatCard
          icon="CV"
          label="Config version"
          value={formatGatewayConfigVersion(gateway?.appliedConfigVersion ?? null)}
        />
        <StatCard
          icon="HB"
          label="Heartbeat"
          value={gateway ? formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt }) : "—"}
          valueTone={
            gateway &&
            formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt }) !== "Healthy"
              ? "warn"
              : undefined
          }
        />
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Gateway internal errors</h3>
        {runtimeSnapshot.errors.length === 0 ? (
          <p>No gateway internal errors recorded.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Code</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {runtimeSnapshot.errors.map((error) => (
                  <tr
                    key={`${error.processType}:${error.processId}:${error.errorCode}:${error.createdAt.toISOString()}`}
                  >
                    <td>{formatDateTime(error.createdAt)}</td>
                    <td>{error.processType}</td>
                    <td className="mono">{error.errorCode}</td>
                    <td>{error.errorMessage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Migration status</h3>
        <dl className="detail-field-list">
          <div className="detail-field">
            <dt>Current schema</dt>
            <dd>{runtimeSnapshot.migrations.currentSchemaVersion ?? "not initialized"}</dd>
          </div>
          <div className="detail-field">
            <dt>Applied migrations</dt>
            <dd>
              {runtimeSnapshot.migrations.appliedCount}/{runtimeSnapshot.migrations.totalCount}
            </dd>
          </div>
          <div className="detail-field">
            <dt>Pending migrations</dt>
            <dd>
              {runtimeSnapshot.migrations.pendingMigrations.length === 0
                ? "none"
                : runtimeSnapshot.migrations.pendingMigrations
                    .map((migration) => `${migration.id}_${migration.name}`)
                    .join(", ")}
            </dd>
          </div>
          <div className="detail-field">
            <dt>db:migrate:check</dt>
            <dd>
              {runtimeSnapshot.migrations.migrateCheckHealth.status === "ready" ? (
                <span className="pill--ok pill">Ready</span>
              ) : (
                <span className="pill--danger pill">Blocked</span>
              )}
            </dd>
          </div>
          {gateway ? (
            <>
              <div className="detail-field">
                <dt>Applied config</dt>
                <dd>{formatConfigVersion(gateway.appliedConfigVersion)}</dd>
              </div>
              <div className="detail-field">
                <dt>Target config</dt>
                <dd>{formatConfigVersion(gateway.targetConfigVersion)}</dd>
              </div>
              <div className="detail-field">
                <dt>Config reload</dt>
                <dd>{formatRuntimeReloadResult(gateway)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Security</h3>
        <ul className="note-list">
          {runtimeSecurityNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

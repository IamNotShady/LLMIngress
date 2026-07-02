import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/client";
import {
  countEnabledWebhookNotificationChannels,
  notificationAlertAlreadyQueued,
  readObject,
  readPositiveIntegerEnv,
  readPositiveIntegerPayload,
} from "./worker-alert-utils.ts";
import type { JobHandler } from "./worker-job-runner.ts";
import { queueNotificationEvent } from "./worker-notification-dispatcher.ts";

export type ProviderFailureAlertSettings = {
  intervalMs: number;
  thresholdCount: number;
};

export type ProviderFailureAlertPayload = {
  thresholdCount: number;
};

export type ProviderFailureAlertsResult = {
  evaluatedSummaryCount: number;
  notificationEventCount: number;
  queuedAlertCount: number;
  skippedDuplicateAlertCount: number;
  skippedNoChannelCount: number;
  thresholdCount: number;
};

type CreateProviderFailureAlertsJobHandlerOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

type EvaluateProviderFailureAlertsOptions = CreateProviderFailureAlertsJobHandlerOptions & {
  payload: unknown;
};

type ProviderFailureAlertCandidateRow = PostgresQueryResultRow & {
  consecutive_failures: number;
  last_failure_at: Date | null;
  model_display_name: string | null;
  model_id: string | null;
  provider_display_name: string;
  provider_id: string;
  provider_key: string;
  provider_model_id: string | null;
  status: string;
  summary_id: string;
  updated_at: Date;
};

type ProviderFailureAlertCandidate = {
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  modelDisplayName: string | null;
  modelId: string | null;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
  providerModelId: string | null;
  status: string;
  summaryId: string;
  updatedAt: Date;
};

const defaultProviderFailureAlertIntervalMs = 5 * 60 * 1000;
const defaultProviderFailureAlertThresholdCount = 3;

export function createProviderFailureAlertsJobHandler(
  options: CreateProviderFailureAlertsJobHandlerOptions,
): JobHandler {
  return async (job) =>
    evaluateProviderFailureAlerts({
      ...options,
      payload: job.payload,
    });
}

export async function evaluateProviderFailureAlerts(
  options: EvaluateProviderFailureAlertsOptions,
): Promise<ProviderFailureAlertsResult> {
  const payload = readProviderFailureAlertPayload(options.payload);
  const now = options.now?.() ?? new Date();
  const [evaluatedSummaryCount, candidates, enabledChannelCount] = await Promise.all([
    countProviderFailureSummaries(options.databaseUrl),
    readProviderFailureAlertCandidates({
      databaseUrl: options.databaseUrl,
      thresholdCount: payload.thresholdCount,
    }),
    countEnabledWebhookNotificationChannels(options.databaseUrl),
  ]);
  const result: ProviderFailureAlertsResult = {
    evaluatedSummaryCount,
    notificationEventCount: 0,
    queuedAlertCount: 0,
    skippedDuplicateAlertCount: 0,
    skippedNoChannelCount: 0,
    thresholdCount: payload.thresholdCount,
  };

  for (const candidate of candidates) {
    const event = buildProviderFailureNotificationEvent({
      candidate,
      thresholdCount: payload.thresholdCount,
    });
    if (
      await notificationAlertAlreadyQueued({
        alertKey: event.payload.alertKey,
        databaseUrl: options.databaseUrl,
        eventType: "provider_failure",
      })
    ) {
      result.skippedDuplicateAlertCount += 1;
      continue;
    }
    if (enabledChannelCount === 0) {
      result.skippedNoChannelCount += 1;
      continue;
    }

    const queued = await queueNotificationEvent({
      databaseUrl: options.databaseUrl,
      event,
      now: () => now,
    });
    result.queuedAlertCount += 1;
    result.notificationEventCount += queued.eventIds.length;
  }

  return result;
}

export function readProviderFailureAlertSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): ProviderFailureAlertSettings {
  return {
    intervalMs: readPositiveIntegerEnv(
      env.PROVIDER_FAILURE_ALERT_INTERVAL_MS,
      defaultProviderFailureAlertIntervalMs,
      "PROVIDER_FAILURE_ALERT_INTERVAL_MS",
    ),
    thresholdCount: readPositiveIntegerEnv(
      env.PROVIDER_FAILURE_ALERT_THRESHOLD,
      defaultProviderFailureAlertThresholdCount,
      "PROVIDER_FAILURE_ALERT_THRESHOLD",
    ),
  };
}

export function readProviderFailureAlertPayload(payload: unknown): ProviderFailureAlertPayload {
  const rawPayload = readObject(payload);
  const settings = readProviderFailureAlertSettings();

  return {
    thresholdCount:
      rawPayload.thresholdCount === undefined
        ? settings.thresholdCount
        : readPositiveIntegerPayload({
            errorCode: "provider_failure_alerts_invalid_payload",
            label: "Provider failure alert",
            name: "thresholdCount",
            value: rawPayload.thresholdCount,
          }),
  };
}

function buildProviderFailureNotificationEvent(input: {
  candidate: ProviderFailureAlertCandidate;
  thresholdCount: number;
}) {
  const scope = input.candidate.providerModelId ? "model" : "provider";
  const alertTimestamp = input.candidate.lastFailureAt ?? input.candidate.updatedAt;
  const payload = {
    alertKey: `provider_failure:${input.candidate.summaryId}:${input.candidate.consecutiveFailures}:${alertTimestamp.toISOString()}`,
    consecutiveFailures: input.candidate.consecutiveFailures,
    lastFailureAt: input.candidate.lastFailureAt?.toISOString() ?? null,
    modelDisplayName: input.candidate.modelDisplayName,
    modelId: input.candidate.modelId,
    providerDisplayName: input.candidate.providerDisplayName,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    scope,
    status: input.candidate.status,
    summaryId: input.candidate.summaryId,
    thresholdCount: input.thresholdCount,
  };

  return {
    body: `${input.candidate.providerDisplayName} has ${input.candidate.consecutiveFailures} consecutive ${scope} health failures.`,
    eventType: "provider_failure",
    maxAttempts: 3,
    payload,
    subject: "Provider failure warning",
  };
}

async function countProviderFailureSummaries(databaseUrl?: string): Promise<number> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from provider_health_summary
        join providers on providers.id = provider_health_summary.provider_id
        where provider_health_summary.status in (
          'unhealthy',
          'auth_failed',
          'quota_limited',
          'network_error'
        )
          and provider_health_summary.consecutive_failures > 0
          and providers.enabled = true
          and providers.deleted_at is null
      `,
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function readProviderFailureAlertCandidates(input: {
  databaseUrl?: string;
  thresholdCount: number;
}): Promise<ProviderFailureAlertCandidate[]> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<ProviderFailureAlertCandidateRow>(
      `
        select provider_health_summary.id::text as summary_id,
               provider_health_summary.provider_id::text,
               provider_health_summary.provider_model_id::text,
               provider_health_summary.status,
               provider_health_summary.consecutive_failures,
               provider_health_summary.last_failure_at,
               provider_health_summary.updated_at,
               providers.provider_key,
               providers.display_name as provider_display_name,
               provider_models.model_id,
               provider_models.display_name as model_display_name
        from provider_health_summary
        join providers on providers.id = provider_health_summary.provider_id
        left join provider_models on provider_models.id = provider_health_summary.provider_model_id
        where provider_health_summary.status in (
          'unhealthy',
          'auth_failed',
          'quota_limited',
          'network_error'
        )
          and provider_health_summary.consecutive_failures >= $1
          and providers.enabled = true
          and providers.deleted_at is null
          and (
            provider_health_summary.provider_model_id is null
            or provider_models.deleted_at is null
          )
        order by providers.provider_key,
                 provider_models.model_id nulls first,
                 provider_health_summary.id
      `,
      [input.thresholdCount],
    );
    return result.rows.map(rowToProviderFailureAlertCandidate);
  } finally {
    await client.end();
  }
}

function rowToProviderFailureAlertCandidate(
  row: ProviderFailureAlertCandidateRow,
): ProviderFailureAlertCandidate {
  return {
    consecutiveFailures: Number(row.consecutive_failures),
    lastFailureAt: row.last_failure_at,
    modelDisplayName: row.model_display_name,
    modelId: row.model_id,
    providerDisplayName: row.provider_display_name,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    providerModelId: row.provider_model_id,
    status: row.status,
    summaryId: row.summary_id,
    updatedAt: row.updated_at,
  };
}

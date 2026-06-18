import { Client, type QueryResultRow } from "pg";
import { type JobHandler, JobHandlerError } from "./job-runner.js";
import { queueNotificationEvent } from "./notification-dispatcher.js";

export type FallbackExhaustionAlertSettings = {
  intervalMs: number;
  windowMs: number;
};

export type FallbackExhaustionAlertPayload = {
  windowMs: number;
};

export type FallbackExhaustionAlertsResult = {
  evaluatedFailedRequestCount: number;
  notificationEventCount: number;
  queuedAlertCount: number;
  skippedDuplicateAlertCount: number;
  skippedNoChannelCount: number;
  windowMs: number;
};

type CreateFallbackExhaustionAlertsJobHandlerOptions = {
  databaseUrl: string;
  now?: () => Date;
};

type EvaluateFallbackExhaustionAlertsOptions = CreateFallbackExhaustionAlertsJobHandlerOptions & {
  payload: unknown;
};

type FallbackExhaustionCandidateRow = QueryResultRow & {
  activity_id: string;
  agent_api_key_id: string;
  agent_api_key_prefix: string;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  fallback_attempts: unknown;
  fallback_event_count: number;
  http_status: number | null;
  model: string | null;
  protocol: string;
  request_id: string;
  status: string;
  virtual_model_id: string | null;
};

type FallbackExhaustionCandidate = {
  activityId: string;
  agentApiKeyId: string;
  agentApiKeyPrefix: string;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  fallbackAttempts: unknown;
  fallbackEventCount: number;
  httpStatus: number | null;
  model: string | null;
  protocol: string;
  requestId: string;
  status: string;
  virtualModelId: string | null;
};

const defaultFallbackExhaustionAlertIntervalMs = 5 * 60 * 1000;
const defaultFallbackExhaustionAlertWindowMs = 15 * 60 * 1000;

export function createFallbackExhaustionAlertsJobHandler(
  options: CreateFallbackExhaustionAlertsJobHandlerOptions,
): JobHandler {
  return async (job) =>
    evaluateFallbackExhaustionAlerts({
      ...options,
      payload: job.payload,
    });
}

export async function evaluateFallbackExhaustionAlerts(
  options: EvaluateFallbackExhaustionAlertsOptions,
): Promise<FallbackExhaustionAlertsResult> {
  const payload = readFallbackExhaustionAlertPayload(options.payload);
  const now = options.now?.() ?? new Date();
  const windowStart = new Date(now.getTime() - payload.windowMs);
  const [evaluatedFailedRequestCount, candidates, enabledChannelCount] = await Promise.all([
    countFailedProviderRequests({
      databaseUrl: options.databaseUrl,
      windowEnd: now,
      windowStart,
    }),
    readFallbackExhaustionCandidates({
      databaseUrl: options.databaseUrl,
      windowEnd: now,
      windowStart,
    }),
    readEnabledNotificationChannelCount(options.databaseUrl),
  ]);
  const result: FallbackExhaustionAlertsResult = {
    evaluatedFailedRequestCount,
    notificationEventCount: 0,
    queuedAlertCount: 0,
    skippedDuplicateAlertCount: 0,
    skippedNoChannelCount: 0,
    windowMs: payload.windowMs,
  };

  for (const candidate of candidates) {
    const event = buildFallbackExhaustionNotificationEvent(candidate, payload.windowMs);
    if (await fallbackExhaustionAlertAlreadyQueued(options.databaseUrl, event.payload.alertKey)) {
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

export function readFallbackExhaustionAlertSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): FallbackExhaustionAlertSettings {
  return {
    intervalMs: readPositiveIntegerEnv(
      env.FALLBACK_EXHAUSTION_ALERT_INTERVAL_MS,
      defaultFallbackExhaustionAlertIntervalMs,
      "FALLBACK_EXHAUSTION_ALERT_INTERVAL_MS",
    ),
    windowMs: readPositiveIntegerEnv(
      env.FALLBACK_EXHAUSTION_ALERT_WINDOW_MS,
      defaultFallbackExhaustionAlertWindowMs,
      "FALLBACK_EXHAUSTION_ALERT_WINDOW_MS",
    ),
  };
}

export function readFallbackExhaustionAlertPayload(
  payload: unknown,
): FallbackExhaustionAlertPayload {
  const rawPayload = readObject(payload);
  const settings = readFallbackExhaustionAlertSettings();

  return {
    windowMs:
      rawPayload.windowMs === undefined
        ? settings.windowMs
        : readPositiveIntegerPayload(rawPayload.windowMs, "windowMs"),
  };
}

function buildFallbackExhaustionNotificationEvent(
  candidate: FallbackExhaustionCandidate,
  windowMs: number,
) {
  const payload = {
    activityId: candidate.activityId,
    agentApiKeyId: candidate.agentApiKeyId,
    agentApiKeyPrefix: candidate.agentApiKeyPrefix,
    alertKey: `fallback_exhaustion:${candidate.activityId}`,
    completedAt: candidate.completedAt?.toISOString() ?? null,
    errorCode: candidate.errorCode,
    errorMessage: candidate.errorMessage,
    fallbackAttempts: candidate.fallbackAttempts,
    fallbackEventCount: candidate.fallbackEventCount,
    httpStatus: candidate.httpStatus,
    model: candidate.model,
    protocol: candidate.protocol,
    requestId: candidate.requestId,
    status: candidate.status,
    virtualModelId: candidate.virtualModelId,
    windowMs,
  };

  return {
    body: `Fallback chain exhausted for request ${candidate.requestId}.`,
    eventType: "fallback_exhaustion",
    maxAttempts: 3,
    payload,
    subject: "Fallback exhaustion warning",
  };
}

async function countFailedProviderRequests(input: {
  databaseUrl: string;
  windowEnd: Date;
  windowStart: Date;
}): Promise<number> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from request_activity
        where status = 'failed'
          and error_code = 'provider_request_failed'
          and coalesce(completed_at, started_at, created_at) >= $1::timestamptz
          and coalesce(completed_at, started_at, created_at) <= $2::timestamptz
      `,
      [input.windowStart.toISOString(), input.windowEnd.toISOString()],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function readFallbackExhaustionCandidates(input: {
  databaseUrl: string;
  windowEnd: Date;
  windowStart: Date;
}): Promise<FallbackExhaustionCandidate[]> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<FallbackExhaustionCandidateRow>(
      `
        select request_activity.id::text as activity_id,
               request_activity.request_id,
               request_activity.agent_api_key_id::text,
               request_activity.agent_api_key_prefix,
               request_activity.virtual_model_id::text,
               request_activity.protocol,
               request_activity.model,
               request_activity.status,
               request_activity.error_code,
               request_activity.error_message,
               request_activity.http_status,
               request_activity.fallback_attempts,
               request_activity.completed_at,
               count(fallback_events.id)::integer as fallback_event_count
        from request_activity
        join fallback_events on fallback_events.request_activity_id = request_activity.id
        where request_activity.status = 'failed'
          and request_activity.error_code = 'provider_request_failed'
          and fallback_events.status = 'failed'
          and coalesce(
            request_activity.completed_at,
            request_activity.started_at,
            request_activity.created_at
          ) >= $1::timestamptz
          and coalesce(
            request_activity.completed_at,
            request_activity.started_at,
            request_activity.created_at
          ) <= $2::timestamptz
        group by request_activity.id
        order by request_activity.completed_at, request_activity.id
      `,
      [input.windowStart.toISOString(), input.windowEnd.toISOString()],
    );
    return result.rows.map(rowToFallbackExhaustionCandidate);
  } finally {
    await client.end();
  }
}

function rowToFallbackExhaustionCandidate(
  row: FallbackExhaustionCandidateRow,
): FallbackExhaustionCandidate {
  return {
    activityId: row.activity_id,
    agentApiKeyId: row.agent_api_key_id,
    agentApiKeyPrefix: row.agent_api_key_prefix,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    fallbackAttempts: row.fallback_attempts,
    fallbackEventCount: Number(row.fallback_event_count),
    httpStatus: row.http_status,
    model: row.model,
    protocol: row.protocol,
    requestId: row.request_id,
    status: row.status,
    virtualModelId: row.virtual_model_id,
  };
}

async function readEnabledNotificationChannelCount(databaseUrl: string): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from notification_channels where enabled = true",
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function fallbackExhaustionAlertAlreadyQueued(
  databaseUrl: string,
  alertKey: string,
): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from notification_events
          where event_type = 'fallback_exhaustion'
            and payload ->> 'alertKey' = $1
        ) as exists
      `,
      [alertKey],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

function readPositiveIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readPositiveIntegerPayload(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new JobHandlerError(
      "fallback_exhaustion_alerts_invalid_payload",
      `Fallback exhaustion alert payload ${name} must be a positive integer.`,
    );
  }
  return value;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

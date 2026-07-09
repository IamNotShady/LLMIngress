import { PostgresClient } from "@llmingress/db/client";
import {
  countEnabledNotificationChannels,
  notificationAlertAlreadyQueued,
  readObject,
  readPositiveIntegerEnv,
  readPositiveIntegerPayload,
} from "./worker-alert-utils.ts";
import type { JobHandler } from "./worker-job-runner.ts";
import { queueNotificationEvent } from "./worker-notification-dispatcher.ts";

export type RateLimitAlertSettings = {
  intervalMs: number;
  thresholdCount: number;
  windowMs: number;
};

export type RateLimitAlertPayload = {
  thresholdCount: number;
  windowMs: number;
};

export type RateLimitAlertsResult = {
  evaluatedBlockCount: number;
  notificationEventCount: number;
  queuedAlertCount: number;
  skippedDuplicateAlertCount: number;
  skippedNoChannelCount: number;
  thresholdCount: number;
  windowMs: number;
};

type CreateRateLimitAlertsJobHandlerOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

type EvaluateRateLimitAlertsOptions = CreateRateLimitAlertsJobHandlerOptions & {
  payload: unknown;
};

type RateLimitAlertCandidateRow = {
  agent_key_prefix: string;
  agent_id: string;
  agent_name: string;
  block_count: number;
  first_block_at: Date;
  last_block_at: Date;
  limit_type: "rpm" | "tpm";
  request_ids: string[];
};

type RateLimitAlertCandidate = {
  agentApiKeyPrefix: string;
  agentId: string;
  agentName: string;
  blockCount: number;
  firstBlockAt: Date;
  lastBlockAt: Date;
  limitType: "rpm" | "tpm";
  requestIds: string[];
};

const defaultRateLimitAlertIntervalMs = 5 * 60 * 1000;
const defaultRateLimitAlertThresholdCount = 3;
const defaultRateLimitAlertWindowMs = 15 * 60 * 1000;

export function createRateLimitAlertsJobHandler(
  options: CreateRateLimitAlertsJobHandlerOptions,
): JobHandler {
  return async (job) =>
    evaluateRateLimitAlerts({
      ...options,
      payload: job.payload,
    });
}

export async function evaluateRateLimitAlerts(
  options: EvaluateRateLimitAlertsOptions,
): Promise<RateLimitAlertsResult> {
  const payload = readRateLimitAlertPayload(options.payload);
  const now = options.now?.() ?? new Date();
  const windowStart = new Date(now.getTime() - payload.windowMs);
  const [evaluatedBlockCount, candidates, enabledChannelCount] = await Promise.all([
    countRateLimitBlocks({
      databaseUrl: options.databaseUrl,
      windowEnd: now,
      windowStart,
    }),
    readRateLimitAlertCandidates({
      databaseUrl: options.databaseUrl,
      thresholdCount: payload.thresholdCount,
      windowEnd: now,
      windowStart,
    }),
    countEnabledNotificationChannels(options.databaseUrl),
  ]);
  const result: RateLimitAlertsResult = {
    evaluatedBlockCount,
    notificationEventCount: 0,
    queuedAlertCount: 0,
    skippedDuplicateAlertCount: 0,
    skippedNoChannelCount: 0,
    thresholdCount: payload.thresholdCount,
    windowMs: payload.windowMs,
  };

  for (const candidate of candidates) {
    const event = buildRateLimitAlertNotificationEvent({
      candidate,
      payload,
      windowEnd: now,
      windowStart,
    });
    if (
      await notificationAlertAlreadyQueued({
        alertKey: event.payload.alertKey,
        databaseUrl: options.databaseUrl,
        eventType: "rate_limit_high_frequency",
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

export function readRateLimitAlertSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): RateLimitAlertSettings {
  return {
    intervalMs: readPositiveIntegerEnv(
      env.RATE_LIMIT_ALERT_INTERVAL_MS,
      defaultRateLimitAlertIntervalMs,
      "RATE_LIMIT_ALERT_INTERVAL_MS",
    ),
    thresholdCount: readPositiveIntegerEnv(
      env.RATE_LIMIT_ALERT_THRESHOLD,
      defaultRateLimitAlertThresholdCount,
      "RATE_LIMIT_ALERT_THRESHOLD",
    ),
    windowMs: readPositiveIntegerEnv(
      env.RATE_LIMIT_ALERT_WINDOW_MS,
      defaultRateLimitAlertWindowMs,
      "RATE_LIMIT_ALERT_WINDOW_MS",
    ),
  };
}

export function readRateLimitAlertPayload(payload: unknown): RateLimitAlertPayload {
  const rawPayload = readObject(payload);
  const settings = readRateLimitAlertSettings();

  return {
    thresholdCount:
      rawPayload.thresholdCount === undefined
        ? settings.thresholdCount
        : readPositiveIntegerPayload({
            errorCode: "rate_limit_alerts_invalid_payload",
            label: "Rate limit alert",
            name: "thresholdCount",
            value: rawPayload.thresholdCount,
          }),
    windowMs:
      rawPayload.windowMs === undefined
        ? settings.windowMs
        : readPositiveIntegerPayload({
            errorCode: "rate_limit_alerts_invalid_payload",
            label: "Rate limit alert",
            name: "windowMs",
            value: rawPayload.windowMs,
          }),
  };
}

function buildRateLimitAlertNotificationEvent(input: {
  candidate: RateLimitAlertCandidate;
  payload: RateLimitAlertPayload;
  windowEnd: Date;
  windowStart: Date;
}) {
  const payload = {
    agentApiKeyPrefix: input.candidate.agentApiKeyPrefix,
    agentId: input.candidate.agentId,
    agentName: input.candidate.agentName,
    alertKey: `rate_limit:${input.candidate.agentId}:${input.candidate.limitType}:${input.candidate.lastBlockAt.toISOString()}:${input.payload.windowMs}:${input.payload.thresholdCount}`,
    blockCount: input.candidate.blockCount,
    firstBlockAt: input.candidate.firstBlockAt.toISOString(),
    lastBlockAt: input.candidate.lastBlockAt.toISOString(),
    limitType: input.candidate.limitType,
    requestIds: input.candidate.requestIds.slice(0, 10),
    thresholdCount: input.payload.thresholdCount,
    windowEnd: input.windowEnd.toISOString(),
    windowMs: input.payload.windowMs,
    windowStart: input.windowStart.toISOString(),
  };

  return {
    body: `${input.candidate.agentName} saw ${input.candidate.blockCount} ${input.candidate.limitType.toUpperCase()} blocks in the configured alert window.`,
    eventType: "rate_limit_high_frequency",
    maxAttempts: 3,
    payload,
    subject: "Rate limit high-frequency warning",
  };
}

async function countRateLimitBlocks(input: {
  databaseUrl?: string;
  windowEnd: Date;
  windowStart: Date;
}): Promise<number> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from request_activity
        where error_code = 'rate_limit_exceeded'
          and http_status = 429
          and coalesce(completed_at, started_at, created_at) >= $1::timestamptz
          and coalesce(completed_at, started_at, created_at) <= $2::timestamptz
          and (
            upper(coalesce(error_message, '')) like '%RPM%'
            or upper(coalesce(error_message, '')) like '%TPM%'
          )
      `,
      [input.windowStart.toISOString(), input.windowEnd.toISOString()],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function readRateLimitAlertCandidates(input: {
  databaseUrl?: string;
  thresholdCount: number;
  windowEnd: Date;
  windowStart: Date;
}): Promise<RateLimitAlertCandidate[]> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<RateLimitAlertCandidateRow>(
      `
        with blocked as (
          select request_activity.agent_id,
                 request_activity.agent_key_prefix as agent_key_prefix,
                 request_activity.request_id,
                 coalesce(
                   request_activity.completed_at,
                   request_activity.started_at,
                   request_activity.created_at
                 ) as blocked_at,
                 case
                   when upper(coalesce(request_activity.error_message, '')) like '%RPM%' then 'rpm'
                   when upper(coalesce(request_activity.error_message, '')) like '%TPM%' then 'tpm'
                   else null
                 end as limit_type
          from request_activity
          where request_activity.error_code = 'rate_limit_exceeded'
            and request_activity.http_status = 429
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
        )
        select blocked.agent_key_prefix,
               agents.id::text as agent_id,
               agents.name as agent_name,
               blocked.limit_type,
               count(*)::integer as block_count,
               min(blocked.blocked_at) as first_block_at,
               max(blocked.blocked_at) as last_block_at,
               array_agg(blocked.request_id order by blocked.blocked_at desc) as request_ids
        from blocked
        join agents on agents.id = blocked.agent_id
        where blocked.limit_type is not null
          and agents.enabled = true
          and agents.deleted_at is null
        group by blocked.agent_id,
                 blocked.agent_key_prefix,
                 agents.id,
                 agents.name,
                 blocked.limit_type
        having count(*) >= $3
        order by agents.name, blocked.agent_key_prefix, blocked.limit_type
      `,
      [input.windowStart.toISOString(), input.windowEnd.toISOString(), input.thresholdCount],
    );
    return result.rows.map(rowToRateLimitAlertCandidate);
  } finally {
    await client.end();
  }
}

function rowToRateLimitAlertCandidate(row: RateLimitAlertCandidateRow): RateLimitAlertCandidate {
  return {
    agentApiKeyPrefix: row.agent_key_prefix,
    agentId: row.agent_id,
    agentName: row.agent_name,
    blockCount: Number(row.block_count),
    firstBlockAt: row.first_block_at,
    lastBlockAt: row.last_block_at,
    limitType: row.limit_type,
    requestIds: row.request_ids,
  };
}

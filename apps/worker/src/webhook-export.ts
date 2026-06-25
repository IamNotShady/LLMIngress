import { randomUUID } from "node:crypto";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/maintenance";
import { type JobHandler, JobHandlerError } from "./job-runner.js";
import { redactSecretsFromJsonlValue } from "./jsonl-export.js";

export type WebhookEventExportActivity = {
  agentApiKeyPrefix: string;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  id: string;
  latencyMs: number | null;
  model: string | null;
  protocol: string;
  providerKey: string | null;
  providerModelModelId: string | null;
  requestId: string;
  routeReason: unknown;
  startedAt: Date;
  status: string;
  stream: boolean;
  virtualModelName: string | null;
};

export type WebhookEventExportFallback = {
  attemptOrder: number;
  createdAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  failedBeforeFirstByte: boolean;
  id: string;
  providerKey: string | null;
  providerModelModelId: string | null;
  status: string;
};

export type WebhookEventExportRecord =
  | {
      eventType: "request";
      occurredAt: string;
      request: {
        agentApiKeyPrefix: string;
        httpStatus: number | null;
        latencyMs: number | null;
        model: string | null;
        protocol: string;
        providerKey: string | null;
        providerModelModelId: string | null;
        routeReason: unknown;
        status: string;
        stream: boolean;
        virtualModelName: string | null;
      };
      requestActivityId: string;
      requestId: string;
    }
  | {
      eventType: "fallback";
      fallback: {
        attemptOrder: number;
        errorCode: string | null;
        errorMessage: string | null;
        failedBeforeFirstByte: boolean;
        id: string;
        providerKey: string | null;
        providerModelModelId: string | null;
        status: string;
      };
      fallbackEventId: string;
      occurredAt: string;
      requestActivityId: string;
      requestId: string;
    }
  | {
      error: {
        code: string | null;
        httpStatus: number | null;
        message: string | null;
      };
      eventType: "error";
      occurredAt: string;
      requestActivityId: string;
      requestId: string;
    };

export type WebhookEventExportJobHandlerOptions = {
  databaseUrl: string;
  deliverWebhook?: (input: WebhookEventDeliveryInput) => Promise<WebhookEventDeliveryResult>;
  now?: () => Date;
};

export type WebhookEventDeliveryInput = {
  record: WebhookEventExportRecord;
  webhookUrl: string;
};

export type WebhookEventDeliveryResult =
  | {
      responseBody?: string | null;
      responseStatus?: number | null;
      status: "sent";
    }
  | {
      errorCode: string;
      errorMessage: string;
      responseBody?: string | null;
      responseStatus?: number | null;
      status: "failed";
    };

type NormalizedWebhookEventExportPayload = {
  from: Date | null;
  limit: number;
  requestIds: string[];
  to: Date | null;
  webhookUrl: string;
};

type WebhookEventExportActivityRow = PostgresQueryResultRow & {
  agent_key_prefix: string;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  id: string;
  latency_ms: number | null;
  model: string | null;
  protocol: string;
  provider_key: string | null;
  provider_model_model_id: string | null;
  request_id: string;
  route_reason: unknown;
  started_at: Date;
  status: string;
  stream: boolean;
  virtual_model_name: string | null;
};

type WebhookEventExportFallbackRow = PostgresQueryResultRow & {
  attempt_order: number;
  created_at: Date;
  error_code: string | null;
  error_message: string | null;
  failed_before_first_byte: boolean;
  id: string;
  provider_key: string | null;
  provider_model_model_id: string | null;
  request_activity_id: string;
  status: string;
};

const defaultLimit = 10_000;
const maxLimit = 100_000;
const webhookExportType = "request_fallback_error_events";

export function createWebhookEventExportJobHandler(
  options: WebhookEventExportJobHandlerOptions,
): JobHandler {
  const now = options.now ?? (() => new Date());
  const deliverWebhook = options.deliverWebhook ?? defaultDeliverWebhookEvent;

  return async (job) => {
    const payload = normalizeWebhookEventExportPayload(job.payload);
    const redactedWebhookUrl = redactWebhookUrl(payload.webhookUrl);
    const client = new PostgresClient({ connectionString: options.databaseUrl });
    await client.connect();

    try {
      const rows = await readWebhookEventExportInputs(client, payload);
      const recordsWithRefs = rows.flatMap((row) =>
        buildWebhookEventExportRecords(row).map((record) => ({
          fallbackEventId: record.eventType === "fallback" ? record.fallbackEventId : null,
          record,
          requestActivityId: record.requestActivityId,
        })),
      );
      const summary = {
        delivered: 0,
        failed: 0,
        trigger: job.trigger,
        webhookExportType,
      };

      for (const entry of recordsWithRefs) {
        if (
          await hasSuccessfulWebhookDelivery(client, {
            fallbackEventId: entry.fallbackEventId,
            jobId: job.id,
            record: entry.record,
            requestActivityId: entry.requestActivityId,
          })
        ) {
          summary.delivered += 1;
          continue;
        }

        const startedAt = now();
        const result = await deliverWebhook({
          record: entry.record,
          webhookUrl: payload.webhookUrl,
        });
        const completedAt = now();
        await insertWebhookDelivery(client, {
          completedAt,
          fallbackEventId: entry.fallbackEventId,
          jobId: job.id,
          record: entry.record,
          requestActivityId: entry.requestActivityId,
          result,
          startedAt,
          webhookUrl: redactedWebhookUrl,
        });

        if (result.status === "sent") {
          summary.delivered += 1;
        } else {
          summary.failed += 1;
        }
      }

      if (summary.failed > 0) {
        throw new JobHandlerError(
          "webhook_export_delivery_failed",
          `${summary.failed} webhook event delivery attempt(s) failed.`,
        );
      }

      return summary;
    } finally {
      await client.end();
    }
  };
}

export function buildWebhookEventExportRecords(input: {
  activity: WebhookEventExportActivity;
  fallbackEvents: WebhookEventExportFallback[];
}): WebhookEventExportRecord[] {
  const records: WebhookEventExportRecord[] = [
    {
      eventType: "request",
      occurredAt: input.activity.startedAt.toISOString(),
      request: {
        agentApiKeyPrefix: input.activity.agentApiKeyPrefix,
        httpStatus: input.activity.httpStatus,
        latencyMs: input.activity.latencyMs,
        model: input.activity.model,
        protocol: input.activity.protocol,
        providerKey: input.activity.providerKey,
        providerModelModelId: input.activity.providerModelModelId,
        routeReason: redactWebhookExportValue(input.activity.routeReason),
        status: input.activity.status,
        stream: input.activity.stream,
        virtualModelName: input.activity.virtualModelName,
      },
      requestActivityId: input.activity.id,
      requestId: input.activity.requestId,
    },
  ];

  for (const fallback of input.fallbackEvents) {
    records.push({
      eventType: "fallback",
      fallback: {
        attemptOrder: fallback.attemptOrder,
        errorCode: fallback.errorCode,
        errorMessage: redactWebhookExportValue(fallback.errorMessage) as string | null,
        failedBeforeFirstByte: fallback.failedBeforeFirstByte,
        id: fallback.id,
        providerKey: fallback.providerKey,
        providerModelModelId: fallback.providerModelModelId,
        status: fallback.status,
      },
      fallbackEventId: fallback.id,
      occurredAt: fallback.createdAt.toISOString(),
      requestActivityId: input.activity.id,
      requestId: input.activity.requestId,
    });
  }

  if (input.activity.errorCode || input.activity.errorMessage) {
    records.push({
      error: {
        code: input.activity.errorCode,
        httpStatus: input.activity.httpStatus,
        message: redactWebhookExportValue(input.activity.errorMessage) as string | null,
      },
      eventType: "error",
      occurredAt: (input.activity.completedAt ?? input.activity.startedAt).toISOString(),
      requestActivityId: input.activity.id,
      requestId: input.activity.requestId,
    });
  }

  return records;
}

export function redactWebhookExportValue(value: unknown): unknown {
  return redactSecretsFromJsonlValue(value);
}

function normalizeWebhookEventExportPayload(
  rawPayload: unknown,
): NormalizedWebhookEventExportPayload {
  const payload = readObject(rawPayload);
  const webhookUrl = readWebhookUrl(payload.webhookUrl);
  const requestIds = Array.isArray(payload.requestIds)
    ? payload.requestIds.map((requestId) => readRequiredString(requestId, "requestIds[]"))
    : [];
  const from = readOptionalDate(payload.from, "from");
  const to = readOptionalDate(payload.to, "to");
  const limit = readOptionalPositiveInteger(payload.limit, defaultLimit);

  if (limit > maxLimit) {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      `Webhook export limit must be ${maxLimit} or lower.`,
    );
  }

  return {
    from,
    limit,
    requestIds,
    to,
    webhookUrl,
  };
}

function readWebhookUrl(value: unknown): string {
  const rawUrl = readRequiredString(value, "webhookUrl");
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      "Webhook export payload webhookUrl must be a valid URL.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      "Webhook export payload webhookUrl must use http or https.",
    );
  }

  return url.toString();
}

async function readWebhookEventExportInputs(
  client: PostgresClient,
  payload: NormalizedWebhookEventExportPayload,
): Promise<
  Array<{
    activity: WebhookEventExportActivity;
    fallbackEvents: WebhookEventExportFallback[];
  }>
> {
  const activities = await readWebhookEventExportActivities(client, payload);
  const fallbackEventsByActivityId = await readFallbackEventsByActivityId(
    client,
    activities.map((activity) => activity.id),
  );
  return activities.map((activity) => ({
    activity,
    fallbackEvents: fallbackEventsByActivityId.get(activity.id) ?? [],
  }));
}

async function readWebhookEventExportActivities(
  client: PostgresClient,
  payload: NormalizedWebhookEventExportPayload,
): Promise<WebhookEventExportActivity[]> {
  const values: unknown[] = [];
  const conditions: string[] = [];

  if (payload.requestIds.length > 0) {
    values.push(payload.requestIds);
    conditions.push(`request_activity.request_id = any($${values.length}::text[])`);
  }
  if (payload.from) {
    values.push(payload.from.toISOString());
    conditions.push(`request_activity.created_at >= $${values.length}::timestamptz`);
  }
  if (payload.to) {
    values.push(payload.to.toISOString());
    conditions.push(`request_activity.created_at < $${values.length}::timestamptz`);
  }
  values.push(payload.limit);

  const result = await client.query<WebhookEventExportActivityRow>(
    `
      select request_activity.id::text,
             request_activity.request_id,
             request_activity.agent_key_prefix as agent_key_prefix,
             request_activity.protocol,
             request_activity.model,
             request_activity.stream,
             request_activity.route_reason,
             request_activity.status,
             request_activity.error_code,
             request_activity.error_message,
             request_activity.http_status,
             request_activity.latency_ms,
             request_activity.started_at,
             request_activity.completed_at,
             coalesce(request_activity.virtual_model_name_snapshot, virtual_models.name)
               as virtual_model_name,
             coalesce(request_activity.provider_key_snapshot, providers.provider_key)
               as provider_key,
             coalesce(request_activity.provider_model_name_snapshot, provider_models.model_id)
               as provider_model_model_id
      from request_activity
      left join virtual_models on virtual_models.id = request_activity.virtual_model_id
      left join providers on providers.id = request_activity.provider_id
      left join provider_models on provider_models.id = request_activity.provider_model_id
      ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
      order by request_activity.created_at, request_activity.request_id
      limit $${values.length}::integer
    `,
    values,
  );

  return result.rows.map((row) => ({
    agentApiKeyPrefix: row.agent_key_prefix,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    httpStatus: row.http_status,
    id: row.id,
    latencyMs: row.latency_ms,
    model: row.model,
    protocol: row.protocol,
    providerKey: row.provider_key,
    providerModelModelId: row.provider_model_model_id,
    requestId: row.request_id,
    routeReason: row.route_reason,
    startedAt: row.started_at,
    status: row.status,
    stream: row.stream,
    virtualModelName: row.virtual_model_name,
  }));
}

async function readFallbackEventsByActivityId(
  client: PostgresClient,
  activityIds: string[],
): Promise<Map<string, WebhookEventExportFallback[]>> {
  const eventsByActivityId = new Map<string, WebhookEventExportFallback[]>();
  if (activityIds.length === 0) {
    return eventsByActivityId;
  }

  const result = await client.query<WebhookEventExportFallbackRow>(
    `
      select fallback_events.id::text,
             fallback_events.request_activity_id::text,
             fallback_events.attempt_order,
             fallback_events.status,
             fallback_events.error_code,
             fallback_events.error_message,
             fallback_events.failed_before_first_byte,
             fallback_events.created_at,
             provider_models.model_id as provider_model_model_id,
             providers.provider_key
      from fallback_events
      left join provider_models on provider_models.id = fallback_events.provider_model_id
      left join providers on providers.id = provider_models.provider_id
      where fallback_events.request_activity_id = any($1::uuid[])
      order by fallback_events.request_activity_id, fallback_events.attempt_order
    `,
    [activityIds],
  );

  for (const row of result.rows) {
    const event = {
      attemptOrder: row.attempt_order,
      createdAt: row.created_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      failedBeforeFirstByte: row.failed_before_first_byte,
      id: row.id,
      providerKey: row.provider_key,
      providerModelModelId: row.provider_model_model_id,
      status: row.status,
    };
    const events = eventsByActivityId.get(row.request_activity_id) ?? [];
    events.push(event);
    eventsByActivityId.set(row.request_activity_id, events);
  }

  return eventsByActivityId;
}

async function insertWebhookDelivery(
  client: PostgresClient,
  input: {
    completedAt: Date;
    fallbackEventId: string | null;
    jobId: string;
    record: WebhookEventExportRecord;
    requestActivityId: string;
    result: WebhookEventDeliveryResult;
    startedAt: Date;
    webhookUrl: string;
  },
): Promise<void> {
  await client.query(
    `
      insert into webhook_deliveries (
        id,
        job_id,
        event_type,
        request_activity_id,
        fallback_event_id,
        webhook_url,
        status,
        request_payload,
        response_status,
        response_body,
        error_code,
        error_message,
        started_at,
        completed_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
        $13::timestamptz, $14::timestamptz
      )
    `,
    [
      randomUUID(),
      input.jobId,
      input.record.eventType,
      input.requestActivityId,
      input.fallbackEventId,
      input.webhookUrl,
      input.result.status,
      JSON.stringify(input.record),
      input.result.responseStatus ?? null,
      truncateResponseBody(input.result.responseBody),
      input.result.status === "failed" ? input.result.errorCode : null,
      input.result.status === "failed" ? input.result.errorMessage : null,
      input.startedAt.toISOString(),
      input.completedAt.toISOString(),
    ],
  );
}

async function hasSuccessfulWebhookDelivery(
  client: PostgresClient,
  input: {
    fallbackEventId: string | null;
    jobId: string;
    record: WebhookEventExportRecord;
    requestActivityId: string;
  },
): Promise<boolean> {
  const result = await client.query(
    `
      select 1
      from webhook_deliveries
      where job_id = $1
        and event_type = $2
        and request_activity_id = $3
        and fallback_event_id is not distinct from $4::uuid
        and status = 'sent'
      limit 1
    `,
    [input.jobId, input.record.eventType, input.requestActivityId, input.fallbackEventId],
  );
  return result.rows.length > 0;
}

async function defaultDeliverWebhookEvent(
  input: WebhookEventDeliveryInput,
): Promise<WebhookEventDeliveryResult> {
  try {
    const response = await fetch(input.webhookUrl, {
      body: JSON.stringify(input.record),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const responseBody = truncateResponseBody(await response.text());

    if (response.ok) {
      return {
        responseBody,
        responseStatus: response.status,
        status: "sent",
      };
    }

    return {
      errorCode: "webhook_export_http_error",
      errorMessage: `Webhook export returned HTTP ${response.status}.`,
      responseBody,
      responseStatus: response.status,
      status: "failed",
    };
  } catch (error) {
    return {
      errorCode: "webhook_export_request_failed",
      errorMessage: error instanceof Error ? error.message : "Webhook export request failed.",
      responseStatus: null,
      status: "failed",
    };
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      `Webhook export payload ${fieldName} is required.`,
    );
  }
  return value.trim();
}

function readOptionalDate(value: unknown, fieldName: string): Date | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      `Webhook export payload ${fieldName} must be an ISO timestamp.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      `Webhook export payload ${fieldName} must be an ISO timestamp.`,
    );
  }
  return date;
}

function readOptionalPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new JobHandlerError(
      "webhook_export_invalid_payload",
      "Webhook export payload limit must be a positive integer.",
    );
  }
  return value;
}

function redactWebhookUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?redacted";
    }
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function truncateResponseBody(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, 2_000);
}

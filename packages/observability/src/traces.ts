import { randomBytes } from "node:crypto";

export type OpenTelemetrySpanKind = "client" | "internal" | "server";

export type TraceAttributeValue = boolean | number | string | null | undefined;

export type OpenTelemetrySpanInput = {
  attributes: Record<string, TraceAttributeValue>;
  endTimeUnixNano?: string;
  kind: OpenTelemetrySpanKind;
  name: string;
  spanId?: string;
  startTimeUnixNano?: string;
  traceId?: string;
};

export type OpenTelemetryTracePayloadInput = {
  serviceName: string;
  spans: OpenTelemetrySpanInput[];
};

export type RecordOpenTelemetrySpanInput = OpenTelemetrySpanInput & {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  serviceName: string;
};

const safeTraceAttributeKeys = new Set([
  "error.code",
  "http.status_code",
  "job.id",
  "job.type",
  "llmingress.model",
  "llmingress.provider",
  "llmingress.status",
  "request.id",
]);

export function buildOpenTelemetryTracePayload(input: OpenTelemetryTracePayloadInput) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: input.serviceName },
            },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "llmingress",
              version: "0.0.0",
            },
            spans: input.spans.map((span) => {
              const status = span.attributes["llmingress.status"];
              return {
                attributes: toOpenTelemetryAttributes(span.attributes),
                endTimeUnixNano: span.endTimeUnixNano ?? nowUnixNano(),
                kind: openTelemetrySpanKindValue(span.kind),
                name: span.name,
                spanId: span.spanId ?? randomHex(8),
                startTimeUnixNano: span.startTimeUnixNano ?? nowUnixNano(),
                status: {
                  code: status === "failed" ? 2 : 1,
                },
                traceId: span.traceId ?? randomHex(16),
              };
            }),
          },
        ],
      },
    ],
  };
}

export async function recordOpenTelemetrySpan(input: RecordOpenTelemetrySpanInput): Promise<void> {
  const env = input.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const exporter = env.OTEL_TRACES_EXPORTER?.trim();
  if (!endpoint || exporter === "none" || (exporter && exporter !== "otlp")) {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readTraceTimeoutMs(env));

  const payload = buildOpenTelemetryTracePayload({
    serviceName: input.serviceName,
    spans: [input],
  });

  try {
    await (input.fetch ?? globalThis.fetch)(endpoint, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
  } catch {
    // Tracing must never break Gateway or Worker request handling.
  } finally {
    clearTimeout(timeout);
  }
}

function toOpenTelemetryAttributes(attributes: Record<string, TraceAttributeValue>) {
  const result: Array<{
    key: string;
    value: ReturnType<typeof toOpenTelemetryAttributeValue>;
  }> = [];

  for (const [key, value] of Object.entries(attributes)) {
    if (!safeTraceAttributeKeys.has(key) || value === undefined) {
      continue;
    }
    result.push({
      key,
      value: toOpenTelemetryAttributeValue(value),
    });
  }

  return result;
}

function toOpenTelemetryAttributeValue(value: Exclude<TraceAttributeValue, undefined>) {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value === null) {
    return { stringValue: "" };
  }
  return { stringValue: value };
}

function openTelemetrySpanKindValue(kind: OpenTelemetrySpanKind): number {
  if (kind === "server") {
    return 2;
  }
  if (kind === "client") {
    return 3;
  }
  return 1;
}

function nowUnixNano(): string {
  return String(BigInt(Date.now()) * 1_000_000n);
}

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

function readTraceTimeoutMs(env: Record<string, string | undefined>): number {
  const value = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT_MS ?? 500);
  return Number.isInteger(value) && value > 0 ? value : 500;
}

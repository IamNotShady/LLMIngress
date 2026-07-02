import { recordOpenTelemetrySpan } from "./traces.ts";

export async function recordGatewayRequestTrace(input: {
  errorCode?: string | null;
  httpStatus: number;
  modelId?: string | null;
  providerKey?: string | null;
  protocol: string;
  requestId: string;
  startedAt: Date;
  status: "failed" | "succeeded";
}): Promise<void> {
  await recordOpenTelemetrySpan({
    attributes: {
      "error.code": input.errorCode,
      "http.status_code": input.httpStatus,
      "llmingress.model": input.modelId,
      "llmingress.provider": input.providerKey,
      "llmingress.status": input.status,
      "request.id": input.requestId,
    },
    endTimeUnixNano: dateToUnixNano(new Date()),
    kind: "server",
    name: "llmingress.gateway.request",
    serviceName: "llmingress-gateway",
    startTimeUnixNano: dateToUnixNano(input.startedAt),
  });
}

export async function recordGatewayProviderTrace(input: {
  errorCode?: string | null;
  modelId: string;
  providerKey: string;
  requestId?: string;
  startedAt: Date;
  status: "failed" | "succeeded";
}): Promise<void> {
  await recordOpenTelemetrySpan({
    attributes: {
      "error.code": input.errorCode,
      "llmingress.model": input.modelId,
      "llmingress.provider": input.providerKey,
      "llmingress.status": input.status,
      "request.id": input.requestId,
    },
    endTimeUnixNano: dateToUnixNano(new Date()),
    kind: "client",
    name: "llmingress.provider.request",
    serviceName: "llmingress-gateway",
    startTimeUnixNano: dateToUnixNano(input.startedAt),
  });
}

function dateToUnixNano(value: Date): string {
  return String(BigInt(value.getTime()) * 1_000_000n);
}

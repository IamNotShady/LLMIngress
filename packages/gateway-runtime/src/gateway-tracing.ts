import { recordOpenTelemetrySpan } from "@llmingress/db/traces";
import { runGatewayBackgroundTask } from "./gateway-background-tasks.ts";

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

export function recordGatewayProviderTrace(input: {
  errorCode?: string | null;
  modelId: string;
  providerKey: string;
  requestId?: string;
  startedAt: Date;
  status: "failed" | "succeeded";
}): void {
  runGatewayBackgroundTask({
    message: "gateway provider trace recording failed",
    metadata: {
      modelId: input.modelId,
      providerKey: input.providerKey,
      requestId: input.requestId,
    },
    task: () =>
      recordOpenTelemetrySpan({
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
      }),
  });
}

function dateToUnixNano(value: Date): string {
  return String(BigInt(value.getTime()) * 1_000_000n);
}

import { describe, expect, it } from "vitest";
import { buildOpenTelemetryTracePayload } from "../../packages/observability/src/traces";

describe("feat-093 opentelemetry tracing", () => {
  it("builds spans with request job provider model status and error code without prompt or key content", () => {
    const payload = buildOpenTelemetryTracePayload({
      serviceName: "llmingress-gateway",
      spans: [
        {
          attributes: {
            "api.key": "sk-secret-provider-093",
            "error.code": "provider_request_failed",
            "job.id": "job-trace-093",
            "llmingress.model": "gpt-4.1-mini",
            "llmingress.provider": "openai",
            "llmingress.status": "failed",
            "prompt.content": "secret prompt content",
            "request.id": "req_trace_093",
          },
          endTimeUnixNano: "2000000",
          kind: "server",
          name: "llmingress.gateway.request",
          spanId: "2222222222222222",
          startTimeUnixNano: "1000000",
          traceId: "11111111111111111111111111111111",
        },
      ],
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('"key":"request.id"');
    expect(serialized).toContain('"stringValue":"req_trace_093"');
    expect(serialized).toContain('"key":"job.id"');
    expect(serialized).toContain('"stringValue":"job-trace-093"');
    expect(serialized).toContain('"key":"llmingress.provider"');
    expect(serialized).toContain('"stringValue":"openai"');
    expect(serialized).toContain('"key":"llmingress.model"');
    expect(serialized).toContain('"stringValue":"gpt-4.1-mini"');
    expect(serialized).toContain('"key":"llmingress.status"');
    expect(serialized).toContain('"stringValue":"failed"');
    expect(serialized).toContain('"key":"error.code"');
    expect(serialized).toContain('"stringValue":"provider_request_failed"');
    expect(serialized).not.toContain("sk-secret-provider-093");
    expect(serialized).not.toContain("secret prompt content");
  });
});

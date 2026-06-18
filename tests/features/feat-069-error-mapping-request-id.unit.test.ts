import { describe, expect, it } from "vitest";
import {
  gatewayRequestIdHeader,
  mapGatewayErrorStatus,
  readGatewayErrorCode,
} from "../../apps/gateway/src/error-mapping";

describe("feat-069 Gateway error mapping and request id trace", () => {
  it("maps auth routing limit and provider errors to stable HTTP statuses", () => {
    expect(mapGatewayErrorStatus("missing_agent_api_key")).toBe(401);
    expect(mapGatewayErrorStatus("invalid_agent_api_key")).toBe(401);
    expect(mapGatewayErrorStatus("disabled_agent_api_key")).toBe(401);
    expect(mapGatewayErrorStatus("route_not_found")).toBe(404);
    expect(mapGatewayErrorStatus("rate_limit_exceeded")).toBe(429);
    expect(mapGatewayErrorStatus("cost_budget_exceeded")).toBe(402);
    expect(mapGatewayErrorStatus("provider_request_failed")).toBe(502);
    expect(mapGatewayErrorStatus("unknown_gateway_error", 500)).toBe(500);
  });

  it("extracts error codes and defines the public request id response header", () => {
    expect(gatewayRequestIdHeader).toBe("x-request-id");
    expect(
      readGatewayErrorCode({
        error: {
          code: "route_not_found",
          message: "No route policy is available.",
        },
        requestId: "req_error_mapping_unit",
      }),
    ).toBe("route_not_found");
    expect(readGatewayErrorCode({ error: { message: "missing code" } })).toBeNull();
  });
});

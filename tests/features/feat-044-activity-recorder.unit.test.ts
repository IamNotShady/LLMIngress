import { describe, expect, it } from "vitest";
import {
  buildGatewayActivityCompletion,
  readGatewayActivityError,
} from "../../apps/gateway/src/activity-recorder";

describe("feat-044 request activity recorder", () => {
  it("builds successful activity completion metadata with latency", () => {
    expect(
      buildGatewayActivityCompletion({
        completedAt: new Date("2026-06-14T12:00:01.250Z"),
        responseBody: { id: "response" },
        startedAt: new Date("2026-06-14T12:00:00.000Z"),
        statusCode: 200,
      }),
    ).toEqual({
      completedAt: new Date("2026-06-14T12:00:01.250Z"),
      errorCode: null,
      errorMessage: null,
      httpStatus: 200,
      latencyMs: 1250,
      status: "succeeded",
    });
  });

  it("extracts failed activity error code and message from stable Gateway error bodies", () => {
    const responseBody = {
      error: {
        code: "provider_request_failed",
        message: "Provider request failed.",
      },
      requestId: "req_activity_failure",
    };

    expect(readGatewayActivityError(responseBody)).toEqual({
      errorCode: "provider_request_failed",
      errorMessage: "Provider request failed.",
    });
    expect(
      buildGatewayActivityCompletion({
        completedAt: new Date("2026-06-14T12:00:00.500Z"),
        responseBody,
        startedAt: new Date("2026-06-14T12:00:00.000Z"),
        statusCode: 502,
      }),
    ).toEqual({
      completedAt: new Date("2026-06-14T12:00:00.500Z"),
      errorCode: "provider_request_failed",
      errorMessage: "Provider request failed.",
      httpStatus: 502,
      latencyMs: 500,
      status: "failed",
    });
  });
});

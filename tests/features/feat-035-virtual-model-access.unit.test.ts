import { describe, expect, it } from "vitest";
import {
  createGatewayVirtualModelAccessErrorBody,
  resolveGatewayVirtualModelRequest,
} from "../../packages/db/src/gateway-virtual-model-access";

describe("feat-035 gateway virtual model access contract", () => {
  const allowedVirtualModels = [
    { displayName: "Coding Fast", id: "vm-fast", name: "coding-fast" },
    { displayName: "Coding Strong", id: "vm-strong", name: "coding-strong" },
  ];

  it("allows explicitly requested Virtual Models from the Agent API key allow-list", () => {
    expect(
      resolveGatewayVirtualModelRequest({
        allowedVirtualModels,
        defaultVirtualModelId: "vm-fast",
        requestedModelName: "coding-strong",
        requestId: "req_allowed",
      }),
    ).toEqual({
      ok: true,
      requestId: "req_allowed",
      virtualModel: allowedVirtualModels[1],
    });
  });

  it("returns stable errors for disallowed and missing-default requests", () => {
    expect(
      resolveGatewayVirtualModelRequest({
        allowedVirtualModels,
        defaultVirtualModelId: "vm-fast",
        requestedModelName: "blocked-model",
        requestId: "req_blocked",
      }),
    ).toEqual({
      body: createGatewayVirtualModelAccessErrorBody("virtual_model_not_allowed", "req_blocked"),
      ok: false,
      statusCode: 403,
    });

    expect(
      resolveGatewayVirtualModelRequest({
        allowedVirtualModels,
        defaultVirtualModelId: null,
        requestedModelName: null,
        requestId: "req_missing",
      }),
    ).toEqual({
      body: createGatewayVirtualModelAccessErrorBody("missing_model", "req_missing"),
      ok: false,
      statusCode: 400,
    });
  });
});

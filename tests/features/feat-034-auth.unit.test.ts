import { describe, expect, it } from "vitest";
import {
  buildGatewayAgentApiKeyHash,
  createGatewayAuthErrorBody,
  readGatewayApiKeyCredential,
} from "../../apps/gateway/src/auth";

describe("feat-034 gateway API key authentication", () => {
  it("reads Agent API keys from bearer auth or x-api-key headers", () => {
    expect(readGatewayApiKeyCredential({ authorization: "Bearer llmi_valid" })).toBe("llmi_valid");
    expect(readGatewayApiKeyCredential({ "x-api-key": "llmi_header" })).toBe("llmi_header");
    expect(readGatewayApiKeyCredential({ authorization: "Basic nope" })).toBeNull();
  });

  it("hashes Agent API key plaintext with the Gateway-compatible sha256 scheme", () => {
    expect(buildGatewayAgentApiKeyHash("llmi_test_plaintext")).toBe(
      "sha256:v1:Utr-e1BHZVvSdg3ek7N_UAG6oQ93m9M5aBwtHvGQpaI",
    );
  });

  it("builds stable 401 error bodies with request id", () => {
    expect(createGatewayAuthErrorBody("missing_agent_api_key", "req_034")).toEqual({
      error: {
        code: "missing_agent_api_key",
        message: "Agent API key is required.",
      },
      requestId: "req_034",
    });
  });
});

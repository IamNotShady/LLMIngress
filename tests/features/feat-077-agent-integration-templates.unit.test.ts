import { describe, expect, it } from "vitest";
import { buildAgentConnectionDetails } from "../../apps/console/src/server/agent-integrations";

describe("feat-077 agent connection details", () => {
  it("builds one normalized connection details group with gateway url api key and model", () => {
    const details = buildAgentConnectionDetails({
      apiKey: "llmi_secret_agent_key_077",
      gatewayBaseUrl: " http://127.0.0.1:4100/ ",
      model: "coding-fast",
    });

    expect(details).toEqual({
      apiKey: "llmi_secret_agent_key_077",
      gatewayBaseUrl: "http://127.0.0.1:4100",
      model: "coding-fast",
    });
  });
});

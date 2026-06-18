import { describe, expect, it } from "vitest";
import type { AgentApiKeyVirtualModelAccess } from "../../apps/console/src/server/agent-api-keys";
import {
  buildAgentIntegrationTemplates,
  formatDashboardAgentApiKeySnippetValue,
  resolveAgentIntegrationModelName,
} from "../../apps/console/src/server/agent-integrations";

describe("feat-077 agent integration templates", () => {
  it("builds codex claude code cursor and openclaw snippets with gateway url api key and model", () => {
    const templates = buildAgentIntegrationTemplates({
      apiKey: "llmi_secret_agent_key_077",
      gatewayBaseUrl: " http://127.0.0.1:4100/ ",
      model: "coding-fast",
    });

    expect(templates.map((template) => template.displayName)).toEqual([
      "Codex",
      "Claude Code",
      "Cursor",
      "OpenClaw",
    ]);

    for (const template of templates) {
      expect(template.snippet).toContain("Gateway URL: http://127.0.0.1:4100");
      expect(template.snippet).toContain("API key: llmi_secret_agent_key_077");
      expect(template.snippet).toContain("Model: coding-fast");
    }
  });

  it("resolves the default virtual model before allowed models and then falls back to a placeholder", () => {
    expect(
      resolveAgentIntegrationModelName(
        access({
          allowedVirtualModels: [
            { displayName: "Allowed VM", id: "allowed-vm", name: "allowed-vm" },
          ],
          defaultVirtualModel: {
            displayName: "Default VM",
            id: "default-vm",
            name: "default-vm",
          },
        }),
      ),
    ).toBe("default-vm");

    expect(
      resolveAgentIntegrationModelName(
        access({
          allowedVirtualModels: [
            { displayName: "Allowed VM", id: "allowed-vm", name: "allowed-vm" },
          ],
          defaultVirtualModel: null,
        }),
      ),
    ).toBe("allowed-vm");

    expect(
      resolveAgentIntegrationModelName(
        access({
          allowedVirtualModels: [],
          defaultVirtualModel: null,
        }),
      ),
    ).toBe("<Virtual Model Name>");
  });

  it("uses a dashboard api key placeholder with the stored prefix instead of plaintext", () => {
    const placeholder = formatDashboardAgentApiKeySnippetValue("llmi_prefix1");

    expect(placeholder).toBe("paste one-time Agent API key for prefix llmi_prefix1");
    expect(placeholder).not.toContain("llmi_secret_agent_key_077");
  });
});

function access(
  input: Omit<AgentApiKeyVirtualModelAccess, "agentApiKeyId">,
): AgentApiKeyVirtualModelAccess {
  return {
    agentApiKeyId: "agent-api-key-077",
    ...input,
  };
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAgentConfigurationGuide,
  renderOneTimeAgentResponse,
} from "../../apps/console/src/app/api/agents/_created-page.ts";
import {
  agentIntegrationPlatforms,
  normalizeAgentVirtualModelSelectionInput,
} from "../../packages/db/src/console-agents.ts";
import { enforceGatewayAgentLimitsIfEnabled } from "../../packages/gateway-runtime/src/gateway-agent-limits.ts";

describe("agent management contract", () => {
  it("requires at least one allowed Virtual Model", () => {
    expect(() =>
      normalizeAgentVirtualModelSelectionInput({
        allowedVirtualModelIds: [],
        defaultVirtualModelId: null,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "agent_allowed_virtual_model_required",
      }),
    );
  });

  it("builds local configuration guidance for every Integration Platform", () => {
    for (const integrationPlatform of agentIntegrationPlatforms) {
      const guide = buildAgentConfigurationGuide({
        apiKey: "llmi_test_agent_key",
        gatewayBaseUrl: "http://localhost:4000",
        integrationPlatform,
        model: "agent-test-vm",
      });

      expect(guide.title).toBeTruthy();
      expect(guide.steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(guide)).toContain("http://localhost:4000");
    }
  });

  it("escapes connection values in shell, config, and HTML guidance", async () => {
    const guide = buildAgentConfigurationGuide({
      apiKey: "llmi_test'key",
      gatewayBaseUrl: "https://gateway.example.test/root/",
      integrationPlatform: "codex",
      model: 'model"\nnext',
    });

    expect(guide.codeBlocks[0]?.code).toContain("'llmi_test'\\''key'");
    expect(guide.codeBlocks[1]?.code).toContain('model = "model\\"\\nnext"');
    expect(guide.codeBlocks[1]?.code).toContain(
      'base_url = "https://gateway.example.test/root/v1"',
    );

    const response = renderOneTimeAgentResponse(
      {
        integrationPlatform: "other",
        keyPrefix: "llmi_test",
        plaintext: "llmi_<script>alert('x')</script>",
        virtualModelName: '<img src=x onerror="alert(1)">',
      },
      "html",
    );
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("does not read or enforce Agent limits when the Agent switch is off", async () => {
    await expect(
      enforceGatewayAgentLimitsIfEnabled({
        agentId: "00000000-0000-0000-0000-000000000001",
        databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
        limitsEnabled: false,
        requestId: "gw_agent_limits_disabled",
        requestMetadata: {
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("removes derived Agent status and exposes explicit Enabled and Virtual Models columns", () => {
    const agentsDb = readFileSync("packages/db/src/console-agents.ts", "utf8");
    const agentsUi = readFileSync("apps/console/src/app/_modules/agents-section.tsx", "utf8");

    expect(agentsDb).not.toContain("AgentDerivedStatus");
    expect(agentsDb).not.toContain("deriveAgentStatus");
    expect(agentsDb).not.toContain("unhealthy_reachable_provider_count");
    expect(agentsUi).not.toContain("agentStatusFilter");
    expect(agentsUi).not.toContain("<th>Status</th>");
    expect(agentsUi).not.toContain("Available VM");
    expect(agentsUi).toContain("<th>Virtual Models</th>");
    expect(agentsUi).toContain("<th>Enabled</th>");
    expect(agentsUi).toContain('value="enable"');
    expect(agentsUi).toContain('value="disable"');
  });
});

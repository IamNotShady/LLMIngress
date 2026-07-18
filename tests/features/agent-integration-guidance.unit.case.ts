import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_API_KEY_PLACEHOLDER,
  agentEndpointPathByProtocol,
  agentIntegrationGuidePlatforms,
  buildAgentIntegrationGuides,
  groupAgentVirtualModelEndpoints,
} from "../../apps/console/src/app/_modules/agent-integration-guide.ts";
import { renderOneTimeAgentResponse } from "../../apps/console/src/app/api/agents/_created-page.ts";
import {
  agentIntegrationPlatforms,
  listAgentVirtualModelAccess,
} from "../../packages/db/src/console-agents.ts";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index.ts";

describe("agent integration guidance", () => {
  it("builds guides for every Integration Platform with the key placeholder", () => {
    expect([...agentIntegrationGuidePlatforms]).toEqual([...agentIntegrationPlatforms]);

    const guides = buildAgentIntegrationGuides({
      apiKey: AGENT_API_KEY_PLACEHOLDER,
      gatewayBaseUrl: "http://127.0.0.1:4000",
      model: "guide-vm",
    });

    expect(guides.map((entry) => entry.platform)).toEqual([...agentIntegrationPlatforms]);
    expect(guides.map((entry) => entry.label)).toEqual([
      "Codex",
      "Claude Code",
      "Cursor",
      "OpenCode",
      "Hermes",
      "OpenClaw",
      "GitHub Copilot",
      "Other",
    ]);
    for (const entry of guides) {
      expect(entry.guide.title).toBeTruthy();
      expect(entry.guide.steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(entry.guide)).toContain("http://127.0.0.1:4000");
    }
    // OpenCode stores the key via /connect; every other platform must surface
    // the placeholder literally.
    for (const platform of [
      "codex",
      "claude-code",
      "cursor",
      "hermes",
      "openclaw",
      "github-copilot",
      "other",
    ]) {
      const entry = guides.find((candidate) => candidate.platform === platform);
      expect(JSON.stringify(entry?.guide), platform).toContain(AGENT_API_KEY_PLACEHOLDER);
    }
  });

  it("maps endpoint protocols to real Gateway paths and groups Virtual Models", () => {
    const gatewaySource = readFileSync("apps/gateway/src/main.ts", "utf8");
    for (const path of Object.values(agentEndpointPathByProtocol)) {
      expect(gatewaySource).toContain(`"${path}"`);
    }

    const groups = groupAgentVirtualModelEndpoints({
      gatewayBaseUrl: "http://127.0.0.1:4000/",
      virtualModels: [
        { displayName: "A", endpointProtocol: "messages", id: "vm-a", name: "vm-a" },
        { displayName: "B", endpointProtocol: "chat_completions", id: "vm-b", name: "vm-b" },
        { displayName: "C", endpointProtocol: "chat_completions", id: "vm-c", name: "vm-c" },
        { displayName: "D", endpointProtocol: null, id: "vm-d", name: "vm-d" },
      ],
    });

    expect(groups.configured).toEqual([
      {
        protocol: "chat_completions",
        url: "http://127.0.0.1:4000/v1/chat/completions",
        virtualModels: [
          expect.objectContaining({ name: "vm-b" }),
          expect.objectContaining({ name: "vm-c" }),
        ],
      },
      {
        protocol: "messages",
        url: "http://127.0.0.1:4000/v1/messages",
        virtualModels: [expect.objectContaining({ name: "vm-a" })],
      },
    ]);
    expect(groups.unrouted).toEqual([expect.objectContaining({ name: "vm-d" })]);
  });

  it("returns each allowed Virtual Model's route endpoint protocol from agent access", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_agent_guide_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const agentId = randomUUID();
      const routedVmId = randomUUID();
      const unroutedVmId = randomUUID();
      await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
        await client.query(
          `insert into virtual_models (id, name, description, enabled)
           values ($1, 'guide-routed-vm', 'Routed VM', true),
                  ($2, 'guide-unrouted-vm', 'Unrouted VM', true)`,
          [routedVmId, unroutedVmId],
        );
        await client.query(
          `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
           values ($1, $2, 'fixed', 'messages')`,
          [randomUUID(), routedVmId],
        );
        await client.query(
          `insert into agents (id, name, default_virtual_model_id)
           values ($1, 'guide-access-agent', $2)`,
          [agentId, routedVmId],
        );
        await client.query(
          `insert into agent_virtual_models (agent_id, virtual_model_id)
           values ($1, $2), ($1, $3)`,
          [agentId, routedVmId, unroutedVmId],
        );
      });

      const access = await listAgentVirtualModelAccess(fixture.databaseUrl);
      const agentAccess = access.find((entry) => entry.agentId === agentId);
      expect(agentAccess?.allowedVirtualModels).toEqual([
        expect.objectContaining({ endpointProtocol: "messages", name: "guide-routed-vm" }),
        expect.objectContaining({ endpointProtocol: null, name: "guide-unrouted-vm" }),
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("removes the Integration Platform field from Agent UI and API surfaces", () => {
    const agentsUi = readFileSync("apps/console/src/app/_modules/agents-section.tsx", "utf8");
    const agentsRoute = readFileSync("apps/console/src/app/api/agents/route.ts", "utf8");
    const mutationFailure = readFileSync(
      "apps/console/src/app/_components/console-mutation-failure.ts",
      "utf8",
    );

    expect(agentsUi).not.toContain('name="integrationPlatform"');
    expect(agentsUi).not.toContain("agentPlatform");
    expect(agentsUi).not.toContain("<dt>Platform</dt>");
    expect(agentsUi).not.toContain("agent-filter-platform");
    expect(agentsUi).toContain("AgentIntegrationGuideTabs");
    expect(agentsUi).toContain("<h3>Endpoints</h3>");
    expect(agentsRoute).not.toContain("integrationPlatform");
    expect(mutationFailure).not.toContain("agent_integration_platform_invalid");
  });

  it("lists every platform guide on the one-time created page fallback", async () => {
    const response = renderOneTimeAgentResponse(
      {
        keyPrefix: "llmi_test_key",
        plaintext: "llmi_test_key_value",
        virtualModelName: "guide-vm",
      },
      "html",
    );
    const html = await response.text();
    for (const title of [
      "Configure Codex",
      "Configure Claude Code",
      "Configure Cursor",
      "Configure OpenCode",
      "Configure Hermes",
      "Configure OpenClaw",
      "Configure GitHub Copilot",
      "Configure your integration",
    ]) {
      expect(html).toContain(title);
    }
  });
});

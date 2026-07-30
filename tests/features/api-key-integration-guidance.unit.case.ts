import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildIntegrationGuides,
  endpointPathByProtocol,
  groupVirtualModelEndpoints,
  integrationGuidePlatforms,
} from "../../apps/console/src/app/_ui/api-keys/integration-guide.ts";

import { renderOneTimeApiKeyResponse } from "../../apps/console/src/app/api/api-keys/_created-page.ts";
import { listApiKeyVirtualModelAccess } from "../../packages/db/src/console-api-keys.ts";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index.ts";

/**
 * What the key's own dialog passes: the stored prefix, because the secret was
 * shown once. Every guide that names a key must carry it through verbatim.
 */
const KEY_STAND_IN = "llmi_stand_in…";

describe("apiKey integration guidance", () => {
  it("builds guides for every Integration Platform with the key it was given", () => {
    expect([...integrationGuidePlatforms]).toEqual([
      "codex",
      "claude-code",
      "cursor",
      "opencode",
      "hermes",
      "openclaw",
      "github-copilot",
      "other",
    ]);

    const guides = buildIntegrationGuides({
      apiKey: KEY_STAND_IN,
      gatewayBaseUrl: "http://127.0.0.1:4000",
      model: "guide-vm",
    });

    expect(guides.map((entry) => entry.platform)).toEqual([...integrationGuidePlatforms]);
    expect(guides.map((entry) => entry.label)).toEqual([
      "Codex",
      "Claude Code",
      "Cursor",
      "OpenCode",
      "Hermes",
      "OpenClaw",
      "GitHub Copilot",
      "Other / curl",
    ]);
    for (const entry of guides) {
      expect(entry.guide.title).toBeTruthy();
      expect(entry.guide.steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(entry.guide)).toContain("http://127.0.0.1:4000");
      // Which endpoint the agent speaks is a precondition, not a step: it
      // decides how the virtual model must be routed before any of this works.
      expect(entry.guide.note ?? "", entry.platform).toContain("/v1/");
    }
    // OpenCode stores the key via /connect; every other platform must surface
    // the key it was handed literally.
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
      expect(JSON.stringify(entry?.guide), platform).toContain(KEY_STAND_IN);
    }
  });

  it("maps endpoint protocols to real Gateway paths and groups Virtual Models", () => {
    const gatewaySource = readFileSync("apps/gateway/src/main.ts", "utf8");
    for (const path of Object.values(endpointPathByProtocol)) {
      expect(gatewaySource).toContain(`"${path}"`);
    }

    const groups = groupVirtualModelEndpoints({
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

  it("returns each allowed Virtual Model's route endpoint protocol from apiKey access", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_api_key_guide_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const apiKeyId = randomUUID();
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
          `insert into api_keys (id, name, key_prefix, key_hash, default_virtual_model_id)
           values ($1, 'guide-access-apiKey', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, $2)`,
          [apiKeyId, routedVmId],
        );
        await client.query(
          `insert into api_key_virtual_models (api_key_id, virtual_model_id)
           values ($1, $2), ($1, $3)`,
          [apiKeyId, routedVmId, unroutedVmId],
        );
      });

      const access = await listApiKeyVirtualModelAccess(fixture.databaseUrl);
      const apiKeyAccess = access.find((entry) => entry.apiKeyId === apiKeyId);
      expect(apiKeyAccess?.allowedVirtualModels).toEqual([
        expect.objectContaining({ endpointProtocol: "messages", name: "guide-routed-vm" }),
        expect.objectContaining({ endpointProtocol: null, name: "guide-unrouted-vm" }),
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("removes the Integration Platform field from ApiKey UI and API surfaces", () => {
    const apiKeysRoute = readFileSync("apps/console/src/app/api/api-keys/route.ts", "utf8");
    const detail = readFileSync("apps/console/src/app/_ui/api-keys/detail.tsx", "utf8");
    const dialogs = readFileSync("apps/console/src/app/_ui/api-keys/dialogs.tsx", "utf8");
    // A key is not bound to one platform: every guide is offered on the page
    // that shows the secret, and no platform is stored against the key.
    const createdPage = readFileSync("apps/console/src/app/api/api-keys/_created-page.ts", "utf8");

    for (const [label, source] of [
      ["api-key detail", detail],
      ["api-key dialogs", dialogs],
      ["created page", createdPage],
    ] as const) {
      expect(source, label).not.toContain('name="integrationPlatform"');
      expect(source, label).not.toContain("apiKeyPlatform");
    }
    expect(createdPage).toContain("buildIntegrationGuides");
    expect(createdPage).toContain("SET UP YOUR AGENT");
    expect(apiKeysRoute).not.toContain("integrationPlatform");
  });

  it("lists every platform guide on the one-time created page fallback", async () => {
    const response = renderOneTimeApiKeyResponse(
      {
        createdAt: new Date("2026-07-18T00:00:00.000Z"),
        defaultVirtualModelName: "guide-vm",
        enabled: true,
        keyPrefix: "llmi_test_key",
        limits: [],
        name: "guide-apiKey",
        plaintext: "llmi_test_key_value",
        virtualModelName: "guide-vm",
        virtualModels: [],
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

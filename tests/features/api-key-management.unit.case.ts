import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildConfigurationGuide,
  integrationGuidePlatforms,
} from "../../apps/console/src/app/_modules/api-key-integration-guide.ts";
import { renderOneTimeApiKeyResponse } from "../../apps/console/src/app/api/api-keys/_created-page.ts";
import { normalizeApiKeyVirtualModelSelectionInput } from "../../packages/db/src/console-api-keys.ts";
import { enforceGatewayApiKeyLimitsIfEnabled } from "../../packages/gateway-runtime/src/gateway-api-key-limits.ts";

describe("apiKey management contract", () => {
  it("requires at least one allowed Virtual Model", () => {
    expect(() =>
      normalizeApiKeyVirtualModelSelectionInput({
        allowedVirtualModelIds: [],
        defaultVirtualModelId: null,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "api_key_allowed_virtual_model_required",
      }),
    );
  });

  it("builds local configuration guidance for every Integration Platform", () => {
    for (const integrationPlatform of integrationGuidePlatforms) {
      const guide = buildConfigurationGuide({
        apiKey: "llmi_test_api_key",
        gatewayBaseUrl: "http://localhost:4000",
        integrationPlatform,
        model: "api-key-test-vm",
      });

      expect(guide.title).toBeTruthy();
      expect(guide.steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(guide)).toContain("http://localhost:4000");
    }
  });

  it("escapes connection values in shell, config, and HTML guidance", async () => {
    const guide = buildConfigurationGuide({
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

    const response = renderOneTimeApiKeyResponse(
      {
        createdAt: new Date("2026-07-18T00:00:00.000Z"),
        defaultVirtualModelName: null,
        enabled: true,
        keyPrefix: "llmi_test",
        limits: [],
        name: "xss-probe-apiKey",
        plaintext: "llmi_<script>alert('x')</script>",
        virtualModelName: '<img src=x onerror="alert(1)">',
        virtualModels: [],
      },
      "html",
    );
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("does not read or enforce ApiKey limits when the ApiKey switch is off", async () => {
    await expect(
      enforceGatewayApiKeyLimitsIfEnabled({
        apiKeyId: "00000000-0000-0000-0000-000000000001",
        databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
        limitsEnabled: false,
        requestId: "gw_api_key_limits_disabled",
        requestMetadata: {
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("removes derived ApiKey status and exposes explicit Enabled and Virtual Models columns", () => {
    const apiKeysDb = readFileSync("packages/db/src/console-api-keys.ts", "utf8");
    const apiKeysUi = readFileSync("apps/console/src/app/_modules/api-keys-section.tsx", "utf8");

    expect(apiKeysDb).not.toContain("ApiKeyDerivedStatus");
    expect(apiKeysDb).not.toContain("deriveApiKeyStatus");
    expect(apiKeysDb).not.toContain("unhealthy_reachable_provider_count");
    expect(apiKeysUi).not.toContain("apiKeyStatusFilter");
    expect(apiKeysUi).not.toContain("<th>Status</th>");
    expect(apiKeysUi).not.toContain("Available VM");
    expect(apiKeysUi).toContain("<th>Virtual Models</th>");
    expect(apiKeysUi).toContain("<th>Enabled</th>");
    expect(apiKeysUi).toContain('value="enable"');
    expect(apiKeysUi).toContain('value="disable"');
  });
});

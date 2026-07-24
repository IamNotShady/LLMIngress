import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listPriceSyncSupportedProviderKeys,
  resolveProviderDescriptor,
} from "../../packages/provider/src/descriptor.ts";

describe("provider descriptors", () => {
  it("resolves descriptors with defaults for unknown providers", () => {
    expect(resolveProviderDescriptor("claude_code")).toMatchObject({
      metadataKey: "anthropic",
      subscription: true,
      subscriptionAdapter: "claude_code",
    });
    expect(resolveProviderDescriptor("minimax_coding")).toMatchObject({
      metadataKey: "minimax",
      subscription: true,
      subscriptionAdapter: "minimax_anthropic",
    });
    expect(resolveProviderDescriptor("OpenRouter")).toMatchObject({
      fixedApiKeyBaseUrl: "https://openrouter.ai/api/v1",
      openRouterAttribution: true,
    });
    expect(resolveProviderDescriptor("some-custom-provider")).toEqual({});
    expect(resolveProviderDescriptor(null)).toEqual({});
  });

  it("derives the price sync allowlist from descriptors", () => {
    expect(listPriceSyncSupportedProviderKeys().sort()).toEqual([
      "anthropic",
      "bedrock",
      "cerebras",
      "cline_pass",
      "deepseek",
      "fireworks",
      "google",
      "groq",
      "llama_cpp",
      "lmstudio",
      "minimax",
      "mistral",
      "moonshot",
      "nvidia",
      "ollama",
      "openai",
      "openrouter",
      "qwen",
      "xai",
      "xiaomi",
      "zai",
    ]);
  });

  it("leaves no providerKey string dispatch in consumer files", () => {
    const files = [
      "packages/provider/src/model-list.ts",
      "packages/provider/src/connectivity.ts",
      "packages/provider/src/subscription.ts",
      "packages/provider/src/oauth.ts",
      "packages/gateway-runtime/src/gateway-chat-completions.ts",
      "packages/gateway-runtime/src/gateway-messages.ts",
      "packages/gateway-runtime/src/gateway-responses.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/providerKey(\?\.toLowerCase\(\))? === "/);
      expect(source).not.toMatch(/providerKey\.toLowerCase\(\) === "/);
    }
    const modelRefresh = readFileSync(
      "packages/worker-runtime/src/worker-model-refresh.ts",
      "utf8",
    );
    expect(modelRefresh).not.toContain('normalized === "claude_code"');
    expect(modelRefresh).not.toContain("localProviderKeys");
    const consoleProviders = readFileSync("packages/db/src/console-providers.ts", "utf8");
    expect(consoleProviders).not.toContain("fixedApiKeyProviderBaseUrls");
    const priceSource = readFileSync("packages/provider/src/price-source.ts", "utf8");
    expect(priceSource).not.toMatch(/const supportedProviderKeys = new Set\(\[/);
  });

  it("keeps model list request building behavior per style", async () => {
    const { buildProviderModelListRequest } = await import(
      "../../packages/provider/src/model-list.ts"
    );
    const anthropic = buildProviderModelListRequest({
      apiKey: "k",
      baseUrl: "https://api.anthropic.com/v1",
      providerKey: "anthropic",
    });
    expect(anthropic.init.headers).toMatchObject({ "x-api-key": "k" });
    const openrouter = buildProviderModelListRequest({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      providerKey: "openrouter",
    });
    expect(openrouter.init.headers).toMatchObject({ authorization: "Bearer k" });
    expect(openrouter.init.headers).toHaveProperty("HTTP-Referer");
    const generic = buildProviderModelListRequest({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com/v1",
      providerKey: "deepseek",
    });
    expect(generic.init.headers).toEqual({ authorization: "Bearer k" });
  });
});

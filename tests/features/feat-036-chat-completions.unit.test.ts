import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachGatewayProviderCredentials,
  createGatewayChatCompletionErrorBody,
  normalizeOpenAIChatCompletionRequest,
  readGatewayMasterKeySource,
} from "../../apps/gateway/src/chat-completions";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

describe("feat-036 OpenAI chat completions endpoint", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestPostgresFixture>>> = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("normalizes OpenAI chat completion payloads for provider adapters", () => {
    expect(
      normalizeOpenAIChatCompletionRequest(
        {
          max_tokens: 256,
          messages: [
            { content: "You are concise.", role: "system" },
            { content: "Say hi.", role: "user" },
          ],
          model: "coding-fast",
          stream: false,
          temperature: 0.2,
        },
        "req_chat_unit",
      ),
    ).toEqual({
      ok: true,
      request: {
        maxOutputTokens: 256,
        messages: [
          { content: "You are concise.", role: "system" },
          { content: "Say hi.", role: "user" },
        ],
        stream: false,
        temperature: 0.2,
      },
    });
  });

  it("returns stable 400 errors for invalid chat completion payloads", () => {
    expect(normalizeOpenAIChatCompletionRequest({ messages: [] }, "req_invalid_unit")).toEqual({
      body: createGatewayChatCompletionErrorBody("invalid_chat_request", "req_invalid_unit"),
      ok: false,
      statusCode: 400,
    });
  });

  it("caps oversized max_tokens from OpenAI-compatible clients", () => {
    expect(
      normalizeOpenAIChatCompletionRequest(
        {
          max_tokens: 65_536,
          messages: [{ content: "hello", role: "user" }],
          model: "mix",
        },
        "req_oversized_tokens",
      ),
    ).toMatchObject({
      ok: true,
      request: {
        maxOutputTokens: 16_384,
      },
    });
  });

  it("reads the Gateway master key source from process-style env", () => {
    expect(readGatewayMasterKeySource({ MASTER_KEY: "inline-master-key" })).toEqual({
      kind: "inline",
      value: "inline-master-key",
    });
    expect(readGatewayMasterKeySource({ MASTER_KEY_FILE: "/tmp/master-key" })).toEqual({
      kind: "file",
      path: "/tmp/master-key",
    });
  });

  it("attaches local provider credentials without a stored API key", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_chat_local_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const providerId = randomUUID();
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'ollama', 'Ollama', 'http://127.0.0.1:11434/v1', true)
      `,
      [providerId],
    );

    await expect(
      attachGatewayProviderCredentials({
        candidates: [
          {
            candidateOrder: 1,
            displayName: "llama3.2:3b",
            isFallback: false,
            modelId: "llama3.2:3b",
            price: { inputUsdPerMillionTokens: null, outputUsdPerMillionTokens: null },
            providerId,
            providerKey: "ollama",
            providerModelId: randomUUID(),
          },
        ],
        databaseUrl: fixture.databaseUrl,
        masterKeySource: { kind: "inline", value: "chat-local-master-key" },
      }),
    ).resolves.toMatchObject([
      {
        apiKey: "",
        baseUrl: "http://127.0.0.1:11434/v1",
        providerApiKeyId: undefined,
        providerApiKeyPrefix: undefined,
      },
    ]);
  });
});

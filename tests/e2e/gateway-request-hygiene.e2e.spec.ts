import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const agentApiKey = "llmi_gateway_request_hygiene_key_094";

test("gateway accepts large bodies, protects metrics, and passes chat parameters through", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_hygiene_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-request-hygiene",
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_METRICS_TOKEN: "metrics-token" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const unauthorizedMetrics = await fetch(`${baseUrl}/metrics`);
      expect(unauthorizedMetrics.status).toBe(401);

      const authorizedMetrics = await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: "Bearer metrics-token" },
      });
      expect(authorizedMetrics.status).toBe(200);

      const largeMessage = "x".repeat(2 * 1024 * 1024);
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          max_completion_tokens: 64,
          max_tokens: 12,
          messages: [{ content: largeMessage, role: "user" }],
          metadata: { trace: "chat" },
          model: "vm-request-hygiene",
          modalities: ["text"],
          prediction: { content: "expected", type: "content" },
          seed: 7,
          stop: ["END"],
          stream_options: { include_usage: true },
          top_p: 0.9,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(fakeProvider.requests).toHaveLength(1);
      const providerBody = fakeProvider.requests[0]?.bodyJson;
      expect(isRecord(providerBody) ? providerBody.max_completion_tokens : undefined).toBe(64);
      expect(isRecord(providerBody) ? providerBody.max_tokens : undefined).toBe(12);
      expect(isRecord(providerBody) ? providerBody.metadata : undefined).toEqual({ trace: "chat" });
      expect(isRecord(providerBody) ? providerBody.modalities : undefined).toEqual(["text"]);
      expect(isRecord(providerBody) ? providerBody.prediction : undefined).toEqual({
        content: "expected",
        type: "content",
      });
      expect(isRecord(providerBody) ? providerBody.seed : undefined).toBe(7);
      expect(isRecord(providerBody) ? providerBody.stop : undefined).toEqual(["END"]);
      expect(isRecord(providerBody) ? providerBody.stream_options : undefined).toEqual({
        include_usage: true,
      });
      expect(isRecord(providerBody) ? providerBody.top_p : undefined).toBe(0.9);

      const tool = {
        name: "terminal",
        parameters: { properties: { command: { type: "string" } }, type: "object" },
        type: "function",
      };
      const toolOutput = {
        call_id: "call_terminal",
        output: '{"stdout":"ok"}',
        type: "function_call_output",
      };
      const responsesResponse = await fetch(`${baseUrl}/v1/responses`, {
        body: JSON.stringify({
          background: true,
          conversation: "conv_123",
          include: ["file_search_call.results"],
          input: [{ content: "run pwd", role: "user" }, toolOutput],
          max_tool_calls: 3,
          metadata: { trace: "responses" },
          model: "vm-request-hygiene",
          parallel_tool_calls: false,
          previous_response_id: "resp_123",
          reasoning: { effort: "medium" },
          store: true,
          stream: true,
          text: { format: { type: "text" } },
          tool_choice: "required",
          tools: [tool],
          truncation: "auto",
          user: "end-user-123",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      await responsesResponse.text();

      expect(responsesResponse.status).toBe(200);
      expect(fakeProvider.requests).toHaveLength(2);
      const responsesProviderBody = fakeProvider.requests[1]?.bodyJson;
      expect(responsesProviderBody).toMatchObject({
        background: true,
        conversation: "conv_123",
        include: ["file_search_call.results"],
        input: [{ content: "run pwd", role: "user" }, toolOutput],
        max_tool_calls: 3,
        metadata: { trace: "responses" },
        model: "fake-model",
        parallel_tool_calls: false,
        previous_response_id: "resp_123",
        reasoning: { effort: "medium" },
        store: true,
        stream: true,
        text: { format: { type: "text" } },
        tool_choice: "required",
        tools: [tool],
        truncation: "auto",
        user: "end-user-123",
      });

      const imagePart = {
        image_url: "data:image/png;base64,iVBORw0KGgo=",
        type: "input_image",
      };
      const imageResponse = await fetch(`${baseUrl}/v1/responses`, {
        body: JSON.stringify({
          input: [
            {
              content: [{ text: "describe this image", type: "input_text" }, imagePart],
              role: "user",
            },
          ],
          model: "vm-request-hygiene",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      await imageResponse.text();

      expect(imageResponse.status).toBe(200);
      expect(fakeProvider.requests).toHaveLength(3);
      const imageProviderBody = fakeProvider.requests[2]?.bodyJson;
      expect(imageProviderBody).toMatchObject({
        input: [
          {
            content: [{ text: "describe this image", type: "input_text" }, imagePart],
            role: "user",
          },
        ],
        model: "fake-model",
        stream: true,
      });
      expect(isRecord(imageProviderBody) ? imageProviderBody.store : undefined).toBeUndefined();

      const reasoningItem = {
        encrypted_content: "encrypted-reasoning",
        summary: [],
        type: "reasoning",
      };
      const assistantPlaceholder = {
        content: "",
        role: "assistant",
      };
      const reasoningReplayResponse = await fetch(`${baseUrl}/v1/responses`, {
        body: JSON.stringify({
          input: [reasoningItem, assistantPlaceholder],
          model: "vm-request-hygiene",
          store: false,
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      await reasoningReplayResponse.text();

      expect(reasoningReplayResponse.status).toBe(200);
      expect(fakeProvider.requests).toHaveLength(4);
      const reasoningReplayProviderBody = fakeProvider.requests[3]?.bodyJson;
      expect(reasoningReplayProviderBody).toMatchObject({
        input: [reasoningItem, assistantPlaceholder],
        model: "fake-model",
        store: false,
        stream: true,
      });

      const messagesResponse = await fetch(`${baseUrl}/v1/messages`, {
        body: JSON.stringify({
          betas: ["mcp-client-2025-04-04"],
          container: { type: "auto" },
          context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
          max_tokens: 128,
          mcp_servers: [{ name: "tools", type: "url", url: "https://mcp.example.test" }],
          messages: [{ content: "hello", role: "user" }],
          model: "vm-request-hygiene",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      await messagesResponse.text();

      expect(messagesResponse.status).toBe(200);
      expect(fakeProvider.requests).toHaveLength(5);
      const messagesProviderBody = fakeProvider.requests[4]?.bodyJson;
      expect(messagesProviderBody).toMatchObject({
        betas: ["mcp-client-2025-04-04"],
        container: { type: "auto" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        max_tokens: 128,
        mcp_servers: [{ name: "tools", type: "url", url: "https://mcp.example.test" }],
        messages: [{ content: "hello", role: "user" }],
        model: "fake-model",
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

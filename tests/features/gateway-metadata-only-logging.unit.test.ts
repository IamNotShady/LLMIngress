import { describe, expect, it } from "vitest";
import { buildGatewayAgentRequestLog } from "../../apps/gateway/src/main";
import { createPinoLoggerOptions } from "../../packages/logging/src/index";

const promptMarker = "UNIT_PROMPT_MARKER_DO_NOT_LOG";
const toolArgumentMarker = "UNIT_TOOL_ARGUMENT_MARKER_DO_NOT_LOG";

describe("gateway-metadata-only-logging", () => {
  it("keeps request logging limited to gateway metadata", () => {
    const payload = buildGatewayAgentRequestLog({
      agentId: "agent-unit",
      agentKeyPrefix: "llmi_unit",
      method: "POST",
      protocol: "chat_completions",
      requestBody: {
        messages: [{ content: promptMarker, role: "user" }],
        tools: [
          {
            function: {
              arguments: toolArgumentMarker,
              name: "leak_test",
            },
            type: "function",
          },
        ],
      },
      requestId: "req-unit",
      url: "/v1/chat/completions",
      virtualModelName: "vm-unit",
    });

    expect(payload).toEqual({
      agentId: "agent-unit",
      agentKeyPrefix: "llmi_unit",
      method: "POST",
      protocol: "chat_completions",
      requestId: "req-unit",
      url: "/v1/chat/completions",
      virtualModel: "vm-unit",
    });
    expect(JSON.stringify(payload)).not.toContain(promptMarker);
    expect(JSON.stringify(payload)).not.toContain(toolArgumentMarker);
  });

  it("redacts sensitive Fastify and Pino log paths as a second layer", () => {
    const options = createPinoLoggerOptions();
    const paths =
      typeof options.redact === "object" && !Array.isArray(options.redact)
        ? options.redact.paths
        : options.redact;

    expect(paths).toEqual(
      expect.arrayContaining([
        "body",
        "requestBody",
        '["x-api-key"]',
        "req.body",
        'req.headers["x-api-key"]',
        "req.headers.authorization",
        "req.headers.cookie",
        "request.body",
        'request.headers["x-api-key"]',
        "request.headers.authorization",
        "request.headers.cookie",
        "token",
      ]),
    );
  });
});

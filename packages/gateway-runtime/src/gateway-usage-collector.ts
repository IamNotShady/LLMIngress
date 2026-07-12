import { isRecord } from "@llmingress/util";

export type GatewayProviderTokenUsage = {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type GatewayStreamingUsageCollector = {
  collect: (chunk: Buffer | Uint8Array | string) => void;
  readUsage: () => GatewayProviderTokenUsage | undefined;
};

export function readGatewayProviderTokenUsage(
  body: unknown,
): GatewayProviderTokenUsage | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) {
    return undefined;
  }

  const providerInputTokens =
    readNonNegativeInteger(body.usage.prompt_tokens) ??
    readNonNegativeInteger(body.usage.input_tokens);
  if (providerInputTokens === undefined) {
    return undefined;
  }

  const anthropicCacheCreationInputTokens =
    readNonNegativeInteger(body.usage.cache_creation_input_tokens) ?? 0;
  const anthropicCacheReadInputTokens =
    readNonNegativeInteger(body.usage.cache_read_input_tokens) ?? 0;
  const hasAnthropicCacheUsage =
    anthropicCacheCreationInputTokens > 0 || anthropicCacheReadInputTokens > 0;
  const inputTokens = hasAnthropicCacheUsage
    ? providerInputTokens + anthropicCacheCreationInputTokens + anthropicCacheReadInputTokens
    : providerInputTokens;
  const outputTokens =
    readNonNegativeInteger(body.usage.completion_tokens) ??
    readNonNegativeInteger(body.usage.output_tokens) ??
    0;
  const cachedInputTokens = Math.min(
    readNestedNonNegativeInteger(body.usage.prompt_tokens_details, "cached_tokens") ??
      readNestedNonNegativeInteger(body.usage.input_tokens_details, "cached_tokens") ??
      (hasAnthropicCacheUsage ? anthropicCacheReadInputTokens : undefined) ??
      readNonNegativeInteger(body.usage.cached_input_tokens) ??
      0,
    inputTokens,
  );
  const reasoningTokens =
    readNestedNonNegativeInteger(body.usage.completion_tokens_details, "reasoning_tokens") ??
    readNestedNonNegativeInteger(body.usage.output_tokens_details, "reasoning_tokens") ??
    readNonNegativeInteger(body.usage.reasoning_tokens) ??
    0;

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
  };
}

export function createGatewayStreamingUsageCollector(): GatewayStreamingUsageCollector {
  const decoder = new TextDecoder();
  let buffer = "";
  let providerUsage: GatewayProviderTokenUsage | undefined;
  let messagesUsage: GatewayProviderTokenUsage | undefined;

  return {
    collect(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");

      while (true) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd === -1) {
          break;
        }
        readGatewayStreamingUsageFrame(buffer.slice(0, frameEnd));
        buffer = buffer.slice(frameEnd + 2);
      }
    },
    readUsage() {
      const flushed = decoder.decode();
      if (flushed) {
        buffer += flushed;
      }
      if (buffer.trim()) {
        readGatewayStreamingUsageFrame(buffer);
        buffer = "";
      }
      return providerUsage ?? messagesUsage;
    },
  };

  function readGatewayStreamingUsageFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") {
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    const directUsage = readGatewayProviderTokenUsage(event);
    if (directUsage) {
      providerUsage = directUsage;
      return;
    }

    if (!isRecord(event)) {
      return;
    }

    if (event.type === "response.completed") {
      const responseUsage = readGatewayProviderTokenUsage(event.response);
      if (responseUsage) {
        providerUsage = responseUsage;
      }
      return;
    }

    if (event.type === "message_start" && isRecord(event.message)) {
      messagesUsage = readGatewayProviderTokenUsage(event.message) ?? messagesUsage;
      return;
    }

    if (event.type === "message_delta" && isRecord(event.usage)) {
      messagesUsage = {
        cachedInputTokens: messagesUsage?.cachedInputTokens ?? 0,
        inputTokens: messagesUsage?.inputTokens ?? 0,
        outputTokens:
          readNonNegativeInteger(event.usage.output_tokens) ?? messagesUsage?.outputTokens ?? 0,
        reasoningTokens:
          readNestedNonNegativeInteger(event.usage.output_tokens_details, "reasoning_tokens") ??
          readNonNegativeInteger(event.usage.reasoning_tokens) ??
          messagesUsage?.reasoningTokens ??
          0,
      };
    }
  }
}

export function buildGatewayProviderUsageResponseBody(usage: GatewayProviderTokenUsage): {
  usage: Record<string, number>;
} {
  return {
    usage: {
      cached_input_tokens: usage.cachedInputTokens,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      reasoning_tokens: usage.reasoningTokens,
    },
  };
}

function readNestedNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readNonNegativeInteger(value[key]);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

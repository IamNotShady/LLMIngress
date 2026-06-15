export type PlaygroundChatRequest = {
  max_tokens: number;
  messages: Array<{ content: string; role: "user" }>;
  model: string;
  stream: false;
};

export function normalizePlaygroundGatewayBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function isValidPlaygroundGatewayBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(normalizePlaygroundGatewayBaseUrl(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildPlaygroundChatRequest(input: {
  model: string;
  prompt: string;
}): PlaygroundChatRequest {
  return {
    max_tokens: 100,
    messages: [{ content: input.prompt.trim(), role: "user" }],
    model: input.model.trim(),
    stream: false,
  };
}

export function formatPlaygroundFetchError(action: string, _error: unknown): string {
  return `Could not reach Gateway while ${action}. Check the Gateway base URL and that Gateway is running.`;
}

export function readPlaygroundResponseText(body: unknown): string {
  if (!isRecord(body)) {
    return "No response text";
  }

  const choices = body.choices;
  if (Array.isArray(choices)) {
    const firstChoice = choices[0];
    if (isRecord(firstChoice) && isRecord(firstChoice.message)) {
      const content = firstChoice.message.content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    }
  }

  const output = body.output;
  if (Array.isArray(output)) {
    const firstOutput = output[0];
    if (isRecord(firstOutput) && Array.isArray(firstOutput.content)) {
      const firstContent = firstOutput.content[0];
      if (isRecord(firstContent) && typeof firstContent.text === "string") {
        return firstContent.text.trim() || "No response text";
      }
    }
  }

  const content = body.content;
  if (Array.isArray(content)) {
    const firstContent = content[0];
    if (isRecord(firstContent) && typeof firstContent.text === "string") {
      return firstContent.text.trim() || "No response text";
    }
  }

  return "No response text";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

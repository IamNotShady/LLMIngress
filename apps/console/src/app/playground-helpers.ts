export type PlaygroundChatRequest = {
  max_tokens?: number;
  messages: Array<{ content: string; role: "system" | "user" }>;
  model: string;
  stream: boolean;
  temperature?: number;
  top_p?: number;
};

export type PlaygroundMessagesRequest = {
  max_tokens?: number;
  messages: Array<{ content: string; role: "user" }>;
  model: string;
  stream: boolean;
  system?: string;
  temperature?: number;
  top_p?: number;
};

export type PlaygroundProtocol = "chat_completions" | "messages" | "responses";

export type PlaygroundResponsesRequest = {
  input: Array<{
    content: Array<{ text: string; type: "input_text" }>;
    role: "user";
  }>;
  instructions?: string;
  model: string;
  store: false;
  stream: boolean;
};

export type PlaygroundRequestInput = {
  maxTokens?: number;
  model: string;
  prompt: string;
  stream?: boolean;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
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

export function readOptionalPlaygroundNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function buildPlaygroundChatRequest(input: PlaygroundRequestInput): PlaygroundChatRequest {
  const systemPrompt = input.systemPrompt?.trim();
  return {
    ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
    messages: [
      ...(systemPrompt ? [{ content: systemPrompt, role: "system" as const }] : []),
      { content: input.prompt.trim(), role: "user" },
    ],
    model: input.model.trim(),
    stream: input.stream ?? false,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.topP === undefined ? {} : { top_p: input.topP }),
  };
}

export function buildPlaygroundMessagesRequest(
  input: PlaygroundRequestInput,
): PlaygroundMessagesRequest {
  const systemPrompt = input.systemPrompt?.trim();
  return {
    ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
    messages: [{ content: input.prompt.trim(), role: "user" }],
    model: input.model.trim(),
    stream: input.stream ?? false,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.topP === undefined ? {} : { top_p: input.topP }),
  };
}

export function buildPlaygroundResponsesRequest(
  input: PlaygroundRequestInput,
): PlaygroundResponsesRequest {
  const systemPrompt = input.systemPrompt?.trim();
  return {
    input: [
      {
        content: [{ text: input.prompt.trim(), type: "input_text" }],
        role: "user",
      },
    ],
    ...(systemPrompt ? { instructions: systemPrompt } : {}),
    model: input.model.trim(),
    store: false,
    stream: input.stream ?? false,
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

export function readPlaygroundStreamResponseText(body: string): string {
  const chunks: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) {
      continue;
    }
    const data = trimmedLine.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    const payload = readJsonRecord(data);
    if (!payload) {
      continue;
    }
    const text = readStreamPayloadText(payload);
    if (text) {
      chunks.push(text);
    }
  }

  const text = chunks.join("").trim();
  return text || "No response text";
}

function readStreamPayloadText(payload: Record<string, unknown>): string | null {
  const delta = payload.delta;
  if (typeof delta === "string") {
    return delta;
  }
  if (isRecord(delta) && typeof delta.text === "string") {
    return delta.text;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }

  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return null;
  }
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return null;
  }
  if (isRecord(firstChoice.delta) && typeof firstChoice.delta.content === "string") {
    return firstChoice.delta.content;
  }
  if (isRecord(firstChoice.delta) && typeof firstChoice.delta.reasoning_content === "string") {
    return firstChoice.delta.reasoning_content;
  }
  return typeof firstChoice.text === "string" ? firstChoice.text : null;
}

function readJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

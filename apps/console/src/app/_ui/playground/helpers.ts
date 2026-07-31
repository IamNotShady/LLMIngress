import { isRecord } from "@llmingress/util";

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

export async function retryPlaygroundRequestDetail<T>(
  loadDetail: () => Promise<T | null>,
  options: { delayMs?: number; maxAttempts?: number } = {},
): Promise<T | null> {
  const delayMs = Math.max(0, options.delayMs ?? 200);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 20));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const detail = await loadDetail();
    if (detail !== null) {
      return detail;
    }
    if (attempt + 1 < maxAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

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

/**
 * The request headers the gateway allows a browser to send, copied from the
 * single literal apps/gateway/src/cors.ts answers preflights with, in its
 * order. The copy exists because the gateway is a separate service the console
 * cannot import from; a unit test reads that file and fails the moment the two
 * lists differ. A header outside this list is refused by the browser before the
 * request leaves, which reaches the operator as an unexplained network failure,
 * so the editor refuses it first and says why.
 */
export const playgroundSendableHeaders = [
  "authorization",
  "content-type",
  "x-api-key",
  "x-request-id",
  "x-client-request-id",
  "x-llmingress-route-tag",
  "openai-organization",
  "openai-project",
  "openai-beta",
  "anthropic-version",
  "anthropic-beta",
] as const;

export type PlaygroundHeaderIssue = {
  line: number;
  /** Normalized name, or "" when the line has no readable one. */
  name: string;
  reason: "malformed" | "not_allowed" | "reserved";
};

export type PlaygroundRouteTag = {
  matchedTag: string | null;
  requestedTag: string | null;
  tagFallback: boolean;
};

/** The three headers the form sends itself; a second copy would fight them. */
const reservedPlaygroundHeaders = new Set(["authorization", "content-type", "x-request-id"]);
const playgroundHeaderNamePattern = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
/** Printable ASCII only: fetch refuses to build a request with anything else. */
const playgroundHeaderValuePattern = /^[ -~]+$/;

export function isPlaygroundSendableHeader(name: string): boolean {
  return (playgroundSendableHeaders as readonly string[]).includes(name.trim().toLowerCase());
}

/**
 * The typed lines as headers, and every line that cannot become one. A refused
 * line is left out of the headers rather than sent in a shape the browser or
 * the gateway would have to make sense of.
 */
export function parsePlaygroundHeaders(text: string): {
  headers: Record<string, string>;
  issues: PlaygroundHeaderIssue[];
} {
  const headers: Record<string, string> = {};
  const issues: PlaygroundHeaderIssue[] = [];

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is within the split result
    const rawLine = lines[index]!;
    const line = index + 1;
    if (!rawLine.trim()) {
      continue;
    }

    // The first colon separates; the rest belong to the value, which is where a
    // URL or a request id keeps its own.
    const separator = rawLine.indexOf(":");
    const name = separator === -1 ? "" : rawLine.slice(0, separator).trim().toLowerCase();
    const value = separator === -1 ? "" : rawLine.slice(separator + 1).trim();
    if (!playgroundHeaderNamePattern.test(name) || !playgroundHeaderValuePattern.test(value)) {
      issues.push({ line, name, reason: "malformed" });
      continue;
    }
    // Before the allowlist, which names both of these: they are refused for
    // being the form's own, not for being disallowed.
    if (reservedPlaygroundHeaders.has(name)) {
      issues.push({ line, name, reason: "reserved" });
      continue;
    }
    if (!isPlaygroundSendableHeader(name)) {
      issues.push({ line, name, reason: "not_allowed" });
      continue;
    }
    headers[name] = value;
  }

  return { headers, issues };
}

export function formatPlaygroundHeaderIssue(issue: PlaygroundHeaderIssue): string {
  if (issue.reason === "malformed") {
    return `line ${issue.line}: use name: value`;
  }
  if (issue.reason === "reserved") {
    if (issue.name === "authorization") {
      return `line ${issue.line}: authorization is sent from the API KEY field`;
    }
    if (issue.name === "x-request-id") {
      return `line ${issue.line}: x-request-id is generated for every Playground request`;
    }
    return `line ${issue.line}: content-type is fixed at application/json`;
  }
  return `line ${issue.line}: ${issue.name} is not in the gateway CORS allowlist — the browser refuses it before it is sent`;
}

/**
 * Which tag the request landed on. A tag that matched nothing still served an
 * answer from the default candidate, and that is the one outcome the response
 * body cannot tell an operator about.
 */
export function describePlaygroundRouteTag(tag: PlaygroundRouteTag | null | undefined): string {
  if (!tag) {
    return "—";
  }
  if (tag.matchedTag) {
    return tag.matchedTag;
  }
  if (tag.requestedTag) {
    return `${tag.requestedTag} → default (no match)`;
  }
  return "no tag → default";
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

/**
 * A refusal in the words it was refused with. The gateway answers
 * `{ error: { code, message } }` and a provider passed through answers its own
 * shape; without this the console showed the status code and "No response
 * text", which says nothing about what to change.
 */
export function readPlaygroundErrorText(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  const error = body.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const code = typeof error.code === "string" ? error.code.trim() : "";
    if (message && code) {
      return `${code} · ${message}`;
    }
    if (message || code) {
      return message || code;
    }
  }

  const message = body.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
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

/**
 * Turns the bytes of an event stream into answer text as they arrive.
 *
 * A network chunk ends wherever the network ended it, which is usually the
 * middle of a frame: the tail is held back until its newline turns up, because
 * printing a half-parsed frame would put JSON on screen instead of the answer.
 */
export function createPlaygroundStreamDecoder(): {
  flush: () => string;
  push: (chunk: string) => string;
} {
  let pending = "";

  const decodeLine = (line: string): string => {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) {
      return "";
    }
    const data = trimmedLine.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      return "";
    }
    const payload = readJsonRecord(data);
    return payload ? (readStreamPayloadText(payload) ?? "") : "";
  };

  return {
    flush() {
      const rest = pending;
      pending = "";
      return decodeLine(rest);
    },
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      return lines.map(decodeLine).join("");
    },
  };
}

export function readPlaygroundStreamResponseText(body: string): string {
  const decoder = createPlaygroundStreamDecoder();
  const text = `${decoder.push(body)}${decoder.flush()}`.trim();
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

import { type ProviderOAuthConfig, resolveProviderRegistryEntry } from "@llmingress/config";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import { isRecord } from "@llmingress/util";
import type { SubscriptionProviderKey } from "./subscription.js";

export type ProviderOAuthTokenBlob = {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string | null;
  scopes: string[];
  tokenType: string;
};

export type ProviderOAuthCallbackInput = {
  code: string;
  state: string | null;
};

type BuildProviderOAuthAuthorizeUrlInput = {
  codeChallenge: string;
  providerKey: SubscriptionProviderKey;
  state: string;
};

type ExchangeProviderOAuthCodeInput = {
  code: string;
  codeVerifier: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  providerKey: SubscriptionProviderKey;
};

type RefreshProviderOAuthTokenInput = {
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  providerKey: SubscriptionProviderKey;
  refreshToken: string;
};

type RevokeProviderOAuthTokenInput = {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  providerKey: SubscriptionProviderKey;
};

const providerOAuthRequestTimeoutMs = 30_000;

export function buildProviderOAuthAuthorizeUrl(input: BuildProviderOAuthAuthorizeUrlInput): string {
  const config = readOAuthConfig(input.providerKey);
  const url = new URL(config.authorizeUrl);
  for (const [key, value] of Object.entries(config.defaultParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function parseProviderOAuthCallbackInput(value: string): ProviderOAuthCallbackInput {
  const input = value.trim();
  if (!input) {
    throw new Error("OAuth callback code is required.");
  }

  const parsed = parseCallbackUrl(input) ?? parseCodeStatePair(input);
  if (!parsed.code) {
    throw new Error("OAuth callback code is required.");
  }
  return parsed;
}

export async function exchangeProviderOAuthCode(
  input: ExchangeProviderOAuthCodeInput,
): Promise<ProviderOAuthTokenBlob> {
  const config = readOAuthConfig(input.providerKey);
  const body: Record<string, string> = {
    client_id: config.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  };
  if (resolveProviderDescriptor(input.providerKey).oauthStateFromCodeVerifier === true) {
    body.state = input.codeVerifier;
  }
  return requestOAuthToken({
    body,
    headers: config.tokenHeaders,
    fetch: input.fetch,
    nowMs: input.nowMs,
    tokenEncoding: config.tokenEncoding,
    tokenUrl: config.tokenUrl,
  });
}

export async function refreshProviderOAuthToken(
  input: RefreshProviderOAuthTokenInput,
): Promise<ProviderOAuthTokenBlob> {
  const config = readOAuthConfig(input.providerKey);
  return requestOAuthToken({
    body: {
      client_id: config.clientId,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    },
    headers: config.tokenHeaders,
    fetch: input.fetch,
    nowMs: input.nowMs,
    tokenEncoding: config.tokenEncoding,
    tokenUrl: config.tokenUrl,
  });
}

export async function revokeProviderOAuthToken(
  input: RevokeProviderOAuthTokenInput,
): Promise<void> {
  const config = readOAuthConfig(input.providerKey);
  if (!config.revokeUrl) {
    return;
  }
  const response = await (input.fetch ?? globalThis.fetch)(config.revokeUrl, {
    body: new URLSearchParams({
      client_id: config.clientId,
      token: input.accessToken,
    }),
    headers: config.tokenHeaders,
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`OAuth token revoke failed with status ${response.status}.`);
  }
}

function parseCallbackUrl(input: string): ProviderOAuthCallbackInput | null {
  try {
    const url = new URL(input);
    const code = url.searchParams.get("code")?.trim();
    if (!code) {
      return null;
    }
    return {
      code,
      state: url.searchParams.get("state")?.trim() || null,
    };
  } catch {
    const query = input.startsWith("?") ? input : null;
    if (!query) {
      return null;
    }
    const params = new URLSearchParams(query);
    const code = params.get("code")?.trim();
    return code ? { code, state: params.get("state")?.trim() || null } : null;
  }
}

function parseCodeStatePair(input: string): ProviderOAuthCallbackInput {
  const [code = "", state = ""] = input.split("#", 2);
  return {
    code: code.trim(),
    state: state.trim() || null,
  };
}

async function requestOAuthToken(input: {
  body: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  nowMs?: () => number;
  tokenEncoding: "form" | "json";
  tokenUrl: string;
}): Promise<ProviderOAuthTokenBlob> {
  const requestBody =
    input.tokenEncoding === "form" ? new URLSearchParams(input.body) : JSON.stringify(input.body);
  const response = await (input.fetch ?? globalThis.fetch)(input.tokenUrl, {
    body: requestBody,
    headers: input.headers,
    method: "POST",
    signal: AbortSignal.timeout(providerOAuthRequestTimeoutMs),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new Error(`OAuth token request failed with status ${response.status}.`);
  }
  return normalizeTokenBody(body, input.nowMs ?? Date.now, input.body.refresh_token ?? null);
}

function normalizeTokenBody(
  body: unknown,
  nowMs: () => number,
  fallbackRefreshToken: string | null,
): ProviderOAuthTokenBlob {
  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token.trim()) {
    throw new Error("OAuth token response did not include an access token.");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.trim()
      ? body.refresh_token
      : fallbackRefreshToken;

  return {
    accessToken: body.access_token,
    expiresAt:
      expiresIn === null || !Number.isFinite(expiresIn) || expiresIn <= 0
        ? null
        : nowMs() + Math.floor(expiresIn * 1000),
    refreshToken,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    tokenType:
      typeof body.token_type === "string" && body.token_type.trim() ? body.token_type : "Bearer",
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function readOAuthConfig(providerKey: SubscriptionProviderKey): ProviderOAuthConfig {
  const oauth = resolveProviderRegistryEntry(providerKey)?.oauth;
  if (!oauth) {
    throw new Error(`Missing OAuth config for ${providerKey}.`);
  }
  return oauth;
}

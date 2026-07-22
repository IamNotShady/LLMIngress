import {
  type AuthorizationCodeProviderOAuthConfig,
  type DeviceCodeProviderOAuthConfig,
  type ProviderOAuthConfig,
  resolveProviderRegistryEntry,
} from "@llmingress/config/provider-registry";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import { isRecord } from "@llmingress/util";
import type { SubscriptionProviderKey } from "./subscription.js";

export type ProviderOAuthTokenBlob = {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string | null;
  resourceUrl?: string | null;
  scopes: string[];
  tokenType: string;
};

export type ProviderOAuthUserCode = {
  intervalSeconds: number;
  userCode: string;
  verificationUri: string;
};

export type ProviderOAuthUserCodePollResult =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "success"; token: ProviderOAuthTokenBlob };

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

type RequestProviderOAuthUserCodeInput = {
  codeChallenge: string;
  fetch?: typeof globalThis.fetch;
  providerKey: SubscriptionProviderKey;
  state: string;
};

type PollProviderOAuthUserCodeTokenInput = {
  codeVerifier: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  providerKey: SubscriptionProviderKey;
  userCode: string;
};

const providerOAuthRequestTimeoutMs = 30_000;
const defaultDevicePollIntervalSeconds = 2;

export function buildProviderOAuthAuthorizeUrl(input: BuildProviderOAuthAuthorizeUrlInput): string {
  const config = requireAuthorizationCodeOAuthConfig(input.providerKey);
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
  const config = requireAuthorizationCodeOAuthConfig(input.providerKey);
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
  const token = await requestOAuthToken({
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
  return sanitizeProviderOAuthResourceUrl(token, input.providerKey);
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

/**
 * Device/user-code start flow (MiniMax shape, not RFC 8628): POST the PKCE
 * challenge to the device-code URL and return the user code + verification URI
 * to display. The PKCE verifier and the state (flowId) are produced by the
 * caller (the storage service) so they can be persisted for polling.
 */
export async function requestProviderOAuthUserCode(
  input: RequestProviderOAuthUserCodeInput,
): Promise<ProviderOAuthUserCode> {
  const config = requireDeviceCodeOAuthConfig(input.providerKey);
  const response = await (input.fetch ?? globalThis.fetch)(config.deviceCodeUrl, {
    body: new URLSearchParams({
      client_id: config.clientId,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      scope: config.scope,
      state: input.state,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: AbortSignal.timeout(providerOAuthRequestTimeoutMs),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new Error(`OAuth user code request failed with status ${response.status}.`);
  }
  if (!isRecord(body) || typeof body.user_code !== "string" || !body.user_code.trim()) {
    throw new Error("OAuth user code response did not include a user code.");
  }
  if (typeof body.state === "string" && body.state && body.state !== input.state) {
    throw new Error("OAuth user code response state did not match.");
  }
  const verificationUri =
    typeof body.verification_uri === "string" ? body.verification_uri.trim() : "";
  if (!verificationUri) {
    throw new Error("OAuth user code response did not include a verification URI.");
  }
  return {
    intervalSeconds: normalizePollIntervalSeconds(
      body.interval,
      config.defaultPollIntervalSeconds ?? defaultDevicePollIntervalSeconds,
    ),
    userCode: body.user_code,
    verificationUri: rewriteDeviceVerificationUri(verificationUri),
  };
}

/**
 * Poll the token endpoint once with the user-code grant. Pending/success/error
 * are judged from the response-body `status` field (HTTP 200 throughout), not
 * standard OAuth error codes: `status === "error"` or a non-2xx is an error;
 * anything other than `"success"` is pending; only `"success"` normalizes.
 */
export async function pollProviderOAuthUserCodeToken(
  input: PollProviderOAuthUserCodeTokenInput,
): Promise<ProviderOAuthUserCodePollResult> {
  const config = requireDeviceCodeOAuthConfig(input.providerKey);
  let response: Response;
  let body: unknown;
  try {
    response = await (input.fetch ?? globalThis.fetch)(config.tokenUrl, {
      body: new URLSearchParams({
        client_id: config.clientId,
        code_verifier: input.codeVerifier,
        grant_type: "urn:ietf:params:oauth:grant-type:user_code",
        user_code: input.userCode,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(providerOAuthRequestTimeoutMs),
    });
    body = await readJsonBody(response);
  } catch {
    // A transient network/parse hiccup must not terminate the flow — keep
    // polling; the caller's pending_expires_at is the real stop condition.
    return { status: "pending" };
  }
  const status = isRecord(body) && typeof body.status === "string" ? body.status : null;
  // The MiniMax "error" verdict arrives over HTTP 200, so its message must come
  // from the response body, never be reported as "failed with status 200".
  if (status === "error") {
    return { message: readDeviceAuthorizationError(body), status: "error" };
  }
  if (!response.ok) {
    return {
      message: `OAuth device authorization failed with status ${response.status}.`,
      status: "error",
    };
  }
  if (status !== "success") {
    return { status: "pending" };
  }
  return {
    status: "success",
    token: sanitizeProviderOAuthResourceUrl(
      normalizeTokenBody(body, input.nowMs ?? Date.now, null),
      input.providerKey,
    ),
  };
}

function readDeviceAuthorizationError(body: unknown): string {
  if (isRecord(body)) {
    for (const key of ["error_description", "error", "message"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return "OAuth device authorization was rejected.";
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

/**
 * SSRF guard for the upstream-supplied resource_url: an unknown host or a
 * non-https scheme captured into the token blob would later steer gateway egress
 * (and the connectivity/quota probes) to an attacker-chosen origin. Keep the
 * value only when it is https and its host belongs to this provider's own OAuth
 * endpoints (tokenUrl/deviceCodeUrl) or its registry creation base — derived
 * from config, never a hardcoded domain, so the rule stays provider-agnostic.
 * An out-of-allowlist value is dropped (not an error): the token exchange still
 * succeeds and egress falls back to the registry base.
 */
function sanitizeProviderOAuthResourceUrl(
  token: ProviderOAuthTokenBlob,
  providerKey: SubscriptionProviderKey,
): ProviderOAuthTokenBlob {
  if (!token.resourceUrl || isAllowedProviderOAuthResourceUrl(token.resourceUrl, providerKey)) {
    return token;
  }
  const { resourceUrl: _dropped, ...rest } = token;
  return rest;
}

function isAllowedProviderOAuthResourceUrl(
  resourceUrl: string,
  providerKey: SubscriptionProviderKey,
): boolean {
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  return providerOAuthAllowedResourceHosts(providerKey).has(url.hostname);
}

function providerOAuthAllowedResourceHosts(providerKey: SubscriptionProviderKey): Set<string> {
  const hosts = new Set<string>();
  const config = readOAuthConfig(providerKey);
  addProviderOAuthUrlHost(hosts, config.tokenUrl);
  if ("deviceCodeUrl" in config) {
    addProviderOAuthUrlHost(hosts, config.deviceCodeUrl);
  }
  const creation = resolveProviderRegistryEntry(providerKey)?.creation;
  if (creation) {
    addProviderOAuthUrlHost(hosts, "baseUrl" in creation ? creation.baseUrl : undefined);
    addProviderOAuthUrlHost(hosts, "fixedBaseUrl" in creation ? creation.fixedBaseUrl : undefined);
  }
  return hosts;
}

function addProviderOAuthUrlHost(hosts: Set<string>, url: string | undefined): void {
  if (!url) {
    return;
  }
  try {
    hosts.add(new URL(url).hostname);
  } catch {
    // A malformed config URL simply contributes no allowed host.
  }
}

function normalizeTokenBody(
  body: unknown,
  nowMs: () => number,
  fallbackRefreshToken: string | null,
): ProviderOAuthTokenBlob {
  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token.trim()) {
    throw new Error("OAuth token response did not include an access token.");
  }
  // MiniMax (device-code success and refresh) reports lifetime as `expired_in`;
  // standard providers only ever send `expires_in`, so the fallback is inert
  // for them and lands here so both the poll and refresh paths get it.
  const expiresIn =
    typeof body.expires_in === "number"
      ? body.expires_in
      : typeof body.expired_in === "number"
        ? body.expired_in
        : null;
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.trim()
      ? body.refresh_token
      : fallbackRefreshToken;
  const resourceUrl =
    typeof body.resource_url === "string" && body.resource_url.trim() ? body.resource_url : null;

  return {
    accessToken: body.access_token,
    expiresAt:
      expiresIn === null || !Number.isFinite(expiresIn) || expiresIn <= 0
        ? null
        : nowMs() + Math.floor(expiresIn * 1000),
    refreshToken,
    ...(resourceUrl ? { resourceUrl } : {}),
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    tokenType:
      typeof body.token_type === "string" && body.token_type.trim() ? body.token_type : "Bearer",
  };
}

// Normalizes a poll interval that may be seconds or milliseconds (the MiniMax
// device-flow helper heuristic): >= 1000 is treated as milliseconds, anything
// smaller as seconds. Falls back to the provider's configured default. The
// normalized value is clamped to [1, 60] seconds so an extreme upstream number
// (e.g. 1200 misread as 1.2s, or a huge interval that would stall polling)
// cannot escape a sane range.
function normalizePollIntervalSeconds(value: unknown, fallbackSeconds: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackSeconds;
  }
  const seconds = value >= 1000 ? value / 1000 : value;
  return Math.min(60, Math.max(1, Math.round(seconds)));
}

// The upstream verification URI points at a host that 307-redirects to the
// marketing home page; rewrite it to the platform host that renders the code
// entry page (only for the known /oauth-authorize path).
function rewriteDeviceVerificationUri(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("OAuth verification URI is not a valid URL.");
  }
  // The URI is rendered as a Console link, so reject anything but https up front
  // (a javascript: or http: scheme must fail the start flow, not reach an href).
  if (url.protocol !== "https:") {
    throw new Error("OAuth verification URI must use https.");
  }
  if (url.pathname === "/oauth-authorize") {
    if (url.hostname === "www.minimax.io") {
      url.hostname = "platform.minimax.io";
    } else if (url.hostname === "www.minimaxi.com") {
      url.hostname = "platform.minimaxi.com";
    }
  }
  return url.toString();
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

function requireAuthorizationCodeOAuthConfig(
  providerKey: SubscriptionProviderKey,
): AuthorizationCodeProviderOAuthConfig {
  const config = readOAuthConfig(providerKey);
  if (!("authorizeUrl" in config) || !config.authorizeUrl) {
    throw new Error(`Provider ${providerKey} is not an authorization-code OAuth provider.`);
  }
  return config;
}

function requireDeviceCodeOAuthConfig(
  providerKey: SubscriptionProviderKey,
): DeviceCodeProviderOAuthConfig {
  const config = readOAuthConfig(providerKey);
  if (!("deviceCodeUrl" in config) || !config.deviceCodeUrl) {
    throw new Error(`Provider ${providerKey} is not a device-code OAuth provider.`);
  }
  return config;
}

import { createHash, randomUUID } from "node:crypto";
import { getPostgresPool } from "@llmingress/db/client";

export type GatewayAuthErrorCode =
  | "disabled_api_key"
  | "invalid_api_key"
  | "missing_api_key";

export type GatewayAuthenticatedApiKey = {
  apiKeyId: string;
  defaultVirtualModelId: string | null;
  id: string;
  keyPrefix: string;
  limitsEnabled: boolean;
};

export type GatewayAuthSuccess = {
  apiKey: GatewayAuthenticatedApiKey;
  ok: true;
  requestId: string;
};

export type GatewayAuthFailure = {
  body: GatewayAuthErrorBody;
  ok: false;
  statusCode: 401;
};

export type GatewayAuthResult = GatewayAuthFailure | GatewayAuthSuccess;

export type GatewayAuthErrorBody = {
  error: {
    code: GatewayAuthErrorCode;
    message: string;
  };
  requestId: string;
};

type GatewayAuthHeaders = Record<string, string | string[] | undefined>;

type ApiKeyAuthRow = {
  api_key_id: string;
  default_virtual_model_id: string | null;
  enabled: boolean;
  id: string;
  key_prefix: string;
  limits_enabled: boolean;
};

const gatewayRequestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildGatewayApiKeyHash(plaintext: string): string {
  return `sha256:v1:${createHash("sha256")
    .update("llmingress:api-key:v1")
    .update(plaintext.trim())
    .digest("base64url")}`;
}

export function readGatewayApiKeyCredential(headers: GatewayAuthHeaders): string | null {
  const authorization = firstHeaderValue(headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token || null;
  }

  return firstHeaderValue(headers["x-api-key"])?.trim() || null;
}

export function createGatewayAuthErrorBody(
  code: GatewayAuthErrorCode,
  requestId: string,
): GatewayAuthErrorBody {
  return {
    error: {
      code,
      message: authErrorMessage(code),
    },
    requestId,
  };
}

export async function authenticateGatewayRequest(input: {
  databaseUrl?: string;
  headers: GatewayAuthHeaders;
}): Promise<GatewayAuthResult> {
  const requestId = readGatewayRequestId(input.headers);
  const credential = readGatewayApiKeyCredential(input.headers);
  if (!credential) {
    return gatewayAuthFailure("missing_api_key", requestId);
  }

  const row = await readApiKeyByHash(
    input.databaseUrl,
    buildGatewayApiKeyHash(credential),
  );
  if (!row) {
    return gatewayAuthFailure("invalid_api_key", requestId);
  }
  if (!row.enabled) {
    return gatewayAuthFailure("disabled_api_key", requestId);
  }

  return {
    apiKey: {
      apiKeyId: row.api_key_id,
      defaultVirtualModelId: row.default_virtual_model_id,
      id: row.id,
      keyPrefix: row.key_prefix,
      limitsEnabled: row.limits_enabled,
    },
    ok: true,
    requestId,
  };
}

export function readGatewayRequestId(headers: GatewayAuthHeaders): string {
  const value = firstHeaderValue(headers["x-request-id"])?.trim();
  return value && gatewayRequestIdPattern.test(value) ? value : `gw_${randomUUID()}`;
}

function gatewayAuthFailure(code: GatewayAuthErrorCode, requestId: string): GatewayAuthFailure {
  return {
    body: createGatewayAuthErrorBody(code, requestId),
    ok: false,
    statusCode: 401,
  };
}

async function readApiKeyByHash(
  databaseUrl: string | undefined,
  keyHash: string,
): Promise<ApiKeyAuthRow | undefined> {
  const result = await getPostgresPool(databaseUrl).query<ApiKeyAuthRow>(
    `
      select api_keys.id::text,
             api_keys.id::text as api_key_id,
             api_keys.key_prefix,
             api_keys.default_virtual_model_id::text,
             api_keys.enabled,
             api_keys.limits_enabled
      from api_keys
      where api_keys.key_hash = $1
        and api_keys.deleted_at is null
    `,
    [keyHash],
  );
  return result.rows[0];
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function authErrorMessage(code: GatewayAuthErrorCode): string {
  if (code === "missing_api_key") {
    return "API key is required.";
  }
  if (code === "disabled_api_key") {
    return "API key is disabled.";
  }
  return "API key is invalid.";
}

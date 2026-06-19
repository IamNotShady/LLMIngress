import { createHash, randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";

export type GatewayAuthErrorCode =
  | "disabled_agent_api_key"
  | "invalid_agent_api_key"
  | "missing_agent_api_key";

export type GatewayAuthenticatedAgentApiKey = {
  agentId: string;
  defaultVirtualModelId: string | null;
  id: string;
  keyPrefix: string;
  requestLoggingEnabled: boolean;
};

export type GatewayAuthSuccess = {
  agentApiKey: GatewayAuthenticatedAgentApiKey;
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

type AgentApiKeyAuthRow = QueryResultRow & {
  agent_id: string;
  default_virtual_model_id: string | null;
  enabled: boolean;
  id: string;
  key_prefix: string;
  request_logging_enabled: boolean;
};

export function buildGatewayAgentApiKeyHash(plaintext: string): string {
  return `sha256:v1:${createHash("sha256")
    .update("llmingress:agent-api-key:v1")
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
  databaseUrl: string;
  headers: GatewayAuthHeaders;
}): Promise<GatewayAuthResult> {
  const requestId = readGatewayRequestId(input.headers);
  const credential = readGatewayApiKeyCredential(input.headers);
  if (!credential) {
    return gatewayAuthFailure("missing_agent_api_key", requestId);
  }

  const row = await readAgentApiKeyByHash(
    input.databaseUrl,
    buildGatewayAgentApiKeyHash(credential),
  );
  if (!row) {
    return gatewayAuthFailure("invalid_agent_api_key", requestId);
  }
  if (!row.enabled) {
    return gatewayAuthFailure("disabled_agent_api_key", requestId);
  }

  return {
    agentApiKey: {
      agentId: row.agent_id,
      defaultVirtualModelId: row.default_virtual_model_id,
      id: row.id,
      keyPrefix: row.key_prefix,
      requestLoggingEnabled: row.request_logging_enabled,
    },
    ok: true,
    requestId,
  };
}

function readGatewayRequestId(headers: GatewayAuthHeaders): string {
  return firstHeaderValue(headers["x-request-id"])?.trim() || `gw_${randomUUID()}`;
}

function gatewayAuthFailure(code: GatewayAuthErrorCode, requestId: string): GatewayAuthFailure {
  return {
    body: createGatewayAuthErrorBody(code, requestId),
    ok: false,
    statusCode: 401,
  };
}

async function readAgentApiKeyByHash(
  databaseUrl: string,
  keyHash: string,
): Promise<AgentApiKeyAuthRow | undefined> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<AgentApiKeyAuthRow>(
      `
        select agents.id::text,
               agents.id::text as agent_id,
               agents.key_prefix,
               agents.default_virtual_model_id::text,
               agents.enabled,
               agents.request_logging_enabled
        from agents
        where agents.key_hash = $1
      `,
      [keyHash],
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function authErrorMessage(code: GatewayAuthErrorCode): string {
  if (code === "missing_agent_api_key") {
    return "Agent API key is required.";
  }
  if (code === "disabled_agent_api_key") {
    return "Agent API key is disabled.";
  }
  return "Agent API key is invalid.";
}

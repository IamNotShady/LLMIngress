import { getPostgresPool, type PostgresQueryResultRow } from "@llmingress/db/client";

export type GatewayVirtualModel = {
  displayName: string;
  id: string;
  name: string;
};

export type GatewayVirtualModelAccessErrorCode = "missing_model" | "virtual_model_not_allowed";

export type GatewayVirtualModelAccessErrorBody = {
  error: {
    code: GatewayVirtualModelAccessErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayVirtualModelAccessSuccess = {
  ok: true;
  requestId: string;
  virtualModel: GatewayVirtualModel;
};

export type GatewayVirtualModelAccessFailure = {
  body: GatewayVirtualModelAccessErrorBody;
  ok: false;
  statusCode: 400 | 403;
};

export type GatewayVirtualModelAccessResult =
  | GatewayVirtualModelAccessFailure
  | GatewayVirtualModelAccessSuccess;

type VirtualModelRow = PostgresQueryResultRow & {
  display_name: string;
  id: string;
  name: string;
};

export function createGatewayVirtualModelAccessErrorBody(
  code: GatewayVirtualModelAccessErrorCode,
  requestId: string,
): GatewayVirtualModelAccessErrorBody {
  return {
    error: {
      code,
      message: virtualModelAccessErrorMessage(code),
    },
    requestId,
  };
}

export function resolveGatewayVirtualModelRequest(input: {
  allowedVirtualModels: readonly GatewayVirtualModel[];
  defaultVirtualModelId: string | null;
  requestedModelName: string | null;
  requestId: string;
}): GatewayVirtualModelAccessResult {
  if (input.requestedModelName) {
    const requested = input.allowedVirtualModels.find(
      (virtualModel) => virtualModel.name === input.requestedModelName,
    );
    if (!requested) {
      return virtualModelAccessFailure("virtual_model_not_allowed", input.requestId);
    }

    return {
      ok: true,
      requestId: input.requestId,
      virtualModel: requested,
    };
  }

  if (!input.defaultVirtualModelId) {
    return virtualModelAccessFailure("missing_model", input.requestId);
  }

  const defaultVirtualModel = input.allowedVirtualModels.find(
    (virtualModel) => virtualModel.id === input.defaultVirtualModelId,
  );
  if (!defaultVirtualModel) {
    return virtualModelAccessFailure("virtual_model_not_allowed", input.requestId);
  }

  return {
    ok: true,
    requestId: input.requestId,
    virtualModel: defaultVirtualModel,
  };
}

export function readRequestedModelName(body: unknown): string | null {
  if (!isRecord(body) || typeof body.model !== "string" || !body.model.trim()) {
    return null;
  }
  return body.model.trim();
}

export async function listAllowedGatewayVirtualModels(input: {
  agentApiKeyId: string;
  databaseUrl?: string;
}): Promise<GatewayVirtualModel[]> {
  const result = await getPostgresPool(input.databaseUrl).query<VirtualModelRow>(
    `
      select virtual_models.id::text,
             virtual_models.name,
             virtual_models.description as display_name
      from agent_virtual_models
      join virtual_models on virtual_models.id = agent_virtual_models.virtual_model_id
      where agent_virtual_models.agent_id = $1
        and virtual_models.enabled = true
        and virtual_models.deleted_at is null
      order by virtual_models.name
    `,
    [input.agentApiKeyId],
  );
  return result.rows.map((row) => ({
    displayName: row.display_name,
    id: row.id,
    name: row.name,
  }));
}

function virtualModelAccessFailure(
  code: GatewayVirtualModelAccessErrorCode,
  requestId: string,
): GatewayVirtualModelAccessFailure {
  return {
    body: createGatewayVirtualModelAccessErrorBody(code, requestId),
    ok: false,
    statusCode: code === "missing_model" ? 400 : 403,
  };
}

function virtualModelAccessErrorMessage(code: GatewayVirtualModelAccessErrorCode): string {
  if (code === "missing_model") {
    return "Model is required and no default Virtual Model is configured.";
  }
  return "Virtual Model is not allowed for this Agent API key.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

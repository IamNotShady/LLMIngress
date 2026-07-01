export const gatewayRequestIdHeader = "x-request-id";

const gatewayErrorStatusByCode: Record<string, number> = {
  cost_budget_exceeded: 402,
  cost_budget_price_unavailable: 402,
  disabled_agent_api_key: 401,
  invalid_agent_api_key: 401,
  invalid_chat_request: 400,
  invalid_embeddings_request: 400,
  invalid_messages_request: 400,
  invalid_responses_request: 400,
  missing_agent_api_key: 401,
  missing_model: 400,
  provider_credentials_missing: 500,
  provider_protocol_unsupported: 400,
  provider_rate_limited: 429,
  provider_request_failed: 502,
  provider_unavailable: 503,
  rate_limit_exceeded: 429,
  route_not_found: 404,
  token_budget_exceeded: 402,
  unsupported_stateful_responses: 400,
  virtual_model_not_allowed: 403,
};

export function mapGatewayErrorStatus(code: string, fallbackStatus = 500): number {
  return gatewayErrorStatusByCode[code] ?? fallbackStatus;
}

export function readGatewayErrorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }
  return typeof body.error.code === "string" && body.error.code.trim() ? body.error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const gatewayRequestIdHeader = "x-request-id";

export function mapGatewayErrorStatus(code: string, fallbackStatus = 500): number {
  if (
    code === "missing_agent_api_key" ||
    code === "invalid_agent_api_key" ||
    code === "disabled_agent_api_key"
  ) {
    return 401;
  }
  if (code === "virtual_model_not_allowed") {
    return 403;
  }
  if (
    code === "invalid_chat_request" ||
    code === "invalid_embeddings_request" ||
    code === "invalid_messages_request" ||
    code === "invalid_responses_request" ||
    code === "missing_model" ||
    code === "provider_protocol_unsupported" ||
    code === "unsupported_stateful_responses"
  ) {
    return 400;
  }
  if (code === "route_not_found") {
    return 404;
  }
  if (code === "rate_limit_exceeded" || code === "provider_rate_limited") {
    return 429;
  }
  if (
    code === "cost_budget_exceeded" ||
    code === "cost_budget_price_unavailable" ||
    code === "token_budget_exceeded"
  ) {
    return 402;
  }
  if (code === "provider_credentials_missing") {
    return 500;
  }
  if (code === "provider_request_failed") {
    return 502;
  }
  if (code === "provider_unavailable") {
    return 503;
  }
  return fallbackStatus;
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

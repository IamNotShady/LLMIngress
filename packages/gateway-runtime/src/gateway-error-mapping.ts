export const gatewayRequestIdHeader = "x-request-id";

import type { GatewayErrorCode } from "./gateway-errors.ts";

const gatewayErrorStatusByCode: Record<GatewayErrorCode, number> = {
  cost_budget_exceeded: 402,
  disabled_api_key: 401,
  invalid_api_key: 401,
  invalid_chat_request: 400,
  invalid_messages_request: 400,
  invalid_responses_request: 400,
  missing_api_key: 401,
  missing_model: 400,
  provider_credentials_missing: 500,
  provider_connection_unavailable: 503,
  provider_protocol_unsupported: 400,
  provider_rate_limited: 429,
  provider_redirect_rejected: 502,
  provider_rejected_request: 502,
  provider_request_failed: 502,
  provider_unavailable: 503,
  rate_limit_exceeded: 429,
  route_not_found: 404,
  token_budget_exceeded: 402,
  virtual_model_capability_mismatch: 400,
  virtual_model_configuration_invalid: 503,
  virtual_model_not_allowed: 403,
};

export function mapGatewayErrorStatus(code: string, fallbackStatus = 500): number {
  return code in gatewayErrorStatusByCode
    ? gatewayErrorStatusByCode[code as GatewayErrorCode]
    : fallbackStatus;
}

import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";

export type GatewayErrorCode =
  | "cost_budget_exceeded"
  | "cost_budget_price_unavailable"
  | "disabled_agent_api_key"
  | "invalid_agent_api_key"
  | "invalid_chat_request"
  | "invalid_embeddings_request"
  | "invalid_messages_request"
  | "invalid_responses_request"
  | "missing_agent_api_key"
  | "missing_model"
  | "provider_credentials_missing"
  | "provider_protocol_unsupported"
  | "provider_rate_limited"
  | "provider_redirect_rejected"
  | "provider_rejected_request"
  | "provider_request_failed"
  | "provider_unavailable"
  | "rate_limit_exceeded"
  | "route_not_found"
  | "token_budget_exceeded"
  | "virtual_model_capability_mismatch"
  | "virtual_model_configuration_invalid"
  | "virtual_model_not_allowed";

export type GatewayErrorBody = {
  error: {
    code: GatewayErrorCode;
    message: string;
  };
  requestId: string;
};

const defaultGatewayErrorMessage: Record<GatewayErrorCode, string> = {
  cost_budget_exceeded: "Agent API key cost budget was exceeded.",
  cost_budget_price_unavailable: "Cost budget enforcement requires a known model price.",
  disabled_agent_api_key: "Agent API key is disabled.",
  invalid_agent_api_key: "Agent API key is invalid.",
  invalid_chat_request: "Chat completion request must include at least one string-content message.",
  invalid_embeddings_request: "Embeddings request must include non-empty input text.",
  invalid_messages_request:
    "Anthropic messages request must include max_tokens and at least one message.",
  invalid_responses_request:
    "Responses request must include a non-empty input item list with structured message content.",
  missing_agent_api_key: "Agent API key is required.",
  missing_model: "Model is required and no default Virtual Model is configured.",
  provider_credentials_missing: "Provider credentials are not configured for the selected route.",
  provider_protocol_unsupported: "Provider protocol is not supported for this endpoint.",
  provider_rate_limited: "Provider rate limit exceeded.",
  provider_redirect_rejected: "Provider returned a redirect. Configure the final provider URL.",
  provider_rejected_request: "Provider rejected the request.",
  provider_request_failed: "Provider request failed.",
  provider_unavailable: "No eligible provider candidates are available for the selected route.",
  rate_limit_exceeded: "Agent API key exceeded its rate limit.",
  route_not_found: "No route policy is available for the selected Virtual Model.",
  token_budget_exceeded: "Agent API key token budget was exceeded.",
  virtual_model_capability_mismatch:
    "Request exceeds the selected Virtual Model capability contract.",
  virtual_model_configuration_invalid:
    "Selected Virtual Model has an invalid provider capability configuration.",
  virtual_model_not_allowed: "Virtual Model is not allowed for this Agent API key.",
};

export function createGatewayErrorBody(
  code: GatewayErrorCode,
  requestId: string,
  message = defaultGatewayErrorMessage[code],
): GatewayErrorBody {
  return {
    error: {
      code,
      message,
    },
    requestId,
  };
}

export class GatewayPipelineError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "GatewayPipelineError";
  }
}

export function toGatewayErrorResponseParts(
  error: unknown,
  fallbackCode: GatewayErrorCode,
): { code: GatewayErrorCode; message: string | undefined; statusCode: number } {
  if (error instanceof GatewayPipelineError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.upstreamStatus ?? mapGatewayErrorStatus(error.code),
    };
  }
  return {
    code: fallbackCode,
    message: undefined,
    statusCode: mapGatewayErrorStatus(fallbackCode),
  };
}

export function truncateProviderMessage(message: string, maxLength = 500): string {
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, maxLength)
    .trim();
}

import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";

export class GatewayPipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "GatewayPipelineError";
  }
}

export function toGatewayErrorResponseParts(
  error: unknown,
  fallbackCode: string,
): { code: string; message: string | undefined; statusCode: number } {
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

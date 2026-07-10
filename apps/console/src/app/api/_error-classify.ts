import { ConsoleOperationError } from "@llmingress/db/console-operation-error";

export type ConsoleActionErrorVerdict = {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  status: 400 | 404 | 409 | 500;
};

export function classifyConsoleActionError(
  error: unknown,
  fallbackMessage: string,
): ConsoleActionErrorVerdict {
  if (error instanceof ConsoleOperationError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      status: statusForKind(error.kind),
    };
  }
  return { code: "internal_error", message: fallbackMessage, status: 500 };
}

function statusForKind(kind: ConsoleOperationError["kind"]): 400 | 404 | 409 {
  if (kind === "not_found") {
    return 404;
  }
  if (kind === "conflict") {
    return 409;
  }
  return 400;
}

export type ConsoleOperationErrorKind = "validation" | "not_found" | "conflict";

export type ConsoleOperationErrorOptions = {
  cause?: unknown;
  code: string;
  details?: Record<string, unknown>;
};

export class ConsoleOperationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly kind: ConsoleOperationErrorKind;

  constructor(
    kind: ConsoleOperationErrorKind,
    message: string,
    options: ConsoleOperationErrorOptions,
  ) {
    super(message, { cause: options.cause });
    this.name = "ConsoleOperationError";
    this.kind = kind;
    this.code = options.code;
    this.details = options.details;
  }
}

export function consoleValidationError(
  message: string,
  code: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): ConsoleOperationError {
  return new ConsoleOperationError("validation", message, { cause, code, details });
}

export function consoleNotFoundError(
  message: string,
  code: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): ConsoleOperationError {
  return new ConsoleOperationError("not_found", message, { cause, code, details });
}

export function consoleConflictError(
  message: string,
  code: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): ConsoleOperationError {
  return new ConsoleOperationError("conflict", message, { cause, code, details });
}

export type ConsoleActionErrorVerdict = {
  message: string;
  status: 400 | 500;
};

export function classifyConsoleActionError(
  error: unknown,
  fallbackMessage: string,
): ConsoleActionErrorVerdict {
  if (error instanceof Error && error.constructor === Error && error.message) {
    return { message: error.message, status: 400 };
  }
  return { message: fallbackMessage, status: 500 };
}

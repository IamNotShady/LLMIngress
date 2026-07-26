import { randomUUID } from "node:crypto";
import { createLogger } from "@llmingress/logging";
import { NextResponse } from "next/server";
import { classifyConsoleActionError } from "./_error-classify";

const logger = createLogger("console-api");

/**
 * What to tell the operator, and what to write down. An unexpected failure gets
 * an id here rather than at the point it is rendered, so a refusal shown in a
 * dialog and a refusal returned as JSON are the same event in the log.
 */
export function classifyAndLogConsoleActionError(
  error: unknown,
  fallbackMessage: string,
): { code: string; details?: unknown; errorId?: string; message: string; status: number } {
  const verdict = classifyConsoleActionError(error, fallbackMessage);
  if (verdict.status !== 500) {
    return verdict;
  }
  const errorId = randomUUID();
  logger.error({ err: error, errorId }, "unexpected console api error");
  return { ...verdict, errorId };
}

export function consoleActionErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const { errorId, ...verdict } = classifyAndLogConsoleActionError(error, fallbackMessage);
  return NextResponse.json(
    {
      error: verdict.message,
      code: verdict.code,
      ...(verdict.details ? { details: verdict.details } : {}),
      ...(errorId ? { errorId } : {}),
    },
    { status: verdict.status },
  );
}

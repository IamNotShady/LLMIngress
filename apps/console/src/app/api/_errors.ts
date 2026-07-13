import { randomUUID } from "node:crypto";
import { createLogger } from "@llmingress/logging";
import { NextResponse } from "next/server";
import { classifyConsoleActionError } from "./_error-classify";

const logger = createLogger("console-api");

export function consoleActionErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const verdict = classifyConsoleActionError(error, fallbackMessage);
  const errorId = verdict.status === 500 ? randomUUID() : undefined;
  if (verdict.status === 500) {
    logger.error({ err: error, errorId }, "unexpected console api error");
  }
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

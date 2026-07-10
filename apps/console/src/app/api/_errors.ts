import { createLogger } from "@llmingress/logging";
import { NextResponse } from "next/server";
import { classifyConsoleActionError } from "./_error-classify";

const logger = createLogger("console-api");

export function consoleActionErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const verdict = classifyConsoleActionError(error, fallbackMessage);
  if (verdict.status === 500) {
    logger.error({ err: error }, "unexpected error");
  }
  return NextResponse.json({ error: verdict.message }, { status: verdict.status });
}

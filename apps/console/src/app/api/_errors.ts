import { NextResponse } from "next/server";
import { classifyConsoleActionError } from "./_error-classify";

export function consoleActionErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const verdict = classifyConsoleActionError(error, fallbackMessage);
  if (verdict.status === 500) {
    console.error("[console-api] unexpected error", error);
  }
  return NextResponse.json({ error: verdict.message }, { status: verdict.status });
}

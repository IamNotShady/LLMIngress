import { type LoggerOptions, pino } from "pino";

export type Logger = ReturnType<typeof createLogger>;

export const sensitiveLogRedactionPaths = [
  "authorization",
  "body",
  "cookie",
  "requestBody",
  "token",
  '["x-api-key"]',
  "*.token",
  "headers.authorization",
  "headers.cookie",
  'headers["x-api-key"]',
  "payload.body",
  "payload.requestBody",
  "providerRequestHeaders.authorization",
  'providerRequestHeaders["x-api-key"]',
  "req.body",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "request.body",
  "request.headers.authorization",
  "request.headers.cookie",
  'request.headers["x-api-key"]',
] as const;

export function createPinoLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL?.trim() || "info",
    redact: {
      censor: "[REDACTED]",
      paths: [...sensitiveLogRedactionPaths],
    },
  };
}

const rootLogger = pino(createPinoLoggerOptions());

export function createLogger(component: string) {
  return rootLogger.child({ component });
}

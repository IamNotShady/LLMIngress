import { pino } from "pino";

export type Logger = ReturnType<typeof createLogger>;

const rootLogger = pino({
  level: process.env.LOG_LEVEL?.trim() || "info",
});

export function createLogger(component: string) {
  return rootLogger.child({ component });
}

import type { ConsoleUsageWindow } from "@llmingress/db/console-usage";

const dayMs = 24 * 60 * 60 * 1000;

export function resolveConsoleUsageDateRange(input: {
  dateFrom?: string;
  dateTo?: string;
  now: Date;
  window: ConsoleUsageWindow;
}): {
  dateFromValue: string;
  dateToValue: string;
  endExclusive: Date;
  start: Date;
} {
  const today = startOfUtcDay(input.now);
  const defaultStart = new Date(today.getTime() - (calendarDayCount(input.window) - 1) * dayMs);
  const start = parseUtcDate(input.dateFrom) ?? defaultStart;
  const requestedEnd = parseUtcDate(input.dateTo) ?? today;
  const inclusiveEnd = requestedEnd.getTime() < start.getTime() ? start : requestedEnd;

  return {
    dateFromValue: formatUtcDate(start),
    dateToValue: formatUtcDate(inclusiveEnd),
    endExclusive: new Date(inclusiveEnd.getTime() + dayMs),
    start,
  };
}

function calendarDayCount(window: ConsoleUsageWindow): number {
  if (window === "30d") {
    return 30;
  }
  if (window === "7d") {
    return 7;
  }
  return 1;
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseUtcDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || formatUtcDate(date) !== value ? null : date;
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

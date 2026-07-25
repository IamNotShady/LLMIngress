export function formatRelativeDateTime(value: Date | string, referenceTimeMs: number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const elapsedMs = referenceTimeMs - date.getTime();
  if (elapsedMs < 60_000) {
    return "just now";
  }
  if (elapsedMs < 3_600_000) {
    return `${Math.floor(elapsedMs / 60_000)} min ago`;
  }
  if (elapsedMs < 86_400_000) {
    return `${Math.floor(elapsedMs / 3_600_000)} h ago`;
  }
  return date.toISOString().slice(0, 10);
}

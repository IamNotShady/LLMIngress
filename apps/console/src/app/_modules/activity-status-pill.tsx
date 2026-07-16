export function ActivityStatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") {
    return <span className="pill--ok pill">Success</span>;
  }
  if (normalized === "error" || normalized === "failed" || normalized === "failure") {
    return <span className="pill--danger pill">Failed</span>;
  }
  return <span className="pill">{status}</span>;
}

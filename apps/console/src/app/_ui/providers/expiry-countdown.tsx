"use client";

import { useEffect, useState } from "react";

function remainingLabel(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * How long the provider will still accept this request. An authorization the
 * operator walks away from does not fail loudly — it just stops working — so
 * the dialog says how much time is left rather than letting them find out by
 * pasting a code that has quietly expired.
 */
export function ExpiryCountdown({ expiresAt, label }: { expiresAt: string; label: string }) {
  const target = new Date(expiresAt).getTime();
  // Null until the first tick: seeding this with the target makes now === target
  // on the first render, which reads as "expired" — a red line the operator sees
  // for a frame before it corrects itself. The server and the first client
  // render agree on the label alone, so there is nothing to correct.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!Number.isFinite(target)) {
    return null;
  }
  const expired = now !== null && now >= target;
  return (
    <span className={`ml-auto font-mono text-12 ${expired ? "text-redtx" : "text-faint"}`}>
      {now === null
        ? label
        : expired
          ? `${label} expired`
          : `${label} expires in ${remainingLabel(target, now)}`}
    </span>
  );
}

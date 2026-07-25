"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Overview is a live board, so it re-fetches on an interval. The stamp shows
 * when the data on screen was actually read, not when the page was opened.
 */
export function AutoRefresh({ intervalSeconds = 30 }: { intervalSeconds?: number }) {
  const router = useRouter();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    setUpdatedAt(new Date().toISOString().slice(11, 19));
    const timer = setInterval(() => {
      router.refresh();
      setUpdatedAt(new Date().toISOString().slice(11, 19));
    }, intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [intervalSeconds, router]);

  return (
    <span className="ml-auto font-mono text-13 text-faint">
      {updatedAt
        ? `updated ${updatedAt} UTC · auto ${intervalSeconds}s`
        : `auto ${intervalSeconds}s`}
    </span>
  );
}

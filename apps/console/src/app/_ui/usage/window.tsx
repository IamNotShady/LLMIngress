import type { ConsoleUsageWindow } from "@llmingress/db/console-usage";
import Link from "next/link";
import { buildHref, type SearchParams } from "../params";

const WINDOWS: ConsoleUsageWindow[] = ["24h", "7d", "30d"];

/** Segmented control; the active segment inverts to the primary fill. */
export function WindowPicker({
  params,
  pathname,
  window,
}: {
  params: SearchParams;
  pathname: string;
  window: ConsoleUsageWindow;
}) {
  return (
    <div className="flex overflow-hidden rounded-sm border border-rule">
      {WINDOWS.map((entry, index) => (
        <Link
          key={entry}
          href={buildHref(pathname, params, { window: entry })}
          className={`px-[11px] py-1 font-mono text-13 ${index > 0 ? "border-l border-rule" : ""} ${
            entry === window ? "bg-seg text-segfg" : "text-dim"
          }`}
        >
          {entry}
        </Link>
      ))}
    </div>
  );
}

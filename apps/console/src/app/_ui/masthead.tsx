"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activityHref } from "./cross-links";
import { consoleNavItems } from "./nav";
import { ThemeToggle } from "./theme-toggle";

export type MastheadProps = {
  /** Host of the gateway a client should point at, e.g. localhost:4000. */
  gatewayAddress: string;
  /** Connections currently recorded as unhealthy — click through to Providers. */
  unhealthyConnectionCount: number;
  /** Failed requests in the last 24h, badged on the Activity tab. */
  failedRequestCount: number;
};

export function Masthead({
  gatewayAddress,
  unhealthyConnectionCount,
  failedRequestCount,
}: MastheadProps) {
  const pathname = usePathname() || "/";

  return (
    <div className="sticky top-0 z-40 flex h-[54px] items-center gap-6 overflow-x-auto border-b border-hair bg-bg px-8">
      <div className="flex flex-none items-baseline gap-[9px]">
        <span className="font-sans text-165 font-semibold tracking-[-.01em] text-ink">
          LLMIngress
        </span>
        <span className="font-mono text-11 tracking-[.14em] text-dim">CONSOLE</span>
      </div>
      {/* The row keeps its full width; below the desktop target the masthead
          itself scrolls, so every module stays reachable instead of collapsing
          behind a menu. */}
      <nav aria-label="Console modules" className="flex h-[54px] flex-none items-stretch">
        {consoleNavItems.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const badged = item.href === "/activity" && failedRequestCount > 0;
          return (
            <span
              key={item.href}
              className={`flex items-center gap-[6px] px-[13px] font-sans text-14 ${
                active ? "font-semibold text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "text-dim"
              }`}
            >
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="flex h-[54px] items-center"
              >
                {item.label}
              </Link>
              {/* The count is about failures, so it opens them rather than the
                  module — the tab beside it is still the way to everything. */}
              {badged ? (
                <Link
                  href={activityHref({ status: "failed" })}
                  aria-label={`${failedRequestCount} failed requests in the last 24h`}
                  className="rounded-[2px] bg-red px-[5px] py-px font-mono text-11 font-medium text-white tabnum"
                >
                  {failedRequestCount}
                </Link>
              ) : null}
            </span>
          );
        })}
      </nav>
      <div className="ml-auto flex flex-none items-center gap-4">
        <span className="font-mono text-12 text-dim">gw · {gatewayAddress}</span>
        {unhealthyConnectionCount > 0 ? (
          <Link
            href="/providers"
            className="flex items-center gap-[6px] rounded-xs border border-ambbd bg-ambbg px-[9px] py-[3px] font-mono text-125 font-medium text-ambtx"
          >
            <span className="size-[6px] rounded-full bg-amber" />
            {/* Named as connections: the Providers page counts providers, and
                one failing key does not make its provider unhealthy. Two counts
                sharing the word "unhealthy" would disagree on screen. */}
            {unhealthyConnectionCount} connection
            {unhealthyConnectionCount === 1 ? "" : "s"} failing
          </Link>
        ) : null}
        <ThemeToggle />
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="cursor-pointer border-0 bg-transparent p-0 font-sans text-135 text-dim"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CopyButton } from "./copy-button";
import { activityHref } from "./cross-links";
import { consoleNavItems, findActiveNavItem } from "./nav";
import { MODULE_STATE_STORAGE_KEY, rememberedModuleHref, rememberedModuleQuery } from "./nav-state";
import { ThemeToggle } from "./theme-toggle";

export type MastheadProps = {
  /** Host of the gateway a client should point at, e.g. localhost:4000. */
  gatewayAddress: string;
  /** The whole url, which is what an agent's configuration needs. */
  gatewayBaseUrl: string;
  /** Connections currently recorded as unhealthy — click through to Providers. */
  unhealthyConnectionCount: number;
  /** Failed requests in the last 24h, badged on the Activity tab. */
  failedRequestCount: number;
};

export function Masthead({
  gatewayAddress,
  gatewayBaseUrl,
  unhealthyConnectionCount,
  failedRequestCount,
}: MastheadProps) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const search = useSearchParams().toString();
  const [rememberedQueries, setRememberedQueries] = useState<Record<string, string>>({});

  useEffect(() => {
    setRememberedQueries((current) => {
      // A click writes the module being left before navigation. On the next
      // route, that durable snapshot is newer than a stale in-memory value
      // carried by the reused masthead.
      const remembered = { ...current, ...readRememberedQueries() };
      const activeModule = findActiveNavItem(pathname);
      if (activeModule) {
        remembered[activeModule.href] = rememberedModuleQuery(activeModule.href, search);
      }
      try {
        window.localStorage.setItem(MODULE_STATE_STORAGE_KEY, JSON.stringify(remembered));
      } catch {
        // The current tab still remembers state when storage is unavailable.
      }
      return remembered;
    });
  }, [pathname, search]);

  const rememberCurrentModule = () => {
    const latest = readRememberedQueries();
    const activeModule = findActiveNavItem(pathname);
    if (activeModule) {
      latest[activeModule.href] = rememberedModuleQuery(activeModule.href, search);
      try {
        window.localStorage.setItem(MODULE_STATE_STORAGE_KEY, JSON.stringify(latest));
      } catch {
        // Navigation still works when storage is unavailable.
      }
    }
    setRememberedQueries(latest);
    return latest;
  };

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
          const rememberedQuery = active
            ? rememberedModuleQuery(item.href, search)
            : rememberedQueries[item.href];
          return (
            <span
              key={item.href}
              className={`flex items-center gap-[6px] px-[13px] font-sans text-14 ${
                active ? "shadow-[inset_0_-2px_0_var(--accent)]" : ""
              }`}
            >
              {/* The colour stays on the anchor: a bare one falls through to the
                  stylesheet's accent link colour, which turned the whole module
                  row blue. */}
              <Link
                href={
                  rememberedQuery === undefined
                    ? item.href
                    : rememberedModuleHref(item.href, rememberedQuery)
                }
                onClick={(event) => {
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  // Persist the module being left in the same event that starts
                  // navigation. The rendered href can already show the latest
                  // search while the effect has not written it yet.
                  const latest = rememberCurrentModule();
                  if (active) {
                    return;
                  }
                  // A server navigation can remount the masthead with empty
                  // client state. Read the durable snapshot at click time.
                  const storedQuery = latest[item.href];
                  if (storedQuery === undefined) {
                    return;
                  }
                  const storedHref = rememberedModuleHref(item.href, storedQuery);
                  if (storedHref !== item.href) {
                    event.preventDefault();
                    router.push(storedHref);
                  }
                }}
                onPointerDown={rememberCurrentModule}
                aria-current={active ? "page" : undefined}
                className={`flex h-[54px] items-center ${
                  active ? "font-semibold text-ink" : "text-dim"
                }`}
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
        {/* The address every agent has to be pointed at: copied from here
            rather than retyped from a screen. */}
        <span className="flex items-center gap-[6px] font-mono text-12 text-dim">
          gw · {gatewayAddress}
          <CopyButton label="the gateway address" size="row" value={gatewayBaseUrl}>
            Copy
          </CopyButton>
        </span>
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

function readRememberedQueries(): Record<string, string> {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(MODULE_STATE_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown> | null;
    const remembered: Record<string, string> = {};
    for (const item of consoleNavItems) {
      const query = stored?.[item.href];
      if (typeof query === "string") {
        remembered[item.href] = rememberedModuleQuery(item.href, query);
      }
    }
    return remembered;
  } catch {
    return {};
  }
}

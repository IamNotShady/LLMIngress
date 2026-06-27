"use client";

import { usePathname } from "next/navigation";
import { findActiveNavItem } from "../_lib/nav";

type TopbarProps = {
  gatewayStatusHealthy: boolean;
  gatewayStatusLabel: string;
};

export function Topbar({ gatewayStatusHealthy, gatewayStatusLabel }: TopbarProps) {
  const pathname = usePathname() || "/";
  const active = findActiveNavItem(pathname);

  return (
    <header className="topbar">
      <p className="topbar-title">{active?.pageTitle ?? active?.label ?? "Console"}</p>
      <div className="topbar-actions">
        <span className={`topbar-status${gatewayStatusHealthy ? "" : " is-warn"}`}>
          <span className="topbar-status-dot" aria-hidden="true" />
          {gatewayStatusLabel}
        </span>
        <a className="topbar-link" href="/runtime">
          Help
        </a>
        <span className="topbar-account">
          <span className="topbar-account-avatar" aria-hidden="true">
            A
          </span>
          Admin
        </span>
      </div>
    </header>
  );
}

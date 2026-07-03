"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { consoleNavItems, findActiveNavItem } from "../_lib/nav";
import { FlatIcon } from "./flat-icon";

type SidebarProps = {
  gatewayConfigVersionLabel: string;
  gatewayStatusHealthy: boolean;
  gatewayStatusLabel: string;
  gatewayUptimeLabel: string;
  gatewayUrlLabel: string;
  providerHealthyCount: number;
  providerUnhealthyCount: number;
};

export function Sidebar({
  gatewayConfigVersionLabel,
  gatewayStatusHealthy,
  gatewayStatusLabel,
  gatewayUptimeLabel,
  gatewayUrlLabel,
  providerHealthyCount,
  providerUnhealthyCount,
}: SidebarProps) {
  const pathname = usePathname() || "/";
  const active = findActiveNavItem(pathname);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true" />
        <span className="sidebar-wordmark">
          <span className="sidebar-wordmark-main">LLMIngress</span>
          <em className="sidebar-wordmark-sub">Console</em>
        </span>
      </div>

      <nav className="sidebar-nav" aria-label="Console sections">
        <ul className="nav-list">
          {consoleNavItems.map((item) => {
            const isActive = active?.href === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  // Explicit name keeps the link's accessible name exactly the
                  // module label (the icon + hint are supplementary context).
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  className={`nav-item${isActive ? " is-active" : ""}`}
                >
                  <span className="nav-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="nav-item-text">
                    <span className="nav-item-label">{item.label}</span>
                    <span className="nav-item-hint">{item.hint}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-runtime-card">
          <span
            className={`sidebar-account-dot${gatewayStatusHealthy ? "" : " is-warn"}`}
            aria-hidden="true"
          />
          <span className="sidebar-runtime-summary">
            {gatewayStatusLabel}
            <em>Gateway URL {gatewayUrlLabel}</em>
            <em>Config version {gatewayConfigVersionLabel}</em>
            <em>Uptime {gatewayUptimeLabel}</em>
            <span className="sidebar-runtime-providers">
              <span>Providers</span>
              <span
                className="sidebar-provider-health-count"
                aria-label={`${providerHealthyCount} healthy providers`}
                role="img"
              >
                <span className="sidebar-provider-dot is-ok" aria-hidden="true" />
                {providerHealthyCount}
              </span>
              <span
                className="sidebar-provider-health-count"
                aria-label={`${providerUnhealthyCount} unhealthy providers`}
                role="img"
              >
                <span className="sidebar-provider-dot is-warn" aria-hidden="true" />
                {providerUnhealthyCount}
              </span>
            </span>
          </span>
        </div>
        <div className="sidebar-footer-row">
          <form action="/api/auth/logout" method="post">
            <button className="secondary-button" type="submit">
              <FlatIcon name="lock" />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

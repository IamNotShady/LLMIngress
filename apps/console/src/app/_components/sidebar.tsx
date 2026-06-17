"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { consoleNavGroups, findActiveNavItem } from "../_lib/nav";
import { ThemeToggle } from "./theme-toggle";

export function Sidebar() {
  const pathname = usePathname() || "/";
  const active = findActiveNavItem(pathname);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true">
          ⌁
        </span>
        <span className="sidebar-wordmark">
          LLM<span>Ingress</span>
        </span>
      </div>

      <nav className="sidebar-nav" aria-label="Console sections">
        {consoleNavGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <p className="nav-group-label">{group.label}</p>
            <ul className="nav-list">
              {group.items.map((item) => {
                const isActive = active?.href === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      // Explicit name keeps the link's accessible name exactly the
                      // module label (the hint is supplementary visual context).
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={`nav-item${isActive ? " is-active" : ""}`}
                    >
                      <span className="nav-item-label">{item.label}</span>
                      <span className="nav-item-hint">{item.hint}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-account">
          <span className="sidebar-account-dot" aria-hidden="true" />
          <span>Signed in as admin</span>
        </div>
        <div className="sidebar-footer-row">
          <ThemeToggle />
          <form action="/api/auth/logout" method="post">
            <button className="secondary-button" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

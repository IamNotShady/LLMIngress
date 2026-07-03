"use client";

import { usePathname } from "next/navigation";
import { findActiveNavItem } from "../_lib/nav";

export function Topbar() {
  const pathname = usePathname() || "/";
  const active = findActiveNavItem(pathname);

  return (
    <header className="topbar">
      <p className="topbar-title">{active?.pageTitle ?? active?.label ?? "Console"}</p>
      <div className="topbar-actions">
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

"use client";

import { usePathname } from "next/navigation";
import { findActiveNavItem } from "../_lib/nav";

// Slim shell header shown above every console module (matches the prototype's
// top-right status cluster). The Gateway status pill is a lightweight static
// indicator here; live runtime detail lives on the Gateway Runtime page.
export function Topbar() {
  const pathname = usePathname() || "/";
  const active = findActiveNavItem(pathname);

  return (
    <header className="topbar">
      <p className="topbar-title">{active?.label ?? "Console"}</p>
      <div className="topbar-actions">
        <span className="topbar-status">
          <span className="topbar-status-dot" aria-hidden="true" />
          Gateway running
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

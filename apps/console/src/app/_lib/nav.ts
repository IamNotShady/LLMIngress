// Single source of truth for the console's module navigation.
// Imported by the sidebar shell AND by the navigation tests, so the rendered
// nav and its verification can never drift apart.

export type ConsoleNavItem = {
  /** Accessible link label, also used as the destination page's <h1>. */
  label: string;
  /** App Router path for this module. */
  href: string;
  /** Short supporting line shown under the label in the sidebar. */
  hint: string;
  /** Two-letter chip rendered as the nav item's icon (matches the prototype). */
  icon: string;
};

export type ConsoleNavGroup = {
  /** Section label shown above the group in the sidebar. */
  label: string;
  items: ConsoleNavItem[];
};

// Flat, ordered module list matching the redesigned console prototype
// (docs/UI/*). The sidebar renders this as a single icon-chip list.
export const consoleNavItems: ConsoleNavItem[] = [
  { label: "Overview", href: "/", hint: "Gateway & spend at a glance", icon: "OV" },
  { label: "Agents", href: "/agents", hint: "Agents & API keys", icon: "AG" },
  { label: "Providers", href: "/providers", hint: "Upstreams & health", icon: "PR" },
  { label: "Models", href: "/pricing", hint: "Provider models & prices", icon: "MO" },
  { label: "Virtual Models", href: "/models", hint: "Names, routes & fallback", icon: "VM" },
  { label: "Activity", href: "/activity", hint: "Recent requests", icon: "AC" },
  { label: "Usage & Cost", href: "/usage", hint: "Spend, tokens, savings", icon: "UC" },
  { label: "Limits", href: "/limits", hint: "Budgets & rate limits", icon: "LI" },
  { label: "Playground", href: "/playground", hint: "Send a live request", icon: "PG" },
  { label: "Gateway Runtime", href: "/runtime", hint: "Status & connectivity", icon: "GW" },
  { label: "Settings", href: "/settings", hint: "Config, export, danger zone", icon: "ST" },
];

// Back-compat single group so existing imports resolve. The redesigned sidebar
// renders the flat `consoleNavItems` list (no visible group labels), matching
// the prototype.
export const consoleNavGroups: ConsoleNavGroup[] = [{ label: "Console", items: consoleNavItems }];

/** Resolve the active nav item for a given pathname (longest matching href wins). */
export function findActiveNavItem(pathname: string): ConsoleNavItem | undefined {
  const matches = consoleNavItems
    .filter((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length);
  return matches[0];
}

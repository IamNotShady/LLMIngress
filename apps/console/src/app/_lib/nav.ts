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
};

export type ConsoleNavGroup = {
  /** Section label shown above the group in the sidebar. */
  label: string;
  items: ConsoleNavItem[];
};

export const consoleNavGroups: ConsoleNavGroup[] = [
  {
    label: "Monitor",
    items: [
      { label: "Overview", href: "/", hint: "Gateway runtime health" },
      { label: "Usage & Cost", href: "/usage", hint: "Spend, tokens, savings" },
      { label: "Activity", href: "/activity", hint: "Recent requests" },
    ],
  },
  {
    label: "Routing",
    items: [
      { label: "Virtual Models", href: "/models", hint: "Public model names" },
      { label: "Route Policies", href: "/routing", hint: "Primary & fallback routes" },
    ],
  },
  {
    label: "Access",
    items: [{ label: "Agents", href: "/agents", hint: "Agents & API keys" }],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Providers", href: "/providers", hint: "Upstreams & health" },
      { label: "Pricing", href: "/pricing", hint: "Model price overrides" },
    ],
  },
  {
    label: "Tools",
    items: [{ label: "Playground", href: "/playground", hint: "Send a live request" }],
  },
  {
    label: "System",
    items: [{ label: "Settings", href: "/settings", hint: "Notifications & config" }],
  },
];

export const consoleNavItems: ConsoleNavItem[] = consoleNavGroups.flatMap((group) => group.items);

/** Resolve the active nav item for a given pathname (longest matching href wins). */
export function findActiveNavItem(pathname: string): ConsoleNavItem | undefined {
  const matches = consoleNavItems
    .filter((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length);
  return matches[0];
}

// Single source of truth for the console's module navigation. The masthead
// renders this row and the navigation tests read the same list, so the rendered
// nav and its verification can never drift apart.
//
// Order is the grouping: Overview │ Providers · Virtual Models │ API Keys ·
// Limits │ Activity · Usage │ Playground. The grouping shows up only in the
// order — there is no second-level menu.

export type ConsoleNavItem = {
  /** Link label shown in the masthead. */
  label: string;
  /** App Router path for this module. */
  href: string;
};

export const consoleNavItems: ConsoleNavItem[] = [
  { label: "Overview", href: "/" },
  { label: "Providers", href: "/providers" },
  { label: "Virtual Models", href: "/models" },
  { label: "API Keys", href: "/api-keys" },
  { label: "Limits", href: "/limits" },
  { label: "Activity", href: "/activity" },
  { label: "Usage", href: "/usage" },
  { label: "Playground", href: "/playground" },
];

/** Resolve the active nav item for a pathname (longest matching href wins). */
export function findActiveNavItem(pathname: string): ConsoleNavItem | undefined {
  return consoleNavItems
    .filter((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

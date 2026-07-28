import { findActiveNavItem } from "./nav";

export const MODULE_STATE_STORAGE_KEY = "llmingress:console-module-state:v1";

const rememberedKeys: Record<string, readonly string[]> = {
  "/": ["setup", "window"],
  "/activity": ["apiKey", "page", "protocol", "provider", "q", "status", "virtualModel", "window"],
  "/api-keys": ["q", "selected"],
  "/limits": ["q", "state"],
  "/models": ["selected", "strategy"],
  "/playground": [],
  "/providers": ["availability", "modelPage", "modelPageSize", "modelQuery", "selected"],
  "/usage": ["window"],
};

/**
 * Keep only durable view choices. Dialogs, drawers, mutation drafts, OAuth
 * callbacks, toasts and secrets must never be restored by module navigation.
 */
export function rememberedModuleQuery(pathname: string, query: string): string {
  const modulePath = findActiveNavItem(pathname)?.href;
  if (!modulePath) {
    return "";
  }
  const allowed = new Set(rememberedKeys[modulePath] ?? []);
  const source = new URLSearchParams(query);
  const remembered = new URLSearchParams();
  for (const [key, value] of source) {
    if (allowed.has(key) && value) {
      remembered.append(key, value);
    }
  }
  return remembered.toString();
}

export function rememberedModuleHref(pathname: string, query: string): string {
  const remembered = rememberedModuleQuery(pathname, query);
  return remembered ? `${pathname}?${remembered}` : pathname;
}

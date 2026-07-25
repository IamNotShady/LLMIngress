// Theme resolution has exactly one rule: an explicit stored choice wins, and
// without one the console follows the operating system. Both the pre-paint
// bootstrap and the nav toggle apply that rule to the same attribute.

export const THEME_STORAGE_KEY = "llmingress-console-theme";

export type ConsoleTheme = "light" | "dark";

export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{
var stored=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
var theme=stored==="light"||stored==="dark"?stored:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
document.documentElement.setAttribute("data-theme",theme);
}catch(e){document.documentElement.setAttribute("data-theme","light")}})()`;

export function readStoredTheme(): ConsoleTheme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

export function systemTheme(): ConsoleTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: ConsoleTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A blocked storage write only costs persistence, not the current toggle.
  }
}

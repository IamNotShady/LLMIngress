"use client";

import { useEffect, useState } from "react";
import { applyTheme, type ConsoleTheme, readStoredTheme, systemTheme } from "./theme";

export function ThemeToggle() {
  // The pre-paint bootstrap already stamped data-theme; this mirrors it into
  // React state on mount so the label and knob match what is on screen.
  const [theme, setTheme] = useState<ConsoleTheme>("light");

  useEffect(() => {
    setTheme(readStoredTheme() ?? systemTheme());
  }, []);

  const next: ConsoleTheme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      aria-label={`Switch to ${next} theme`}
      className="flex cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0"
    >
      <span className="font-mono text-115 tracking-[.08em] text-dim">
        {theme === "dark" ? "DARK" : "LIGHT"}
      </span>
      <span className="relative inline-block h-4 w-[30px] rounded-[9px] border border-rule bg-track">
        <span
          className="absolute top-[1.5px] size-[11px] rounded-full bg-ink transition-[left] duration-150"
          style={{ left: theme === "dark" ? "16px" : "2px" }}
        />
      </span>
    </button>
  );
}

import type { ReactNode } from "react";

// Monochrome line-icon set (Lucide-style geometry) drawn inline as SVG so every
// icon inherits the current text color and reads consistently across light and
// dark. The component contract is intentionally unchanged from the previous
// flat-color-icons implementation — same name union, same `flat-icon` class — so
// all call sites and the `:has(.flat-icon)` CSS keep working untouched.

export type FlatIconName =
  | "add"
  | "cancel"
  | "confirm"
  | "copy"
  | "delete"
  | "disable"
  | "edit"
  | "enable"
  | "filter"
  | "hide"
  | "key"
  | "lock"
  | "probe"
  | "refresh"
  | "save"
  | "settings"
  | "unlock"
  | "view";

const icons: Record<FlatIconName, ReactNode> = {
  add: <path d="M12 5v14M5 12h14" />,
  cancel: <path d="M18 6 6 18M6 6l12 12" />,
  confirm: <path d="M20 6 9 17l-5-5" />,
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  delete: (
    <>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  disable: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>
  ),
  edit: <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />,
  enable: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  filter: <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
  hide: (
    <>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M6.61 6.61A18.9 18.9 0 0 0 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="m2 2 20 20" />
    </>
  ),
  key: (
    <>
      <circle cx="15.5" cy="8.5" r="5.5" />
      <path d="m11.6 12.4-8.6 8.6 2 2M7 17l2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="11" width="17" height="10.5" rx="2" />
      <path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4" />
    </>
  ),
  probe: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16M3 21v-5h5" />
    </>
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="11" width="17" height="10.5" rx="2" />
      <path d="M7.5 11V7a4.5 4.5 0 0 1 8.6-1.8" />
    </>
  ),
  view: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export function FlatIcon({ className, name }: { className?: string; name: FlatIconName }) {
  return (
    <svg
      aria-hidden="true"
      className={className ? `flat-icon ${className}` : "flat-icon"}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.6}
      viewBox="0 0 24 24"
    >
      {icons[name]}
    </svg>
  );
}

"use client";

import { useState } from "react";
import { FlatIcon } from "./flat-icon";

// A fixed-width mask: the placeholder must not leak the secret's real length.
const maskedPlaceholder = "•".repeat(24);

export function SecretRevealField({
  hideable = false,
  label,
  value,
}: {
  hideable?: boolean;
  label: string;
  value: string;
}) {
  // The field always starts readable. `hideable` only decides whether the
  // caller offers a way to cover it up again.
  const [revealed, setRevealed] = useState(true);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the input stays selectable.
    }
  }

  return (
    <span className="api-key-reveal-field">
      <input
        aria-label={label}
        className="mono"
        readOnly
        value={revealed ? value : maskedPlaceholder}
      />
      {hideable ? (
        <button
          aria-label={`${revealed ? "Hide" : "Show"} ${label}`}
          className="secondary-button row-action-button"
          onClick={() => setRevealed((current) => !current)}
          title={`${revealed ? "Hide" : "Show"} ${label}`}
          type="button"
        >
          <FlatIcon name={revealed ? "hide" : "view"} />
        </button>
      ) : null}
      <button
        aria-label={`Copy ${label}`}
        className="secondary-button row-action-button"
        onClick={copy}
        title={copied ? "Copied" : `Copy ${label}`}
        type="button"
      >
        <FlatIcon name={copied ? "confirm" : "copy"} />
      </button>
    </span>
  );
}

"use client";

import { useState } from "react";
import { API_KEY_PLACEHOLDER, buildIntegrationGuides } from "../_ui/api-keys/integration-guide";

export function IntegrationGuideTabs({
  apiKey,
  gatewayBaseUrl,
  idPrefix,
  keyPrefix,
  model,
}: {
  apiKey: string;
  gatewayBaseUrl: string;
  idPrefix: string;
  keyPrefix?: string | null;
  model: string;
}) {
  const guides = buildIntegrationGuides({ apiKey, gatewayBaseUrl, model });
  const fallback = guides[0];
  if (!fallback) {
    throw new Error("Integration guides are required.");
  }
  const [activePlatform, setActivePlatform] = useState(fallback.platform);
  const active = guides.find((entry) => entry.platform === activePlatform) ?? fallback;

  return (
    <div className="api-key-integration-guide-tabs">
      <div className="api-key-integration-tabs" role="tablist" aria-label="Integration platform">
        {guides.map((entry) => (
          <button
            aria-controls={`${idPrefix}-integration-panel`}
            aria-selected={entry.platform === active.platform}
            className={entry.platform === active.platform ? "is-active" : undefined}
            id={`${idPrefix}-integration-tab-${entry.platform}`}
            key={entry.platform}
            onClick={() => setActivePlatform(entry.platform)}
            role="tab"
            type="button"
          >
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${idPrefix}-integration-tab-${active.platform}`}
        className="api-key-configuration-guide"
        id={`${idPrefix}-integration-panel`}
        role="tabpanel"
      >
        {keyPrefix ? (
          <p className="api-key-integration-key-note">
            Replace {API_KEY_PLACEHOLDER} with the API key that starts with{" "}
            <code className="mono">{keyPrefix}</code>. The full key was shown once at creation.
          </p>
        ) : null}
        <h4>{active.guide.title}</h4>
        <ol>
          {active.guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {active.guide.codeBlocks.map((block) => (
          <div key={block.label}>
            <h5>{block.label}</h5>
            <pre>
              <code>{block.code}</code>
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

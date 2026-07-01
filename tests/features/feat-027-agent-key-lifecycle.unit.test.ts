import {
  buildAgentApiKeyHash,
  generateAgentApiKeyPlaintext,
  prepareAgentApiKeyForStorage,
} from "@llmingress/db/console-agents";
import { describe, expect, it } from "vitest";

describe("feat-027 agent-owned API key", () => {
  it("generates high-entropy Agent API keys and stores only prefix plus hash", () => {
    const plaintext = generateAgentApiKeyPlaintext();
    const stored = prepareAgentApiKeyForStorage(plaintext);

    expect(plaintext).toMatch(/^llmi_[A-Za-z0-9_-]{32,}$/);
    expect(stored.keyPrefix).toBe(plaintext.slice(0, 12));
    expect(stored.keyHash).toBe(buildAgentApiKeyHash(plaintext));
    expect(stored.keyHash).not.toContain(plaintext);
    expect(JSON.stringify(stored)).not.toContain(plaintext);
  });

  it("rejects blank or too-short Agent API key plaintext", () => {
    expect(() => prepareAgentApiKeyForStorage("")).toThrow(/required/i);
    expect(() => prepareAgentApiKeyForStorage("llmi_short")).toThrow(/longer than the stored/i);
  });

  it("normalizes plaintext before hashing and prefix extraction", () => {
    const plaintext = `${generateAgentApiKeyPlaintext()}   `;
    const stored = prepareAgentApiKeyForStorage(plaintext);
    const normalized = plaintext.trim();

    expect(stored.keyPrefix).toBe(normalized.slice(0, 12));
    expect(stored.keyHash).toBe(buildAgentApiKeyHash(normalized));
  });
});

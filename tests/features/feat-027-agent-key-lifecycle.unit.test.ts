import { describe, expect, it } from "vitest";
import {
  buildAgentApiKeyHash,
  generateAgentApiKeyPlaintext,
  prepareAgentApiKeyForStorage,
  toAgentApiKeyMetadata,
} from "../../apps/console/src/server/agent-api-keys";

describe("feat-027 agent API key lifecycle", () => {
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

  it("maps persisted rows to metadata without plaintext or hash", () => {
    const metadata = toAgentApiKeyMetadata({
      agent_id: "agent-027",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      enabled: true,
      id: "key-027",
      key_hash: "hash-secret",
      key_prefix: "llmi_prefix",
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(metadata).toEqual({
      agentId: "agent-027",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      enabled: true,
      id: "key-027",
      keyPrefix: "llmi_prefix",
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(metadata).not.toHaveProperty("plaintext");
    expect(metadata).not.toHaveProperty("keyHash");
  });
});

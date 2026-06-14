import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatAgentApiKeyVirtualModelAccess,
  normalizeAgentApiKeyVirtualModelAccessInput,
} from "../../apps/console/src/server/agent-api-keys";

describe("feat-030 allowed and default virtual models", () => {
  it("normalizes allowed virtual models and default virtual model form input", () => {
    const keyId = randomUUID();
    const fastVirtualModelId = randomUUID();
    const strongVirtualModelId = randomUUID();

    expect(
      normalizeAgentApiKeyVirtualModelAccessInput({
        allowedVirtualModelIds: ["", ` ${fastVirtualModelId} `, strongVirtualModelId],
        defaultVirtualModelId: ` ${fastVirtualModelId} `,
        id: ` ${keyId} `,
      }),
    ).toEqual({
      allowedVirtualModelIds: [fastVirtualModelId, strongVirtualModelId],
      defaultVirtualModelId: fastVirtualModelId,
      id: keyId,
    });
  });

  it("rejects defaults that are not included in the allowed virtual model list", () => {
    const keyId = randomUUID();
    const allowedVirtualModelId = randomUUID();
    const disallowedDefaultId = randomUUID();

    expect(() =>
      normalizeAgentApiKeyVirtualModelAccessInput({
        allowedVirtualModelIds: [allowedVirtualModelId],
        defaultVirtualModelId: disallowedDefaultId,
        id: keyId,
      }),
    ).toThrow(/default virtual model.*allowed/i);
  });

  it("formats persisted access state for the dashboard", () => {
    expect(
      formatAgentApiKeyVirtualModelAccess({
        allowedVirtualModels: [
          { displayName: "Coding Fast", id: "vm-fast", name: "coding-fast" },
          { displayName: "Coding Strong", id: "vm-strong", name: "coding-strong" },
        ],
        defaultVirtualModel: { displayName: "Coding Fast", id: "vm-fast", name: "coding-fast" },
      }),
    ).toEqual({
      allowedLabel: "Coding Fast (coding-fast), Coding Strong (coding-strong)",
      defaultLabel: "Coding Fast (coding-fast)",
    });
  });
});

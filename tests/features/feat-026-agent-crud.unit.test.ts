import { describe, expect, it } from "vitest";
import {
  getAgentDeleteDependencyError,
  normalizeAgentFormInput,
} from "../../apps/console/src/server/agents";

describe("feat-026 agent CRUD", () => {
  it("normalizes agent form input for persistence", () => {
    expect(
      normalizeAgentFormInput({
        agentType: " Coding ",
        name: " Codex CLI ",
      }),
    ).toEqual({
      agentType: "coding",
      name: "Codex CLI",
    });
  });

  it("rejects empty names and unsupported agent types", () => {
    expect(() =>
      normalizeAgentFormInput({
        agentType: "coding",
        name: "",
      }),
    ).toThrow(/agent name/i);

    expect(() =>
      normalizeAgentFormInput({
        agentType: "browser",
        name: "Browser Agent",
      }),
    ).toThrow(/agent type/i);
  });

  it("reports dependency errors before deleting agents", () => {
    expect(
      getAgentDeleteDependencyError({
        activeApiKeyCount: 1,
        requestAttributionCount: 0,
      }),
    ).toMatch(/active API keys/i);

    expect(
      getAgentDeleteDependencyError({
        activeApiKeyCount: 0,
        requestAttributionCount: 1,
      }),
    ).toMatch(/request attribution/i);

    expect(
      getAgentDeleteDependencyError({
        activeApiKeyCount: 0,
        requestAttributionCount: 0,
      }),
    ).toBeNull();
  });
});

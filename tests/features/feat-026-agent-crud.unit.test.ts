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
      integrationPlatform: "other",
      name: "Codex CLI",
      requestLoggingEnabled: true,
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
        requestAttributionCount: 0,
      }),
    ).toBeNull();

    expect(
      getAgentDeleteDependencyError({
        requestAttributionCount: 1,
      }),
    ).toMatch(/request attribution/i);

    expect(
      getAgentDeleteDependencyError({
        requestAttributionCount: 0,
      }),
    ).toBeNull();
  });
});

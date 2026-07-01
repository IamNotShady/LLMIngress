import {
  getAgentDeleteDependencyError,
  normalizeAgentFormInput,
} from "@llmingress/db/console-agents";
import { describe, expect, it } from "vitest";

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

  it("allows deleting agents with historical request attribution", () => {
    expect(
      getAgentDeleteDependencyError({
        requestAttributionCount: 0,
      }),
    ).toBeNull();

    expect(
      getAgentDeleteDependencyError({
        requestAttributionCount: 1,
      }),
    ).toBeNull();

    expect(
      getAgentDeleteDependencyError({
        requestAttributionCount: 0,
      }),
    ).toBeNull();
  });
});

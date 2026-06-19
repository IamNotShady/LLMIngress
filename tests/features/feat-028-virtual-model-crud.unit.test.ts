import { describe, expect, it } from "vitest";
import {
  getVirtualModelDeleteDependencyError,
  normalizeVirtualModelFormInput,
} from "../../apps/console/src/server/virtual-models";

describe("feat-028 virtual model CRUD", () => {
  it("normalizes virtual model form input for persistence", () => {
    expect(
      normalizeVirtualModelFormInput({
        displayName: " Coding Fast ",
        name: " Coding Fast ",
      }),
    ).toEqual({
      displayName: "Coding Fast",
      name: "coding-fast",
    });
  });

  it("rejects empty names and invalid virtual model names", () => {
    expect(() =>
      normalizeVirtualModelFormInput({
        displayName: "Coding Fast",
        name: "",
      }),
    ).toThrow(/virtual model name/i);

    expect(() =>
      normalizeVirtualModelFormInput({
        displayName: "Coding Fast",
        name: "bad/name",
      }),
    ).toThrow(/lowercase letters/i);
  });

  it("reports dependency errors before deleting referenced virtual models", () => {
    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 0,
        routePolicyCount: 1,
      }),
    ).toMatch(/route/i);

    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 1,
        defaultAgentCount: 0,
        routePolicyCount: 0,
      }),
    ).toMatch(/agent/i);

    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 0,
        routePolicyCount: 0,
      }),
    ).toBeNull();
  });
});

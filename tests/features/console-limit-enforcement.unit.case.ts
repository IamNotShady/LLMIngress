import { describe, expect, it } from "vitest";
import { normalizeApiKeyLimitRulesInput } from "../../packages/db/src/console-api-key-limits.ts";

describe("api key limit enforcement policy", () => {
  it("defaults every rule to block when the form does not say otherwise", () => {
    const rules = normalizeApiKeyLimitRulesInput({
      budgetPeriod: "month",
      budgetUsd: "25",
      concurrency: "4",
      rpm: "120",
      tokenLimit: "16384",
      tpm: "50000",
    });

    expect(rules.every((rule) => rule.enforcementPolicy === "block")).toBe(true);
  });

  it("carries warn_only onto every rule so one key never mixes policies", () => {
    const rules = normalizeApiKeyLimitRulesInput({
      budgetPeriod: "month",
      budgetUsd: "25",
      concurrency: "4",
      enforcementPolicy: "warn_only",
      rpm: "120",
      tokenLimit: "16384",
      tpm: "50000",
    });

    // The Limits drawer offers one enforcement control for the key, so a mixed
    // set of policies could never be produced or displayed faithfully.
    expect(rules.map((rule) => rule.limitType).sort()).toEqual([
      "budget",
      "concurrency",
      "rpm",
      "token",
      "tpm",
    ]);
    expect(rules.every((rule) => rule.enforcementPolicy === "warn_only")).toBe(true);
  });

  it("leaves out the ceilings the form left blank", () => {
    const rules = normalizeApiKeyLimitRulesInput({
      budgetPeriod: "month",
      budgetUsd: "25",
      concurrency: "",
      rpm: "",
      tokenLimit: null,
      tpm: "50000",
    });

    // An empty field is unlimited, which is a rule that does not exist — not a
    // ceiling of zero, and not a reason to refuse the save.
    expect(rules.map((rule) => rule.limitType).sort()).toEqual(["budget", "tpm"]);
  });

  it("still refuses a ceiling that was typed and makes no sense", () => {
    expect(() =>
      normalizeApiKeyLimitRulesInput({
        budgetPeriod: "month",
        budgetUsd: "0",
        rpm: "120",
        tokenLimit: "16384",
        tpm: "50000",
      }),
    ).toThrow(/greater than zero/i);
  });

  it("rejects an enforcement value the database would not accept", () => {
    expect(() =>
      normalizeApiKeyLimitRulesInput({
        budgetPeriod: "month",
        budgetUsd: "25",
        enforcementPolicy: "ignore",
        rpm: "120",
        tokenLimit: "16384",
        tpm: "50000",
      }),
    ).toThrow(/enforcement/i);
  });
});

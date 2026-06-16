import { describe, expect, it } from "vitest";
import {
  formatAgentLimitSummaries,
  normalizeAgentLimitFormInput,
} from "../../apps/console/src/server/agent-limits";

describe("feat-031 Agent API key limit configuration", () => {
  it("normalizes budget rpm tpm and token limit form input", () => {
    expect(
      normalizeAgentLimitFormInput({
        agentApiKeyId: " key-031 ",
        budgetPeriod: " month ",
        budgetUsd: "10.50",
        rpm: "60",
        tokenLimit: "8000",
        tpm: "120000",
      }),
    ).toEqual({
      agentApiKeyId: "key-031",
      rules: [
        {
          limitType: "budget",
          limitValue: 10.5,
          period: "month",
          unit: "usd",
        },
        {
          limitType: "rpm",
          limitValue: 60,
          period: "minute",
          unit: "requests",
        },
        {
          limitType: "tpm",
          limitValue: 120000,
          period: "minute",
          unit: "tokens",
        },
        {
          limitType: "token",
          limitValue: 8000,
          period: "request",
          unit: "tokens",
        },
      ],
    });
  });

  it("rejects non-positive values and invalid budget periods", () => {
    expect(() =>
      normalizeAgentLimitFormInput({
        agentApiKeyId: "key-031",
        budgetPeriod: "minute",
        budgetUsd: "10",
        rpm: "60",
        tokenLimit: "8000",
        tpm: "120000",
      }),
    ).toThrow(/budget period/i);

    expect(() =>
      normalizeAgentLimitFormInput({
        agentApiKeyId: "key-031",
        budgetPeriod: "month",
        budgetUsd: "0",
        rpm: "60",
        tokenLimit: "8000",
        tpm: "120000",
      }),
    ).toThrow(/budget/i);
  });

  it("formats saved limit rules for the dashboard", () => {
    expect(
      formatAgentLimitSummaries([
        {
          agentApiKeyId: "key-031",
          enabled: true,
          id: "budget-limit",
          limitType: "budget",
          limitValue: 10,
          period: "month",
          unit: "usd",
        },
        {
          agentApiKeyId: "key-031",
          enabled: true,
          id: "rpm-limit",
          limitType: "rpm",
          limitValue: 60,
          period: "minute",
          unit: "requests",
        },
      ]),
    ).toEqual({
      budget: "$10.00 / month",
      rpm: "60 requests / minute",
      token: "Not configured",
      tpm: "Not configured",
    });
  });
});

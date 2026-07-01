import {
  formatAgentLimitSummaries,
  normalizeAgentLimitFormInput,
} from "@llmingress/db/console-agent-limits";
import { describe, expect, it } from "vitest";

describe("feat-031 Agent limit configuration", () => {
  it("normalizes budget rpm tpm concurrency token and alert threshold form input", () => {
    expect(
      normalizeAgentLimitFormInput({
        alertThresholdPercent: "75",
        agentId: " agent-031 ",
        budgetPeriod: " month ",
        budgetUsd: "10.50",
        concurrency: "4",
        rpm: "60",
        tokenLimit: "8000",
        tpm: "120000",
      }),
    ).toEqual({
      agentId: "agent-031",
      rules: [
        {
          alertThreshold: 0.75,
          enforcementPolicy: "block",
          limitType: "budget",
          limitValue: 10.5,
          manualBypass: false,
          period: "month",
          unit: "usd",
        },
        {
          alertThreshold: 0.75,
          enforcementPolicy: "block",
          limitType: "rpm",
          limitValue: 60,
          manualBypass: false,
          period: "minute",
          unit: "requests",
        },
        {
          alertThreshold: 0.75,
          enforcementPolicy: "block",
          limitType: "tpm",
          limitValue: 120000,
          manualBypass: false,
          period: "minute",
          unit: "tokens",
        },
        {
          alertThreshold: 0.75,
          enforcementPolicy: "block",
          limitType: "concurrency",
          limitValue: 4,
          manualBypass: false,
          period: "request",
          unit: "requests",
        },
        {
          alertThreshold: 0.75,
          enforcementPolicy: "block",
          limitType: "token",
          limitValue: 8000,
          manualBypass: false,
          period: "request",
          unit: "tokens",
        },
      ],
    });
  });

  it("defaults concurrency and alert threshold for older forms", () => {
    expect(
      normalizeAgentLimitFormInput({
        agentId: "agent-031",
        budgetPeriod: "month",
        budgetUsd: "10",
        rpm: "60",
        tokenLimit: "8000",
        tpm: "120000",
      }).rules,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alertThreshold: 0.8,
          limitType: "budget",
        }),
        expect.objectContaining({
          alertThreshold: 0.8,
          limitType: "concurrency",
          limitValue: 10,
          period: "request",
          unit: "requests",
        }),
      ]),
    );
  });

  it("rejects non-positive values and invalid budget periods", () => {
    expect(() =>
      normalizeAgentLimitFormInput({
        agentId: "agent-031",
        budgetPeriod: "minute",
        budgetUsd: "10",
        rpm: "60",
        tokenLimit: "8000",
        tpm: "120000",
      }),
    ).toThrow(/budget period/i);

    expect(() =>
      normalizeAgentLimitFormInput({
        agentId: "agent-031",
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
          agentId: "agent-031",
          enabled: true,
          id: "budget-limit",
          limitType: "budget",
          limitValue: 10,
          period: "month",
          unit: "usd",
        },
        {
          agentId: "agent-031",
          enabled: true,
          id: "rpm-limit",
          limitType: "rpm",
          limitValue: 60,
          period: "minute",
          unit: "requests",
        },
        {
          agentId: "agent-031",
          enabled: true,
          id: "concurrency-limit",
          limitType: "concurrency",
          limitValue: 4,
          period: "request",
          unit: "requests",
        },
      ]),
    ).toEqual({
      budget: "$10.00 / month",
      concurrency: "4 requests / request",
      rpm: "60 requests / minute",
      token: "Not configured",
      tpm: "Not configured",
    });
  });
});

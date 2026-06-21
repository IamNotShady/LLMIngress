import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCostReportExportDocument,
  type CostReportUsageSummary,
} from "../../apps/worker/src/cost-report-export";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-082 cost report export", () => {
  it("declares cost_report_export jobs and current job-result export tracking", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0017" && candidate.name === "cost_report_export",
    );
    const cleanupMigration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0039" && candidate.name === "merge_export_tasks_into_jobs",
    );

    expect(migration?.sql).toContain("'cost_report_export'");
    expect(migration?.sql).toContain("'cost_report'");
    expect(cleanupMigration?.sql).toContain("drop table if exists export_tasks");
  });

  it("registers cost_report_export in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createCostReportExportJobHandler");
    expect(workerMain).toContain("cost_report_export:");
  });

  it("builds a cost report document from usage summary totals and breakdowns", () => {
    const usageSummary: CostReportUsageSummary = {
      agentBreakdowns: [
        breakdown("agent-1", "Codex", {
          requestCount: 2,
          totalCostUsd: "0.00300000",
          totalSavingsUsd: "0.00600000",
          totalTokens: 600,
        }),
      ],
      breakdowns: [
        {
          failureCount: 0,
          modelId: "model-1",
          modelLabel: "GPT 4.1 Mini",
          providerId: "provider-1",
          providerLabel: "OpenAI",
          requestCount: 1,
          totalCostUsd: "0.00100000",
          totalSavingsUsd: "0.00200000",
          totalTokens: 200,
        },
      ],
      failureCount: 1,
      inputTokens: 200,
      modelBreakdowns: [
        breakdown("model-1", "GPT 4.1 Mini (gpt-4.1-mini)", {
          requestCount: 1,
          totalCostUsd: "0.00100000",
          totalSavingsUsd: "0.00200000",
          totalTokens: 200,
        }),
        breakdown("model-2", "Claude Haiku (claude-haiku-4-5)", {
          requestCount: 1,
          totalCostUsd: "0.00200000",
          totalSavingsUsd: "0.00400000",
          totalTokens: 400,
        }),
      ],
      outputTokens: 400,
      providerBreakdowns: [
        breakdown("provider-1", "OpenAI", {
          requestCount: 1,
          totalCostUsd: "0.00100000",
          totalSavingsUsd: "0.00200000",
          totalTokens: 200,
        }),
      ],
      requestCount: 3,
      totalCostUsd: "0.00300000",
      totalSavingsUsd: "0.00600000",
      totalTokens: 600,
      virtualModelBreakdowns: [
        breakdown("vm-1", "fast (fast)", {
          requestCount: 3,
          totalCostUsd: "0.00300000",
          totalSavingsUsd: "0.00600000",
          totalTokens: 600,
        }),
      ],
      window: "24h",
    };

    const report = buildCostReportExportDocument({
      generatedAt: new Date("2026-06-16T12:00:00.000Z"),
      usageSummary,
      windowStart: new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(report).toMatchObject({
      exportType: "cost_report",
      generatedAt: "2026-06-16T12:00:00.000Z",
      summary: {
        failureCount: 1,
        inputTokens: 200,
        outputTokens: 400,
        requestCount: 3,
        totalCostUsd: "0.00300000",
        totalSavingsUsd: "0.00600000",
        totalTokens: 600,
      },
      window: {
        end: "2026-06-16T12:00:00.000Z",
        label: "24h",
        start: "2026-06-15T12:00:00.000Z",
      },
    });
    expect(report.breakdowns.agents).toEqual(usageSummary.agentBreakdowns);
    expect(report.breakdowns.providerModels).toEqual(usageSummary.breakdowns);
    expect(report.breakdowns.virtualModels).toEqual(usageSummary.virtualModelBreakdowns);
    expect(report.breakdowns.providers).toEqual(usageSummary.providerBreakdowns);
    expect(report.breakdowns.models).toEqual(usageSummary.modelBreakdowns);
  });
});

function breakdown(
  id: string,
  label: string,
  input: {
    requestCount: number;
    totalCostUsd: string;
    totalSavingsUsd: string;
    totalTokens: number;
  },
) {
  return {
    failureCount: 0,
    id,
    label,
    requestCount: input.requestCount,
    totalCostUsd: input.totalCostUsd,
    totalSavingsUsd: input.totalSavingsUsd,
    totalTokens: input.totalTokens,
  };
}

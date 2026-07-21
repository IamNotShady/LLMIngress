import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("core Worker operations", () => {
  it("keeps provider maintenance handlers and leased job execution", () => {
    const workerMain = readFileSync("apps/worker/src/main.ts", "utf8");
    expect(workerMain).toContain("createModelRefreshJobHandler");
    expect(workerMain).toContain("createProviderConnectionProbeJobHandler");
    expect(workerMain).toContain("createPriceSyncJobHandler");
    expect(workerMain).toContain("createProviderQuotaProbeJobHandler");

    const runner = readFileSync("packages/worker-runtime/src/worker-job-runner.ts", "utf8");
    expect(runner).toContain("and run_after <= $4::timestamptz");
    expect(runner).toContain("renewJobLease");
    expect(runner).toContain("AbortSignal");
  });
});

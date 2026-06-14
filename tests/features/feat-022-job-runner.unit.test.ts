import { describe, expect, it } from "vitest";
import {
  type ClaimedJob,
  createJobRunner,
  JobHandlerError,
  type JobStore,
} from "../../apps/worker/src/job-runner";

describe("feat-022 worker job runner", () => {
  it("claims one pending job with a lease and persists a success result once", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const claimedJob = createClaimedJob({ attemptNumber: 1, id: "job-success" });
    const claimInputs: unknown[] = [];
    const completions: unknown[] = [];
    const store: JobStore = {
      claimNextJob: async (input) => {
        claimInputs.push(input);
        return claimedJob;
      },
      completeJob: async (input) => {
        completions.push(input);
        return true;
      },
      failJob: async () => {
        throw new Error("success path should not fail a job");
      },
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async (job) => ({ jobId: job.id, ok: true }),
      },
      leaseMs: 5_000,
      now: () => now,
      store,
      workerId: "worker-unit",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    expect(claimInputs).toEqual([
      {
        jobTypes: ["model_refresh"],
        leaseMs: 5_000,
        now,
        workerId: "worker-unit",
      },
    ]);
    expect(completions).toEqual([
      {
        attemptNumber: 1,
        jobId: "job-success",
        now,
        result: { jobId: "job-success", ok: true },
        workerId: "worker-unit",
      },
    ]);
  });

  it("does not claim unsupported job types when no handler is registered", async () => {
    const store: JobStore = {
      claimNextJob: async () => {
        throw new Error("runner should not claim without a registered handler");
      },
      completeJob: async () => false,
      failJob: async () => false,
    };
    const runner = createJobRunner({
      handlers: {},
      store,
      workerId: "worker-unit",
    });

    await expect(runner.runOnce()).resolves.toBe(false);
  });

  it("does not drop a job_created wake while an empty claim is in flight", async () => {
    let onJobCreated: (() => void) | undefined;
    let releaseFirstClaim: (() => void) | undefined;
    let claimCalls = 0;
    const store: JobStore = {
      claimNextJob: async () => {
        claimCalls += 1;
        if (claimCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstClaim = resolve;
          });
        }
        return null;
      },
      completeJob: async () => false,
      failJob: async () => false,
      subscribeJobCreated: async (callback) => {
        onJobCreated = callback;
        return { stop: async () => undefined };
      },
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async () => ({ ok: true }),
      },
      pollIntervalMs: 60_000,
      store,
      workerId: "worker-unit",
    });

    await runner.start();
    await waitFor(() => claimCalls === 1);
    onJobCreated?.();
    releaseFirstClaim?.();
    await waitFor(() => claimCalls === 2);
    await runner.stop();
  });

  it("retries failed jobs with backoff and records only one terminal result", async () => {
    const firstClaimedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstFailedAt = new Date("2026-01-01T00:00:05.000Z");
    const secondClaimedAt = new Date("2026-01-01T00:00:10.000Z");
    const secondCompletedAt = new Date("2026-01-01T00:00:11.000Z");
    const jobs = [
      createClaimedJob({ attemptNumber: 1, id: "job-retry", maxAttempts: 2 }),
      createClaimedJob({ attemptNumber: 2, id: "job-retry", maxAttempts: 2 }),
    ];
    const failures: unknown[] = [];
    const completions: unknown[] = [];
    const store: JobStore = {
      claimNextJob: async () => jobs.shift() ?? null,
      completeJob: async (input) => {
        completions.push(input);
        return true;
      },
      failJob: async (input) => {
        failures.push(input);
        return true;
      },
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async (job) => {
          if (job.attemptNumber === 1) {
            throw new JobHandlerError("temporary_failure", "temporary failure");
          }
          return { ok: true };
        },
      },
      now: (() => {
        const values = [firstClaimedAt, firstFailedAt, secondClaimedAt, secondCompletedAt];
        return () => values.shift() ?? secondCompletedAt;
      })(),
      retryBackoffMs: () => 250,
      store,
      workerId: "worker-unit",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(runner.runOnce()).resolves.toBe(true);

    expect(failures).toEqual([
      {
        attemptNumber: 1,
        errorCode: "temporary_failure",
        errorMessage: "temporary failure",
        jobId: "job-retry",
        now: firstFailedAt,
        retryAt: new Date("2026-01-01T00:00:05.250Z"),
        workerId: "worker-unit",
      },
    ]);
    expect(completions).toEqual([
      {
        attemptNumber: 2,
        jobId: "job-retry",
        now: secondCompletedAt,
        result: { ok: true },
        workerId: "worker-unit",
      },
    ]);
  });
});

function createClaimedJob(
  overrides: Partial<ClaimedJob> & Pick<ClaimedJob, "attemptNumber" | "id">,
): ClaimedJob {
  return {
    attemptNumber: overrides.attemptNumber,
    id: overrides.id,
    jobType: overrides.jobType ?? "model_refresh",
    maxAttempts: overrides.maxAttempts ?? 3,
    payload: overrides.payload ?? {},
    priority: overrides.priority ?? 0,
    trigger: overrides.trigger ?? "manual",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

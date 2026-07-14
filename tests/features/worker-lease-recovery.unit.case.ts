import { describe, expect, it } from "vitest";
import {
  type ClaimedJob,
  createJobRunner,
  type JobStore,
} from "../../packages/worker-runtime/src/worker-job-runner";

describe("worker-lease-recovery", () => {
  it("renews running job leases and aborts the handler when lease renewal is fenced out", async () => {
    const claimedJob: ClaimedJob = {
      attemptNumber: 1,
      id: "job-renew-fenced",
      jobType: "model_refresh",
      maxAttempts: 3,
      payload: {},
      priority: 0,
      trigger: "system",
    };
    let claimed = false;
    let renewCalls = 0;
    let completeCalls = 0;
    let failCalls = 0;
    let handlerSignal: AbortSignal | undefined;
    const store: JobStore = {
      cancelJob: async () => true,
      claimNextJob: async () => {
        if (claimed) {
          return null;
        }
        claimed = true;
        return claimedJob;
      },
      completeJob: async () => {
        completeCalls += 1;
        return true;
      },
      failJob: async () => {
        failCalls += 1;
        return true;
      },
      renewJobLease: async () => {
        renewCalls += 1;
        return false;
      },
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async (job) => {
          handlerSignal = job.signal;
          if (!job.signal.aborted) {
            await waitForAbort(job.signal);
          }
          return { observedAbort: job.signal.aborted };
        },
      },
      leaseMs: 15,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      store,
      workerId: "worker-renew-fenced",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    expect(handlerSignal).toBeInstanceOf(AbortSignal);
    expect(renewCalls).toBeGreaterThan(0);
    expect(completeCalls).toBe(0);
    expect(failCalls).toBe(0);
  });

  it("keeps renewing during shutdown grace and aborts current work after the grace elapses", async () => {
    const claimedJob: ClaimedJob = {
      attemptNumber: 1,
      id: "job-shutdown-grace",
      jobType: "model_refresh",
      maxAttempts: 3,
      payload: {},
      priority: 0,
      trigger: "system",
    };
    let claimed = false;
    let renewCalls = 0;
    let handlerSignal: AbortSignal | undefined;
    let handlerStarted: (() => void) | undefined;
    const handlerStartedPromise = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const store: JobStore = {
      cancelJob: async () => true,
      claimNextJob: async () => {
        if (claimed) {
          return null;
        }
        claimed = true;
        return claimedJob;
      },
      completeJob: async () => true,
      failJob: async () => true,
      renewJobLease: async () => {
        renewCalls += 1;
        return true;
      },
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async (job) => {
          handlerSignal = job.signal;
          handlerStarted?.();
          await waitForAbort(job.signal);
        },
      },
      leaseMs: 15,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      shutdownGraceMs: 25,
      store,
      workerId: "worker-shutdown-grace",
    });

    await runner.start();
    await handlerStartedPromise;
    await runner.stop();

    expect(handlerSignal?.aborted).toBe(true);
    expect(renewCalls).toBeGreaterThan(0);
  });
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

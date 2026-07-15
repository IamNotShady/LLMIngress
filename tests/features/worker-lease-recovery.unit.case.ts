import { describe, expect, it } from "vitest";
import {
  type ClaimedJob,
  createJobRunner,
  createResilientJobCreatedSubscription,
  JOB_CREATED_CHANNEL,
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

describe("worker poll loop self-heals on error (H1)", () => {
  it("re-arms the poll loop after claimNextJob throws once and still processes the job", async () => {
    const claimedJob: ClaimedJob = {
      attemptNumber: 1,
      id: "job-h1-claim",
      jobType: "model_refresh",
      maxAttempts: 3,
      payload: {},
      priority: 0,
      trigger: "system",
    };
    let claimCalls = 0;
    let processed = false;
    let resolveProcessed: () => void = () => undefined;
    const processedPromise = new Promise<void>((resolve) => {
      resolveProcessed = resolve;
    });
    const store: JobStore = {
      cancelJob: async () => true,
      claimNextJob: async () => {
        claimCalls += 1;
        if (claimCalls === 1) {
          throw new Error("transient claim failure");
        }
        if (claimCalls === 2) {
          return claimedJob;
        }
        return null;
      },
      completeJob: async () => {
        processed = true;
        resolveProcessed();
        return true;
      },
      failJob: async () => true,
      renewJobLease: async () => true,
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async () => ({ ok: true }),
      },
      pollIntervalMs: 10,
      store,
      workerId: "worker-h1-claim",
    });

    await runner.start();
    await withTimeout(processedPromise, 2_000);
    await runner.stop();

    expect(processed).toBe(true);
    expect(claimCalls).toBeGreaterThanOrEqual(2);
  });

  it("keeps the poll loop alive when terminal writes throw", async () => {
    const claimedJob: ClaimedJob = {
      attemptNumber: 1,
      id: "job-h1-terminal",
      jobType: "model_refresh",
      maxAttempts: 3,
      payload: {},
      priority: 0,
      trigger: "system",
    };
    let claimCalls = 0;
    let resolveSecondClaim: () => void = () => undefined;
    const secondClaim = new Promise<void>((resolve) => {
      resolveSecondClaim = resolve;
    });
    const store: JobStore = {
      cancelJob: async () => true,
      claimNextJob: async () => {
        claimCalls += 1;
        if (claimCalls === 1) {
          return claimedJob;
        }
        resolveSecondClaim();
        return null;
      },
      completeJob: async () => {
        throw new Error("complete write failed");
      },
      failJob: async () => {
        throw new Error("fail write failed");
      },
      renewJobLease: async () => true,
    };
    const runner = createJobRunner({
      handlers: {
        model_refresh: async () => ({ ok: true }),
      },
      pollIntervalMs: 10,
      store,
      workerId: "worker-h1-terminal",
    });

    await runner.start();
    await withTimeout(secondClaim, 2_000);
    await runner.stop();

    expect(claimCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("worker caps per-job runtime (H2)", () => {
  it("aborts a job that exceeds maxJobDurationMs and stops renewing its lease", async () => {
    const claimedJob: ClaimedJob = {
      attemptNumber: 1,
      id: "job-h2-max-duration",
      jobType: "model_refresh",
      maxAttempts: 3,
      payload: {},
      priority: 0,
      trigger: "system",
    };
    let claimed = false;
    let renewCalls = 0;
    let renewCallsAtAbort = -1;
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
          await waitForAbort(job.signal);
          renewCallsAtAbort = renewCalls;
          return { done: true };
        },
      },
      leaseMs: 30,
      maxJobDurationMs: 25,
      now: () => new Date(),
      store,
      workerId: "worker-h2-max-duration",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    expect(handlerSignal?.aborted).toBe(true);
    expect(renewCalls).toBeGreaterThan(0);
    expect(renewCalls).toBe(renewCallsAtAbort);
  });
});

describe("worker job_created subscription is resilient (M1)", () => {
  it("reconnects after a connection error and resubscribes, then stops cleanly", async () => {
    const clients: FakeListenClient[] = [];
    let connectCount = 0;
    let onJobCreatedCount = 0;
    const subscription = createResilientJobCreatedSubscription({
      backoffMs: { initial: 10, max: 20 },
      connect: () => {
        connectCount += 1;
        const client = createFakeListenClient();
        clients.push(client);
        return client;
      },
      onJobCreated: () => {
        onJobCreatedCount += 1;
      },
    });

    await subscription.start();
    expect(connectCount).toBe(1);
    expect(clients[0]?.listenCount).toBe(1);
    expect(onJobCreatedCount).toBe(1);

    clients[0]?.emit("notification", { channel: JOB_CREATED_CHANNEL });
    expect(onJobCreatedCount).toBe(2);

    clients[0]?.emit("error", new Error("connection reset"));

    await waitUntil(() => connectCount >= 2, 1_000);
    expect(connectCount).toBe(2);
    expect(clients[1]?.listenCount).toBe(1);
    expect(onJobCreatedCount).toBeGreaterThanOrEqual(3);

    const connectsBeforeStop = connectCount;
    await subscription.stop();
    expect(clients[1]?.ended).toBe(true);

    clients[1]?.emit("error", new Error("after stop"));
    await delay(50);
    expect(connectCount).toBe(connectsBeforeStop);

    await expect(subscription.stop()).resolves.toBeUndefined();
  });
});

type FakeListenClient = {
  ended: boolean;
  emit: (event: string, arg?: unknown) => void;
  end: () => Promise<void>;
  listenCount: number;
  on: (event: string, listener: (arg: unknown) => void) => void;
  query: (sql: string) => Promise<unknown>;
  removeAllListeners: () => void;
};

function createFakeListenClient(): FakeListenClient {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  const client: FakeListenClient = {
    ended: false,
    emit: (event, arg) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(arg);
      }
    },
    end: async () => {
      client.ended = true;
    },
    listenCount: 0,
    on: (event, listener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    query: async (sql) => {
      if (sql.toLowerCase().startsWith("listen")) {
        client.listenCount += 1;
      }
      return { rowCount: 0, rows: [] };
    },
    removeAllListeners: () => {
      listeners.clear();
    },
  };
  return client;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await delay(5);
  }
}

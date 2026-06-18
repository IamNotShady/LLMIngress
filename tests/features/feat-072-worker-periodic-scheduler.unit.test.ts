import { describe, expect, it } from "vitest";
import {
  createPeriodicScheduler,
  type PeriodicSchedulerStore,
  type PeriodicTaskDefinition,
} from "../../apps/worker/src/periodic-scheduler";

describe("feat-072 worker periodic scheduler", () => {
  it("enqueues due tasks and skips tasks before their first due time", async () => {
    const now = new Date("2026-06-16T00:10:00.000Z");
    const enqueued: Parameters<PeriodicSchedulerStore["enqueueScheduledJob"]>[0][] = [];
    const scheduler = createPeriodicScheduler({
      now: () => now,
      store: {
        enqueueScheduledJob: async (input) => {
          enqueued.push(input);
          return { created: true, jobId: `job-${input.taskId}` };
        },
      },
      tasks: [
        task({
          id: "stale-cleanup",
          jobType: "stale_reservation_cleanup",
          startAt: new Date("2026-06-16T00:00:00.000Z"),
        }),
        task({
          id: "future-retention",
          jobType: "retention_cleanup",
          startAt: new Date("2026-06-16T00:15:00.000Z"),
        }),
      ],
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 1,
      deduplicatedJobs: 0,
      skippedTasks: 1,
    });
    expect(enqueued).toEqual([
      expect.objectContaining({
        jobType: "stale_reservation_cleanup",
        runAfter: now,
        scheduleWindowStart: now,
        taskId: "stale-cleanup",
      }),
    ]);
    expect(enqueued[0]?.payload).toEqual({
      schedule: {
        intervalMs: 300_000,
        taskId: "stale-cleanup",
        windowStart: "2026-06-16T00:10:00.000Z",
      },
    });
  });

  it("reports deduplicated due jobs when the store finds an existing schedule window", async () => {
    const scheduler = createPeriodicScheduler({
      now: () => new Date("2026-06-16T00:10:00.000Z"),
      store: {
        enqueueScheduledJob: async () => ({ created: false, jobId: "existing-job" }),
      },
      tasks: [
        task({
          id: "stale-cleanup",
          jobType: "stale_reservation_cleanup",
          startAt: new Date("2026-06-16T00:00:00.000Z"),
        }),
      ],
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 0,
      deduplicatedJobs: 1,
      skippedTasks: 0,
    });
  });
});

function task(input: {
  id: string;
  jobType: PeriodicTaskDefinition["jobType"];
  startAt: Date;
}): PeriodicTaskDefinition {
  return {
    id: input.id,
    intervalMs: 300_000,
    jobType: input.jobType,
    maxAttempts: 1,
    payload: {},
    priority: 0,
    startAt: input.startAt,
  };
}

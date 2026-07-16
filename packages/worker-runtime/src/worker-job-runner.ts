import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { createLogger, type Logger } from "@llmingress/logging";

export const JOB_CREATED_CHANNEL = "job_created";

const logger = createLogger("worker-job-runner");

export type ClaimedJob = {
  attemptNumber: number;
  id: string;
  jobType: string;
  maxAttempts: number;
  payload: unknown;
  priority: number;
  trigger: string;
};

export type RunningJob = ClaimedJob & {
  signal: AbortSignal;
  workerId: string;
};

export type ClaimNextJobInput = {
  jobTypes: string[];
  leaseMs: number;
  now: Date;
  workerId: string;
};

export type CompleteJobInput = {
  attemptNumber: number;
  jobId: string;
  now: Date;
  result: unknown;
  workerId: string;
};

export type CancelJobInput = CompleteJobInput;

export type FailJobInput = {
  attemptNumber: number;
  errorCode: string;
  errorMessage: string;
  jobId: string;
  now: Date;
  retryAt: Date | null;
  workerId: string;
};

export type RenewJobLeaseInput = {
  attemptNumber: number;
  jobId: string;
  leaseMs: number;
  now: Date;
  workerId: string;
};

export type JobStore = {
  cancelJob: (input: CancelJobInput) => Promise<boolean>;
  claimNextJob: (input: ClaimNextJobInput) => Promise<ClaimedJob | null>;
  close?: () => Promise<void>;
  completeJob: (input: CompleteJobInput) => Promise<boolean>;
  failJob: (input: FailJobInput) => Promise<boolean>;
  renewJobLease: (input: RenewJobLeaseInput) => Promise<boolean>;
  subscribeJobCreated?: (onJobCreated: () => void) => Promise<{ stop: () => Promise<void> }>;
};

export type JobHandler = (job: RunningJob) => Promise<unknown>;

export type JobCanceledResult = {
  canceled: true;
  reason: string;
};

export type JobRunner = {
  runOnce: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type CreateJobRunnerOptions = {
  handlers: Record<string, JobHandler | undefined>;
  leaseMs?: number;
  maxJobDurationMs?: number;
  now?: () => Date;
  pollIntervalMs?: number;
  retryBackoffMs?: (job: ClaimedJob, error: JobFailure) => number;
  shutdownGraceMs?: number;
  store: JobStore;
  workerId: string;
};

type CreatePostgresJobRunnerOptions = Omit<CreateJobRunnerOptions, "store"> & {
  databaseUrl?: string;
};

type JobFailure = {
  code: string;
  message: string;
};

type RunNextJobResult = {
  nextDelayMs: number | null;
  processed: boolean;
};

type JobRow = {
  attempt_number: number;
  id: string;
  job_type: string;
  max_attempts: number;
  payload: unknown;
  priority: number;
  trigger: string;
};

const defaultLeaseMs = 60_000;
const defaultPollIntervalMs = 5_000;
const defaultShutdownGraceMs = 25_000;
const defaultMaxJobDurationMs = 300_000;

export class JobHandlerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JobHandlerError";
    this.code = code;
  }
}

export function createJobRunner(options: CreateJobRunnerOptions): JobRunner {
  const leaseMs = options.leaseMs ?? defaultLeaseMs;
  const maxJobDurationMs = options.maxJobDurationMs ?? defaultMaxJobDurationMs;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
  const shutdownGraceMs = options.shutdownGraceMs ?? defaultShutdownGraceMs;
  const now = options.now ?? (() => new Date());
  const handledJobTypes = Object.entries(options.handlers)
    .filter(([, handler]) => handler !== undefined)
    .map(([jobType]) => jobType);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscription: { stop: () => Promise<void> } | undefined;
  let started = false;
  let stopped = true;
  let processing = false;
  let wakeRequested = false;
  let activeJob:
    | {
        abortController: AbortController;
        done: Promise<void>;
        stopRenewing: () => void;
      }
    | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(
      () => {
        timer = undefined;
        void wake();
      },
      Math.max(0, delayMs),
    );
  };

  const requestWake = () => {
    if (processing) {
      wakeRequested = true;
      return;
    }

    schedule(0);
  };

  const runNextJob = async (): Promise<RunNextJobResult> => {
    if (handledJobTypes.length === 0) {
      return { nextDelayMs: null, processed: false };
    }

    const claimedAt = now();
    const job = await options.store.claimNextJob({
      jobTypes: handledJobTypes,
      leaseMs,
      now: claimedAt,
      workerId: options.workerId,
    });

    if (!job) {
      return { nextDelayMs: null, processed: false };
    }

    const handler = options.handlers[job.jobType];
    if (!handler) {
      throw new JobHandlerError("job_handler_missing", `No handler registered for ${job.jobType}.`);
    }

    const abortController = new AbortController();
    const renewal = startLeaseRenewal({
      abortController,
      job,
      leaseMs,
      maxJobDurationMs,
      now,
      store: options.store,
      workerId: options.workerId,
    });
    let leaseLost = false;
    const markLeaseLost = () => {
      leaseLost = true;
    };
    renewal.onLeaseLost(markLeaseLost);
    const execution = (async () => {
      try {
        const result = await handler({
          ...job,
          signal: abortController.signal,
          workerId: options.workerId,
        });
        if (leaseLost || abortController.signal.aborted) {
          return { nextDelayMs: 0, processed: true };
        }
        const completedAt = now();
        const terminalInput = {
          attemptNumber: job.attemptNumber,
          jobId: job.id,
          now: completedAt,
          result,
          workerId: options.workerId,
        };
        if (isJobCanceledResult(result)) {
          await options.store.cancelJob(terminalInput);
        } else {
          await options.store.completeJob(terminalInput);
        }
        return { nextDelayMs: 0, processed: true };
      } catch (error) {
        if (leaseLost || abortController.signal.aborted) {
          return { nextDelayMs: 0, processed: true };
        }
        const failedAt = now();
        const failure = readJobFailure(error);
        const shouldRetry = job.attemptNumber < job.maxAttempts;
        const nextDelayMs = shouldRetry ? Math.max(0, retryBackoffMs(job, failure)) : null;
        await options.store.failJob({
          attemptNumber: job.attemptNumber,
          errorCode: failure.code,
          errorMessage: failure.message,
          jobId: job.id,
          now: failedAt,
          retryAt: nextDelayMs === null ? null : new Date(failedAt.getTime() + nextDelayMs),
          workerId: options.workerId,
        });
        return { nextDelayMs, processed: true };
      } finally {
        await renewal.stop();
      }
    })();
    activeJob = {
      abortController,
      done: execution.then(
        () => undefined,
        () => undefined,
      ),
      stopRenewing: () => {
        void renewal.stop();
      },
    };
    try {
      return await execution;
    } finally {
      if (activeJob?.abortController === abortController) {
        activeJob = undefined;
      }
    }
  };

  const wake = async () => {
    if (stopped) {
      return;
    }

    if (processing) {
      wakeRequested = true;
      return;
    }

    processing = true;
    try {
      const result = await runNextJob();
      if (stopped) {
        return;
      }

      if (wakeRequested) {
        wakeRequested = false;
        schedule(0);
        return;
      }

      schedule(result.nextDelayMs ?? (result.processed ? 0 : pollIntervalMs));
    } catch (error) {
      logger.error({ err: error }, "worker poll loop iteration failed; re-arming");
      if (!stopped) {
        schedule(pollIntervalMs);
      }
    } finally {
      processing = false;
    }
  };

  return {
    runOnce: async () => {
      const result = await runNextJob();
      return result.processed;
    },
    start: async () => {
      if (started) {
        return;
      }

      started = true;
      stopped = false;
      subscription = await options.store.subscribeJobCreated?.(() => {
        requestWake();
      });
      schedule(0);
    },
    stop: async () => {
      stopped = true;
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await subscription?.stop();
      subscription = undefined;
      if (activeJob) {
        const completed = await waitForActiveJob(activeJob.done, shutdownGraceMs);
        if (!completed) {
          activeJob.stopRenewing();
          activeJob.abortController.abort(new Error("worker shutdown grace elapsed"));
        }
      }
      await options.store.close?.();
    },
  };
}

export function createPostgresJobRunner(options: CreatePostgresJobRunnerOptions): JobRunner {
  const store = new PostgresJobStore(options.databaseUrl);
  return createJobRunner({ ...options, store });
}

export type JobCreatedListenerClient = {
  end: () => Promise<unknown>;
  on: (event: string, listener: (arg: unknown) => void) => void;
  query: (sql: string) => Promise<unknown>;
  removeAllListeners?: () => void;
};

type ResilientSubscriptionLogger = Pick<Logger, "error" | "warn">;

const defaultSubscriptionInitialBackoffMs = 1_000;
const defaultSubscriptionMaxBackoffMs = 30_000;

export function createResilientJobCreatedSubscription(input: {
  backoffMs?: { initial?: number; max?: number };
  connect: () => JobCreatedListenerClient | Promise<JobCreatedListenerClient>;
  logger?: ResilientSubscriptionLogger;
  onJobCreated: () => void;
}): { start: () => Promise<void>; stop: () => Promise<void> } {
  const initialBackoffMs = input.backoffMs?.initial ?? defaultSubscriptionInitialBackoffMs;
  const maxBackoffMs = input.backoffMs?.max ?? defaultSubscriptionMaxBackoffMs;
  const log = input.logger ?? logger;
  let client: JobCreatedListenerClient | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let currentBackoffMs = initialBackoffMs;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) {
      return;
    }
    const delayMs = currentBackoffMs;
    currentBackoffMs = Math.min(maxBackoffMs, currentBackoffMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectOnce();
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const handleDisconnect = (error?: unknown) => {
    if (stopped) {
      return;
    }
    log.warn({ err: error }, "job_created subscription lost; reconnecting");
    client = undefined;
    scheduleReconnect();
  };

  const connectOnce = async () => {
    if (stopped) {
      return;
    }
    try {
      const next = await input.connect();
      if (stopped) {
        await next.end().catch(() => undefined);
        return;
      }
      client = next;
      next.on("notification", (message) => {
        if (isJobCreatedNotification(message)) {
          input.onJobCreated();
        }
      });
      next.on("error", (error) => {
        handleDisconnect(error);
      });
      next.on("end", () => {
        handleDisconnect();
      });
      await next.query(`listen ${JOB_CREATED_CHANNEL}`);
      currentBackoffMs = initialBackoffMs;
      // Cover NOTIFYs that may have fired during the outage/initial gap.
      input.onJobCreated();
    } catch (error) {
      handleDisconnect(error);
    }
  };

  return {
    start: async () => {
      await connectOnce();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const current = client;
      client = undefined;
      if (current) {
        current.removeAllListeners?.();
        await current.query(`unlisten ${JOB_CREATED_CHANNEL}`).catch(() => undefined);
        await current.end().catch(() => undefined);
      }
    },
  };
}

function isJobCreatedNotification(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { channel?: unknown }).channel === JOB_CREATED_CHANNEL
  );
}

function startLeaseRenewal(input: {
  abortController: AbortController;
  job: ClaimedJob;
  leaseMs: number;
  maxJobDurationMs: number;
  now: () => Date;
  store: JobStore;
  workerId: string;
}): {
  onLeaseLost: (callback: () => void) => void;
  stop: () => Promise<void>;
} {
  const renewEveryMs = Math.max(1, Math.floor(input.leaseMs / 3));
  const startedAtMs = input.now().getTime();
  let inFlight: Promise<void> | undefined;
  let leaseLostCallback: (() => void) | undefined;
  let stopped = false;
  let renewing = false;

  const markLeaseLost = () => {
    leaseLostCallback?.();
    if (!input.abortController.signal.aborted) {
      input.abortController.abort(new Error("worker job lease lost"));
    }
  };

  const renew = async () => {
    if (stopped || renewing || input.abortController.signal.aborted) {
      return;
    }

    if (input.now().getTime() - startedAtMs > input.maxJobDurationMs) {
      stopped = true;
      clearInterval(timer);
      markLeaseLost();
      return;
    }

    renewing = true;
    try {
      const renewed = await input.store.renewJobLease({
        attemptNumber: input.job.attemptNumber,
        jobId: input.job.id,
        leaseMs: input.leaseMs,
        now: input.now(),
        workerId: input.workerId,
      });
      if (!renewed) {
        markLeaseLost();
      }
    } catch {
      markLeaseLost();
    } finally {
      renewing = false;
    }
  };

  const timer = setInterval(() => {
    inFlight = renew();
  }, renewEveryMs);
  timer.unref?.();

  return {
    onLeaseLost: (callback) => {
      leaseLostCallback = callback;
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
    },
  };
}

async function waitForActiveJob(done: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      done.then(() => "completed" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return result === "completed";
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function defaultRetryBackoffMs(job: ClaimedJob): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attemptNumber - 1));
}

function readJobFailure(error: unknown): JobFailure {
  if (error instanceof JobHandlerError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "job_handler_failed",
    message: error instanceof Error ? error.message : "Job handler failed.",
  };
}

class PostgresJobStore implements JobStore {
  private listenerClient: PostgresClient | undefined;

  constructor(private readonly databaseUrl?: string) {}

  async claimNextJob(input: ClaimNextJobInput): Promise<ClaimedJob | null> {
    return withClient(this.databaseUrl, async (client) => {
      await client.query("begin");

      try {
        await recoverExpiredRunningJobs(client, input.now);
        const result = await client.query<JobRow>(
          `
            with candidate as (
              select id
              from jobs
              where status = 'pending'
                and run_after <= $4::timestamptz
                and job_type = any($3::text[])
              order by priority desc, run_after, created_at
              limit 1
              for update skip locked
            )
            update jobs
            set status = 'running',
                lease_owner = $1,
                lease_expires_at = $4::timestamptz + ($2::integer * interval '1 millisecond'),
                attempt_count = attempt_count + 1,
                updated_at = $4::timestamptz
            from candidate
            where jobs.id = candidate.id
            returning jobs.id::text,
                      jobs.job_type,
                      jobs.trigger,
                      jobs.priority,
                      jobs.payload,
                      jobs.attempt_count as attempt_number,
                      jobs.max_attempts
          `,
          [input.workerId, input.leaseMs, input.jobTypes, input.now.toISOString()],
        );
        const job = result.rows[0];

        if (!job) {
          await client.query("commit");
          return null;
        }

        await client.query(
          `
            insert into job_attempts (id, job_id, attempt_number, worker_id, status, started_at)
            values ($1, $2, $3, $4, 'running', $5::timestamptz)
          `,
          [randomUUID(), job.id, job.attempt_number, input.workerId, input.now.toISOString()],
        );
        await client.query("commit");
        return rowToClaimedJob(job);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async completeJob(input: CompleteJobInput): Promise<boolean> {
    return withClient(this.databaseUrl, async (client) => {
      await client.query("begin");

      try {
        const result = await client.query(
          `
            update jobs
            set status = 'succeeded',
                result = $4::jsonb,
                error_code = null,
                error_message = null,
                lease_owner = null,
                lease_expires_at = null,
                completed_at = $5::timestamptz,
                updated_at = $5::timestamptz
            where id = $1
              and status = 'running'
              and lease_owner = $2
              and attempt_count = $3
              and lease_expires_at > $5::timestamptz
          `,
          [
            input.jobId,
            input.workerId,
            input.attemptNumber,
            stringifyJson(input.result),
            input.now.toISOString(),
          ],
        );

        if (result.rowCount === 1) {
          await client.query(
            `
              update job_attempts
              set status = 'succeeded',
                  result = $4::jsonb,
                  finished_at = $5::timestamptz
              where job_id = $1
                and worker_id = $2
                and attempt_number = $3
                and status = 'running'
            `,
            [
              input.jobId,
              input.workerId,
              input.attemptNumber,
              stringifyJson(input.result),
              input.now.toISOString(),
            ],
          );
        }

        await client.query("commit");
        return result.rowCount === 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async cancelJob(input: CancelJobInput): Promise<boolean> {
    return withClient(this.databaseUrl, async (client) => {
      await client.query("begin");

      try {
        const result = await client.query(
          `
            update jobs
            set status = 'canceled',
                result = $4::jsonb,
                error_code = null,
                error_message = null,
                lease_owner = null,
                lease_expires_at = null,
                completed_at = $5::timestamptz,
                updated_at = $5::timestamptz
            where id = $1
              and status = 'running'
              and lease_owner = $2
              and attempt_count = $3
              and lease_expires_at > $5::timestamptz
          `,
          [
            input.jobId,
            input.workerId,
            input.attemptNumber,
            stringifyJson(input.result),
            input.now.toISOString(),
          ],
        );

        if (result.rowCount === 1) {
          await client.query(
            `
              update job_attempts
              set status = 'succeeded',
                  result = $4::jsonb,
                  finished_at = $5::timestamptz
              where job_id = $1
                and worker_id = $2
                and attempt_number = $3
                and status = 'running'
            `,
            [
              input.jobId,
              input.workerId,
              input.attemptNumber,
              stringifyJson(input.result),
              input.now.toISOString(),
            ],
          );
        }

        await client.query("commit");
        return result.rowCount === 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async failJob(input: FailJobInput): Promise<boolean> {
    return withClient(this.databaseUrl, async (client) => {
      await client.query("begin");

      try {
        const terminalStatus = input.retryAt === null;
        const result = await client.query(
          `
            update jobs
            set status = $4,
                error_code = $5,
                error_message = $6,
                run_after = coalesce($7::timestamptz, run_after),
                lease_owner = null,
                lease_expires_at = null,
                completed_at = case when $4 = 'failed' then $8::timestamptz else null end,
                updated_at = $8::timestamptz
            where id = $1
              and status = 'running'
              and lease_owner = $2
              and attempt_count = $3
              and lease_expires_at > $8::timestamptz
          `,
          [
            input.jobId,
            input.workerId,
            input.attemptNumber,
            terminalStatus ? "failed" : "pending",
            input.errorCode,
            input.errorMessage,
            input.retryAt?.toISOString() ?? null,
            input.now.toISOString(),
          ],
        );

        if (result.rowCount === 1) {
          await client.query(
            `
              update job_attempts
              set status = 'failed',
                  error_code = $4,
                  error_message = $5,
                  finished_at = $6::timestamptz
              where job_id = $1
                and worker_id = $2
                and attempt_number = $3
                and status = 'running'
            `,
            [
              input.jobId,
              input.workerId,
              input.attemptNumber,
              input.errorCode,
              input.errorMessage,
              input.now.toISOString(),
            ],
          );
        }

        await client.query("commit");
        return result.rowCount === 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async renewJobLease(input: RenewJobLeaseInput): Promise<boolean> {
    return withClient(this.databaseUrl, async (client) => {
      const result = await client.query(
        `
          update jobs
          set lease_expires_at = $5::timestamptz + ($4::integer * interval '1 millisecond'),
              updated_at = $5::timestamptz
          where id = $1
            and status = 'running'
            and lease_owner = $2
            and attempt_count = $3
            and lease_expires_at > $5::timestamptz
        `,
        [input.jobId, input.workerId, input.attemptNumber, input.leaseMs, input.now.toISOString()],
      );
      return result.rowCount === 1;
    });
  }

  async subscribeJobCreated(onJobCreated: () => void): Promise<{ stop: () => Promise<void> }> {
    const subscription = createResilientJobCreatedSubscription({
      connect: async () => {
        const client = new PostgresClient({ connectionString: this.databaseUrl });
        await client.connect();
        this.listenerClient = client;
        return {
          end: () => client.end(),
          on: (event, listener) => {
            client.on(event as "notification", listener);
          },
          query: (sql) => client.query(sql),
          removeAllListeners: () => {
            client.removeAllListeners();
          },
        };
      },
      logger,
      onJobCreated,
    });
    await subscription.start();

    return {
      stop: async () => {
        await subscription.stop();
        this.listenerClient = undefined;
      },
    };
  }

  async close(): Promise<void> {
    if (!this.listenerClient) {
      return;
    }

    const client = this.listenerClient;
    this.listenerClient = undefined;
    await client.end();
  }
}

async function recoverExpiredRunningJobs(client: PostgresClient, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const expired = await client.query<{ attempt_count: number; id: string; max_attempts: number }>(
    `
      select id::text, attempt_count, max_attempts
      from jobs
      where status = 'running'
        and lease_expires_at <= $1::timestamptz
      order by lease_expires_at, created_at, id
      limit 100
      for update skip locked
    `,
    [nowIso],
  );

  if (expired.rows.length === 0) {
    return;
  }

  const retriableJobIds = expired.rows
    .filter((job) => job.attempt_count < job.max_attempts)
    .map((job) => job.id);
  const exhaustedJobIds = expired.rows
    .filter((job) => job.attempt_count >= job.max_attempts)
    .map((job) => job.id);
  const expiredAttempts = expired.rows.map((job) => ({
    attemptNumber: job.attempt_count,
    jobId: job.id,
  }));

  await client.query(
    `
      update job_attempts
      set status = 'failed',
          error_code = 'job_lease_expired',
          error_message = 'Job lease expired before completion.',
          finished_at = $2::timestamptz
      where (job_id, attempt_number) in (
        select *
        from unnest($1::uuid[], $3::integer[])
      )
        and status = 'running'
    `,
    [
      expiredAttempts.map((attempt) => attempt.jobId),
      nowIso,
      expiredAttempts.map((attempt) => attempt.attemptNumber),
    ],
  );

  if (retriableJobIds.length > 0) {
    await client.query(
      `
        update jobs
        set status = 'pending',
            error_code = 'job_lease_expired',
            error_message = 'Job lease expired before completion.',
            run_after = $2::timestamptz,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = $2::timestamptz
        where id = any($1::uuid[])
      `,
      [retriableJobIds, nowIso],
    );
  }

  if (exhaustedJobIds.length > 0) {
    await client.query(
      `
        update jobs
        set status = 'failed',
            error_code = 'job_lease_expired',
            error_message = 'Job lease expired before completion.',
            lease_owner = null,
            lease_expires_at = null,
            completed_at = $2::timestamptz,
            updated_at = $2::timestamptz
        where id = any($1::uuid[])
      `,
      [exhaustedJobIds, nowIso],
    );
  }
}

function rowToClaimedJob(row: JobRow): ClaimedJob {
  return {
    attemptNumber: row.attempt_number,
    id: row.id,
    jobType: row.job_type,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    priority: row.priority,
    trigger: row.trigger,
  };
}

function isJobCanceledResult(result: unknown): result is JobCanceledResult {
  if (!result || typeof result !== "object") {
    return false;
  }
  const candidate = result as Record<string, unknown>;
  return candidate.canceled === true && typeof candidate.reason === "string";
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function withClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

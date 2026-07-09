import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { recordOpenTelemetrySpan } from "./traces.ts";

export const JOB_CREATED_CHANNEL = "job_created";

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

export type FailJobInput = {
  attemptNumber: number;
  errorCode: string;
  errorMessage: string;
  jobId: string;
  now: Date;
  retryAt: Date | null;
  workerId: string;
};

export type JobStore = {
  claimNextJob: (input: ClaimNextJobInput) => Promise<ClaimedJob | null>;
  close?: () => Promise<void>;
  completeJob: (input: CompleteJobInput) => Promise<boolean>;
  failJob: (input: FailJobInput) => Promise<boolean>;
  subscribeJobCreated?: (onJobCreated: () => void) => Promise<{ stop: () => Promise<void> }>;
};

export type JobHandler = (job: RunningJob) => Promise<unknown>;

export type JobRunner = {
  runOnce: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type CreateJobRunnerOptions = {
  handlers: Record<string, JobHandler | undefined>;
  leaseMs?: number;
  now?: () => Date;
  pollIntervalMs?: number;
  retryBackoffMs?: (job: ClaimedJob, error: JobFailure) => number;
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

const defaultLeaseMs = 30_000;
const defaultPollIntervalMs = 5_000;

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
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
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

    try {
      if (!handler) {
        throw new JobHandlerError(
          "job_handler_missing",
          `No handler registered for ${job.jobType}.`,
        );
      }

      const result = await handler({ ...job, workerId: options.workerId });
      const completedAt = now();
      await options.store.completeJob({
        attemptNumber: job.attemptNumber,
        jobId: job.id,
        now: completedAt,
        result,
        workerId: options.workerId,
      });
      await recordWorkerJobTrace({
        job,
        startedAt: claimedAt,
        status: "succeeded",
      });
      return { nextDelayMs: 0, processed: true };
    } catch (error) {
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
      await recordWorkerJobTrace({
        errorCode: failure.code,
        job,
        startedAt: claimedAt,
        status: "failed",
      });
      return { nextDelayMs, processed: true };
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
      await options.store.close?.();
    },
  };
}

export function createPostgresJobRunner(options: CreatePostgresJobRunnerOptions): JobRunner {
  const store = new PostgresJobStore(options.databaseUrl);
  return createJobRunner({ ...options, store });
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

async function recordWorkerJobTrace(input: {
  errorCode?: string;
  job: ClaimedJob;
  startedAt: Date;
  status: "failed" | "succeeded";
}): Promise<void> {
  await recordOpenTelemetrySpan({
    attributes: {
      "error.code": input.errorCode,
      "job.id": input.job.id,
      "job.type": input.job.jobType,
      "llmingress.status": input.status,
    },
    endTimeUnixNano: dateToUnixNano(new Date()),
    kind: "internal",
    name: "llmingress.worker.job",
    serviceName: "llmingress-worker",
    startTimeUnixNano: dateToUnixNano(input.startedAt),
  });
}

function dateToUnixNano(value: Date): string {
  return String(BigInt(value.getTime()) * 1_000_000n);
}

class PostgresJobStore implements JobStore {
  private listenerClient: PostgresClient | undefined;

  constructor(private readonly databaseUrl?: string) {}

  async claimNextJob(input: ClaimNextJobInput): Promise<ClaimedJob | null> {
    return withClient(this.databaseUrl, async (client) => {
      await client.query("begin");

      try {
        const result = await client.query<JobRow>(
          `
            with candidate as (
              select id
              from jobs
              where status = 'pending'
                and run_after <= now()
                and job_type = any($3::text[])
              order by priority desc, run_after, created_at
              limit 1
              for update skip locked
            )
            update jobs
            set status = 'running',
                lease_owner = $1,
                lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
                attempt_count = attempt_count + 1,
                updated_at = now()
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
          [input.workerId, input.leaseMs, input.jobTypes],
        );
        const job = result.rows[0];

        if (!job) {
          await client.query("commit");
          return null;
        }

        await client.query(
          `
            insert into job_attempts (id, job_id, attempt_number, worker_id, status, started_at)
            values ($1, $2, $3, $4, 'running', now())
          `,
          [randomUUID(), job.id, job.attempt_number, input.workerId],
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

  async subscribeJobCreated(onJobCreated: () => void): Promise<{ stop: () => Promise<void> }> {
    const client = new PostgresClient({ connectionString: this.databaseUrl });
    await client.connect();
    client.on("notification", (message) => {
      if (message.channel === JOB_CREATED_CHANNEL) {
        onJobCreated();
      }
    });
    await client.query(`listen ${JOB_CREATED_CHANNEL}`);
    this.listenerClient = client;

    return {
      stop: async () => {
        if (this.listenerClient === client) {
          this.listenerClient = undefined;
        }
        await client.query(`unlisten ${JOB_CREATED_CHANNEL}`).catch(() => undefined);
        await client.end();
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

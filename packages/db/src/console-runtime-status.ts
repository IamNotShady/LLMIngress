import { withPooledPostgresClient } from "@llmingress/db/client";

// The footer reports what the platform is actually running: the Postgres server
// it is talking to and whether any background worker has work in flight. Both
// are server facts, not business rows.

/** Job types the worker leases, matching the jobs_job_type_check constraint. */
export const consoleWorkerJobTypes = [
  "model_refresh",
  "provider_connection_probe",
  "price_sync",
  "provider_quota_probe",
] as const;

export type ConsoleWorkerJobType = (typeof consoleWorkerJobTypes)[number];

export type ConsoleWorkerJobStatus = {
  jobType: ConsoleWorkerJobType;
  /** Jobs pending or running right now; terminal jobs are history, not work. */
  activeCount: number;
};

export type ConsoleRuntimeStatus = {
  busy: boolean;
  databaseServerVersion: string;
  workerJobs: ConsoleWorkerJobStatus[];
};

export async function getConsoleRuntimeStatus(
  input: { databaseUrl?: string } = {},
): Promise<ConsoleRuntimeStatus> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const versionResult = await client.query<{ server_version: string }>("show server_version");
    const activeResult = await client.query<{ job_type: string; active_count: number }>(
      `
        select job_type, count(*)::integer as active_count
        from jobs
        where status in ('pending', 'running')
        group by job_type
      `,
    );

    const activeByType = new Map(activeResult.rows.map((row) => [row.job_type, row.active_count]));
    const workerJobs = consoleWorkerJobTypes.map((jobType) => ({
      jobType,
      activeCount: activeByType.get(jobType) ?? 0,
    }));

    return {
      busy: workerJobs.some((entry) => entry.activeCount > 0),
      // "18.4 (Debian ...)" style suffixes are build metadata, not the version.
      databaseServerVersion: (versionResult.rows[0]?.server_version ?? "").split(" ")[0] ?? "",
      workerJobs,
    };
  });
}

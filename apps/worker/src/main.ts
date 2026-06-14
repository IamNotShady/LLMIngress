import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { createPostgresJobRunner, type JobRunner } from "./job-runner.js";
import { createModelRefreshJobHandler } from "./model-refresh.js";
import { createProviderConnectivityCheckJobHandler } from "./provider-connectivity-check.js";
import { createStaleReservationCleanupJobHandler } from "./stale-reservations.js";

type StartWorkerOptions = {
  jobRunner?: JobRunner;
};

export async function startWorker(options: StartWorkerOptions = {}) {
  const config = loadBootstrapRuntimeConfig();
  const jobRunner =
    options.jobRunner ??
    createPostgresJobRunner({
      databaseUrl: config.databaseUrl,
      handlers: {
        model_refresh: createModelRefreshJobHandler({ databaseUrl: config.databaseUrl }),
        provider_connectivity_check: createProviderConnectivityCheckJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        stale_reservation_cleanup: createStaleReservationCleanupJobHandler({
          databaseUrl: config.databaseUrl,
        }),
      },
      pollIntervalMs: config.workerHeartbeatMs,
      workerId: readWorkerId(),
    });
  await jobRunner.start();

  const timer = setInterval(() => {
    console.log("[worker] heartbeat");
  }, config.workerHeartbeatMs);

  console.log("[worker] started");

  return {
    async stop() {
      clearInterval(timer);
      await jobRunner.stop();
      console.log("[worker] stopped");
    },
  };
}

function readWorkerId(): string {
  return process.env.WORKER_ID?.trim() || `worker-${process.pid}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker()
    .then((worker) => {
      const shutdown = () => {
        worker
          .stop()
          .then(() => process.exit(0))
          .catch((error: unknown) => {
            console.error(error);
            process.exit(1);
          });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

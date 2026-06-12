import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";

export function startWorker() {
  const config = loadBootstrapRuntimeConfig();
  const timer = setInterval(() => {
    console.log("[worker] heartbeat");
  }, config.workerHeartbeatMs);

  console.log("[worker] started");

  return {
    stop() {
      clearInterval(timer);
      console.log("[worker] stopped");
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = startWorker();
  const shutdown = () => {
    worker.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

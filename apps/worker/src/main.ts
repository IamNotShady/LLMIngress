import { pathToFileURL } from "node:url";

export function startWorker() {
  const heartbeatMs = Number.parseInt(process.env.WORKER_HEARTBEAT_MS ?? "30000", 10);
  const timer = setInterval(() => {
    console.log("[worker] heartbeat");
  }, heartbeatMs);

  console.log("[worker] started");

  return {
    stop() {
      clearInterval(timer);
      console.log("[worker] stopped");
    }
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

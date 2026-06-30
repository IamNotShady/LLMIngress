import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("worker cleanup starts the real worker process without app heartbeat logging", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_worker_ponytail_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const worker = startWorkerProcess(fixture.databaseUrl);

    try {
      await waitForWorkerStarted(worker);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(worker.child.exitCode).toBe(null);
      expect(worker.stdout.join("")).toContain("[worker] started");
      expect(worker.stdout.join("")).not.toContain("[worker] heartbeat");
    } finally {
      await stopWorkerProcess(worker);
    }
  } finally {
    await fixture.dispose();
  }
});

type WorkerProcess = {
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
  stdout: string[];
};

function startWorkerProcess(databaseUrl: string): WorkerProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/worker", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MASTER_KEY: "test-master-key",
      WORKER_HEARTBEAT_MS: "25",
      WORKER_ID: "worker-pony-cleanup",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const worker: WorkerProcess = {
    child,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => worker.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => worker.stdout.push(String(chunk)));
  return worker;
}

async function waitForWorkerStarted(worker: WorkerProcess): Promise<void> {
  await expect
    .poll(
      () => {
        if (worker.child.exitCode !== null) {
          return `exited:${worker.child.exitCode}`;
        }
        return worker.stdout.join("").includes("[worker] started") ? "started" : "not-ready";
      },
      {
        message: `Worker did not start.\nstdout=${worker.stdout.join("")}\nstderr=${worker.stderr.join("")}`,
        timeout: 15_000,
      },
    )
    .toBe("started");
}

async function stopWorkerProcess(worker: WorkerProcess): Promise<void> {
  if (worker.child.exitCode !== null) {
    return;
  }

  worker.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    worker.child.once("exit", () => resolve());
    setTimeout(() => {
      if (worker.child.exitCode === null) {
        worker.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}

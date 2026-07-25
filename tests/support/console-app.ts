import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

export type ConsoleProcess = {
  child: ChildProcessWithoutNullStreams;
  distDirectory: string;
  port: number;
  stderr: string[];
  stdout: string[];
};

export async function signInFromFirstRun(page: Page, baseUrl: string) {
  const password = "correct horse battery staple";
  const navigationTimeout = 15_000;

  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "Create the console admin" })).toBeVisible({
    timeout: navigationTimeout,
  });
  await page.getByLabel("Admin password", { exact: true }).fill(password);
  await page.getByLabel("Confirm admin password").fill(password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
    timeout: navigationTimeout,
  });
  await page.getByLabel("Admin password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({
    timeout: navigationTimeout,
  });
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForConsole(baseUrl: string, consoleApp: ConsoleProcess): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          if (consoleApp.child.exitCode !== null) {
            return `exited:${consoleApp.child.exitCode}`;
          }

          try {
            const response = await fetch(baseUrl);
            return response.status;
          } catch {
            return "not-ready";
          }
        },
        {
          message: "Console did not start.",
          timeout: 30_000,
        },
      )
      .toBe(200);
  } catch (error) {
    const stdout = consoleApp.stdout.join("").slice(-4_000);
    const stderr = consoleApp.stderr.join("").slice(-4_000);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstdout tail:\n${stdout}\nstderr tail:\n${stderr}`,
    );
  }
}

export function startConsoleProcess(options: {
  databaseUrl: string;
  env?: Record<string, string | undefined>;
  port: number;
}): ConsoleProcess {
  const distDirectory = resolve("apps/console", ".next", `e2e-${options.port}`);
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@llmingress/console",
      "exec",
      "next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(options.port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONSOLE_PORT: String(options.port),
        DATABASE_URL: options.databaseUrl,
        LLMINGRESS_DB_POOL_MAX: "2",
        LLMINGRESS_TEST_CONSOLE_DIST_DIR: `.next/e2e-${options.port}`,
        ENCRYPTION_KEY: "test-master-key",
        ...options.env,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const consoleApp: ConsoleProcess = {
    child,
    distDirectory,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => consoleApp.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => consoleApp.stdout.push(String(chunk)));
  return consoleApp;
}

export async function stopConsoleProcess(consoleApp: ConsoleProcess): Promise<void> {
  try {
    if (consoleApp.child.exitCode === null) {
      signalConsoleProcess(consoleApp, "SIGTERM");
      await new Promise<void>((finish) => {
        const timeout = setTimeout(() => {
          if (consoleApp.child.exitCode === null) {
            signalConsoleProcess(consoleApp, "SIGKILL");
          }
          finish();
        }, 2_000);
        consoleApp.child.once("exit", () => {
          clearTimeout(timeout);
          finish();
        });
      });
    }
    await waitForProcessGroupExit(consoleApp.child.pid);
  } finally {
    await rm(consoleApp.distDirectory, { force: true, recursive: true });
  }
}

function signalConsoleProcess(consoleApp: ConsoleProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && consoleApp.child.pid) {
    try {
      process.kill(-consoleApp.child.pid, signal);
      return;
    } catch {
      // The process may already have exited between the exitCode check and the signal.
    }
  }
  consoleApp.child.kill(signal);
}

async function waitForProcessGroupExit(pid: number | undefined): Promise<void> {
  if (process.platform === "win32" || !pid) {
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(-pid, 0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    } catch {
      return;
    }
  }
}

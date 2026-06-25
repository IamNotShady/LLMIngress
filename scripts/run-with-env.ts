import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFiles } from "./env-loader";

export function shouldClearConsoleNextArtifacts(input: {
  args: readonly string[];
  command: string;
  consolePortListening: boolean;
}): boolean {
  return input.command === "playwright" && input.args[0] === "test" && !input.consolePortListening;
}

export function readConsolePort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number.parseInt(env.CONSOLE_PORT ?? "3000", 10);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

async function isTcpPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveListening(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export async function runWithEnv(argv: readonly string[] = process.argv): Promise<void> {
  const [, , command, ...rawArgs] = argv;

  if (!command) {
    console.error("Usage: tsx scripts/run-with-env.ts <command> [...args]");
    process.exit(1);
  }

  loadEnvFiles();

  const separatorIndex = rawArgs.indexOf("--");
  const args =
    separatorIndex === -1
      ? rawArgs
      : [...rawArgs.slice(0, separatorIndex), ...rawArgs.slice(separatorIndex + 1)];

  const isConsolePortBusy = await isTcpPortListening(readConsolePort());
  if (
    shouldClearConsoleNextArtifacts({
      args,
      command,
      consolePortListening: isConsolePortBusy,
    })
  ) {
    // Console E2E specs start Next dev. A previous next build leaves production
    // artifacts in the same directory, which can make dev startup miss short
    // readiness windows in the feature regression runner. If a live local
    // Console is already on the default port, keep its Turbopack cache intact.
    rmSync(resolve("apps/console/.next"), { force: true, recursive: true });
  }

  const child = spawn(command, args, {
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWithEnv().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

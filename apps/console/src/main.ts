import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig, readConsoleListenHost } from "@llmingress/config";
import { assertPostgresDatabaseConfigured } from "@llmingress/db/client";
import { createLogger } from "@llmingress/logging";

type ConsoleMode = "dev" | "start";
type ConsoleChildProcess = Pick<ChildProcess, "kill" | "on">;
type ConsoleRuntime = {
  exit: (code: number) => void;
  killSelf: (signal: NodeJS.Signals) => void;
  off: (signal: NodeJS.Signals, listener: () => void) => void;
  once: (signal: NodeJS.Signals, listener: () => void) => void;
};

type ConsoleCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

const logger = createLogger("console");

const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const consolePackageRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultConsoleRuntime: ConsoleRuntime = {
  exit: (code) => process.exit(code),
  killSelf: (signal) => process.kill(process.pid, signal),
  off: (signal, listener) => process.off(signal, listener),
  once: (signal, listener) => process.once(signal, listener),
};

export function buildConsoleCommand(mode: ConsoleMode): ConsoleCommand {
  const config = loadBootstrapRuntimeConfig();
  assertPostgresDatabaseConfigured();
  const consoleHost = readConsoleListenHost();
  const masterKeyEnv =
    config.masterKeySource.kind === "inline"
      ? { MASTER_KEY: config.masterKeySource.value }
      : { MASTER_KEY_FILE: config.masterKeySource.path };

  return {
    command: "next",
    args: [mode, "--hostname", consoleHost, "--port", String(config.consolePort)],
    env: {
      ...process.env,
      ...masterKeyEnv,
    },
  };
}

export function startConsole(mode: ConsoleMode): void {
  if (mode === "dev") {
    clearConsoleDevArtifacts();
  }

  const { command, args, env } = buildConsoleCommand(mode);
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  attachConsoleChildLifecycle(child);
}

export function clearConsoleDevArtifacts(consoleRoot = consolePackageRoot): void {
  rmSync(resolve(consoleRoot, ".next"), { force: true, recursive: true });
}

export function attachConsoleChildLifecycle(
  child: ConsoleChildProcess,
  runtime: ConsoleRuntime = defaultConsoleRuntime,
): void {
  let forwardedSignal: NodeJS.Signals | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const parentSignalHandlers = new Map<NodeJS.Signals, () => void>();

  for (const shutdownSignal of shutdownSignals) {
    const listener = () => {
      forwardedSignal ??= shutdownSignal;
      killChild(child, shutdownSignal);
      forceKillTimer ??= setChildForceKillTimer(child);
    };
    parentSignalHandlers.set(shutdownSignal, listener);
    runtime.once(shutdownSignal, listener);
  }

  child.on("exit", (code, signal) => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    for (const [parentSignal, listener] of parentSignalHandlers) {
      runtime.off(parentSignal, listener);
    }

    if (forwardedSignal) {
      runtime.exit(signalExitCode(forwardedSignal));
      return;
    }

    if (signal) {
      runtime.killSelf(signal);
      return;
    }

    runtime.exit(code ?? 0);
  });
}

function setChildForceKillTimer(child: ConsoleChildProcess): NodeJS.Timeout {
  const timer = setTimeout(() => killChild(child, "SIGKILL"), 2_000);
  timer.unref();
  return timer;
}

function killChild(child: ConsoleChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function readMode(value: string | undefined): ConsoleMode {
  return value === "start" ? "start" : "dev";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startConsole(readMode(process.argv[2]));
  } catch (error) {
    logger.error({ err: error }, "console startup failed");
    process.exit(1);
  }
}

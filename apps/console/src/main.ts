import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";

type ConsoleMode = "dev" | "start";

type ConsoleCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function buildConsoleCommand(mode: ConsoleMode): ConsoleCommand {
  const config = loadBootstrapRuntimeConfig();
  const consoleHost = process.env.CONSOLE_HOST?.trim() || "127.0.0.1";
  const masterKeyEnv =
    config.masterKeySource.kind === "inline"
      ? { MASTER_KEY: config.masterKeySource.value }
      : { MASTER_KEY_FILE: config.masterKeySource.path };

  return {
    command: "next",
    args: [mode, "--hostname", consoleHost, "--port", String(config.consolePort)],
    env: {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      ...masterKeyEnv,
    },
  };
}

export function startConsole(mode: ConsoleMode): void {
  const { command, args, env } = buildConsoleCommand(mode);
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function readMode(value: string | undefined): ConsoleMode {
  return value === "start" ? "start" : "dev";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startConsole(readMode(process.argv[2]));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

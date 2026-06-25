import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFiles } from "./env-loader";

const [, , command, ...rawArgs] = process.argv;

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

if (command === "playwright" && args[0] === "test") {
  // Console E2E specs start Next dev. A previous next build leaves production
  // artifacts in the same directory, which can make dev startup miss short
  // readiness windows in the feature regression runner.
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

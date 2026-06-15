import { spawn } from "node:child_process";
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

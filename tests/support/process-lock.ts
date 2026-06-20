import { open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withProcessLock<T>(
  lockName: string,
  operation: () => Promise<T>,
  timeoutMs = 60_000,
  settleMs = 250,
): Promise<T> {
  const lockPath = join(tmpdir(), `${lockName}.lock`);
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
        return await operation();
      } finally {
        if (settleMs > 0) {
          await sleep(settleMs);
        }
        await handle.close();
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }

      const ownerPid = await readLockOwnerPid(lockPath);
      if (ownerPid === 0) {
        await sleep(25);
        continue;
      }
      if (!isProcessRunning(ownerPid)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }

      const waitedMs = Date.now() - startedAt;
      if (waitedMs > timeoutMs) {
        throw new Error(
          `Timed out waiting for process lock: ${lockName} at ${lockPath}; owner pid ${ownerPid}; waited ${waitedMs}ms`,
        );
      }
      await sleep(100);
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function readLockOwnerPid(lockPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return -1;
    }
    throw error;
  }

  const value = raw.trim();
  if (!value) {
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Malformed process lock: ${lockPath} contains ${JSON.stringify(value)}`);
  }

  return Number(value);
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

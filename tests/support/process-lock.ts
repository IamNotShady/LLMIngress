import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withProcessLock<T>(
  lockName: string,
  operation: () => Promise<T>,
  timeoutMs = 90_000,
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
        await handle.close();
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for process lock: ${lockName}`);
      }
      await sleep(100);
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

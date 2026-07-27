import type { ConsoleRuntimeStatus } from "@llmingress/db/console-runtime-status";

export type ConsoleFooterProps = {
  encryptionReady: boolean;
  runtime: ConsoleRuntimeStatus;
  version: string;
};

/**
 * One-line condensation for the screens that have no footer. It says the
 * version and whether the encryption key is usable — process facts, which is
 * all this line can honestly carry: it renders before anything has queried the
 * database, so a word about postgres here would print the same whether the
 * database were up or down. The footer inside names it, after signing in, from
 * a reading that actually happened.
 */
export function consoleStatusLine({
  encryptionReady,
  version,
}: Omit<ConsoleFooterProps, "runtime">): string {
  return [
    `LLMIngress ${version}`,
    encryptionReady ? "encryption ok" : "encryption unavailable",
  ].join(" · ");
}

/** Fixed to the bottom of the viewport on every module. */
export function ConsoleFooter({ encryptionReady, runtime, version }: ConsoleFooterProps) {
  const workerLine = runtime.workerJobs
    .map((entry) =>
      entry.activeCount > 0 ? `${entry.jobType} ×${entry.activeCount}` : entry.jobType,
    )
    .join(" · ");

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 flex gap-6 overflow-x-auto whitespace-nowrap border-t border-rule bg-bg px-8 py-3 font-mono text-125 text-faint">
      <span>LLMIngress {version}</span>
      <span>
        worker: {workerLine} {runtime.busy ? "busy" : "idle"}
      </span>
      <span className="ml-auto">
        postgres {runtime.databaseServerVersion} ·{" "}
        {encryptionReady ? "encryption ok" : "encryption unavailable"}
      </span>
    </footer>
  );
}

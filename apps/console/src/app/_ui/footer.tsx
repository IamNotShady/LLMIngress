import type { ConsoleRuntimeStatus } from "@llmingress/db/console-runtime-status";

export type ConsoleFooterProps = {
  encryptionReady: boolean;
  runtime: ConsoleRuntimeStatus;
  version: string;
};

/**
 * One-line condensation of the same facts, for screens that have no footer.
 * The auth panels show this so the version, database and encryption state are
 * visible before anyone can sign in.
 */
export function consoleStatusLine({
  encryptionReady,
  runtime,
  version,
}: ConsoleFooterProps): string {
  return [
    `LLMIngress ${version}`,
    `postgres ${runtime.databaseServerVersion}`,
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
    <footer className="fixed inset-x-0 bottom-0 z-30 flex gap-6 border-t border-rule bg-bg px-8 py-3 font-mono text-125 text-faint">
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

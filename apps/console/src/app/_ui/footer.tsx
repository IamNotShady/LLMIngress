import type { ConsoleRuntimeStatus } from "@llmingress/db/console-runtime-status";

export { consoleStatusLine } from "./status-line";

export type ConsoleFooterProps = {
  encryptionReady: boolean;
  runtime: ConsoleRuntimeStatus;
  version: string;
};

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

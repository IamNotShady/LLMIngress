import { createLogger } from "@llmingress/logging";

const logger = createLogger("gateway");

export type GatewayBackgroundTaskPending = {
  metadata?: Record<string, unknown>;
  name: string;
};

export type GatewayBackgroundTaskDrainResult = {
  pending: GatewayBackgroundTaskPending[];
  timedOut: boolean;
};

type GatewayBackgroundTaskEntry = GatewayBackgroundTaskPending & {
  promise: Promise<void>;
};

type GatewayBackgroundTaskLogger = {
  error: (payload: Record<string, unknown>, message: string) => void;
};

export class GatewayBackgroundTaskRegistry {
  private readonly pending = new Map<string, GatewayBackgroundTaskEntry>();
  private nextTaskId = 0;

  track(input: {
    logger?: GatewayBackgroundTaskLogger;
    message?: string;
    metadata?: Record<string, unknown>;
    name: string;
    task: () => Promise<void>;
  }): void {
    this.nextTaskId += 1;
    const id = String(this.nextTaskId);
    const entry: GatewayBackgroundTaskEntry = {
      metadata: input.metadata,
      name: input.name,
      promise: Promise.resolve()
        .then(input.task)
        .catch((error) => {
          (input.logger ?? logger).error(
            {
              ...input.metadata,
              err: error,
            },
            input.message ?? "gateway background task failed",
          );
        })
        .finally(() => {
          this.pending.delete(id);
        }),
    };
    this.pending.set(id, entry);
  }

  async drain(input: { timeoutMs: number }): Promise<GatewayBackgroundTaskDrainResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, input.timeoutMs));
      timer.unref?.();
    });

    try {
      while (this.pending.size > 0) {
        const settled = Promise.allSettled(
          [...this.pending.values()].map((entry) => entry.promise),
        ).then(() => "settled" as const);
        const result = await Promise.race([settled, timeout]);
        if (result === "timeout") {
          return {
            pending: this.listPending(),
            timedOut: true,
          };
        }
      }
      return { pending: [], timedOut: false };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  listPending(): GatewayBackgroundTaskPending[] {
    return [...this.pending.values()].map((entry) => ({
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      name: entry.name,
    }));
  }
}

export const gatewayBackgroundTasks = new GatewayBackgroundTaskRegistry();

export function runGatewayBackgroundTask(input: {
  logger?: GatewayBackgroundTaskLogger;
  message: string;
  metadata?: Record<string, unknown>;
  name?: string;
  task: () => Promise<void>;
}): void {
  gatewayBackgroundTasks.track({
    logger: input.logger,
    message: input.message,
    metadata: input.metadata,
    name: input.name ?? input.message,
    task: input.task,
  });
}

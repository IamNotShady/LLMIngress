import { createLogger } from "@llmingress/logging";

const logger = createLogger("gateway");

export function runGatewayBackgroundTask(input: {
  message: string;
  metadata?: Record<string, unknown>;
  task: () => Promise<void>;
}): void {
  void input.task().catch((error) => {
    logger.error(
      {
        ...input.metadata,
        err: error,
      },
      input.message,
    );
  });
}

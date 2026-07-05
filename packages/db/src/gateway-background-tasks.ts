export function runGatewayBackgroundTask(input: {
  message: string;
  metadata?: Record<string, unknown>;
  task: () => Promise<void>;
}): void {
  void input.task().catch((error) => {
    console.error(input.message, {
      ...input.metadata,
      err: error,
    });
  });
}

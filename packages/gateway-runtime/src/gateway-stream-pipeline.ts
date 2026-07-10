import { PassThrough, Readable } from "node:stream";
import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import { classifyProviderFailureStatus } from "@llmingress/provider/connectivity";
import { type GatewayConcurrencyLease, releaseGatewayConcurrency } from "./gateway-agent-limits.ts";
import { runGatewayBackgroundTask } from "./gateway-background-tasks.ts";
import { gatewayStreamIdleTimeoutMs } from "./gateway-env.ts";
import type { FallbackChainCandidate } from "./gateway-fallback-chain.ts";

export type GatewayRuntimeStreamError = {
  errorCode: "provider_stream_error";
  errorMessage: string;
};

export function streamIdleTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return gatewayStreamIdleTimeoutMs(env);
}

export async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  message: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createReadaheadStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstValue: Uint8Array,
  options: { idleTimeoutMs?: number } = {},
): Readable {
  const idleTimeoutMs = options.idleTimeoutMs ?? streamIdleTimeoutMs();
  let readerCanceled = false;

  async function cancelReader(): Promise<void> {
    if (readerCanceled) {
      return;
    }
    readerCanceled = true;
    await reader.cancel().catch(() => undefined);
  }

  async function* pump(): AsyncGenerator<Buffer> {
    yield Buffer.from(firstValue);
    try {
      while (true) {
        const { done, value } = await readChunkWithTimeout(
          reader,
          idleTimeoutMs,
          "Provider stream stalled mid-response.",
        );
        if (done) {
          return;
        }
        if (value) {
          yield Buffer.from(value);
        }
      }
    } finally {
      await cancelReader();
    }
  }
  const stream = Readable.from(pump());
  const destroy = stream.destroy.bind(stream);
  stream.destroy = (error?: Error | null) => {
    void cancelReader();
    return destroy(error ?? undefined);
  };
  stream.once("close", () => {
    void cancelReader();
  });
  return stream;
}

export function wrapProviderStreamWithActivityCompletion(
  source: Readable,
  input: {
    collectChunk?: (chunk: Buffer | Uint8Array | string) => void;
    completeActivity: (completion: { statusCode: number }) => Promise<void> | void;
    errorStatusCode?: number;
    statusCode: number;
  },
): Readable {
  const output = new PassThrough({ highWaterMark: 16 * 1024 });
  let settled = false;

  if (input.collectChunk) {
    source.on("data", input.collectChunk);
  }
  source.pipe(output, { end: false });
  source.once("end", () => {
    settleActivity(input.statusCode);
    output.end();
  });
  source.once("error", (error) => {
    settleActivity(input.errorStatusCode ?? 502);
    output.destroy(error instanceof Error ? error : new Error("Provider stream failed."));
  });
  source.once("close", () => {
    if (settled || source.readableEnded) {
      return;
    }
    settleActivity(input.errorStatusCode ?? 499);
    output.destroy();
  });
  output.once("close", () => {
    if (!source.destroyed && !source.readableEnded) {
      source.destroy();
    }
  });

  function settleActivity(statusCode: number): void {
    if (settled) {
      return;
    }
    settled = true;
    runGatewayBackgroundTask({
      message: "gateway stream activity completion failed",
      metadata: { statusCode },
      name: "gateway.stream.activity",
      task: async () => {
        await Promise.resolve(input.completeActivity({ statusCode }));
      },
    });
  }

  return output;
}

export function wrapProviderStreamWithErrorRecording(
  source: Readable,
  input: {
    recordRuntimeError: (error: GatewayRuntimeStreamError) => Promise<void> | void;
  },
): Readable {
  const output = new PassThrough();
  let recorded = false;

  source.on("error", (error) => {
    const runtimeError: GatewayRuntimeStreamError = {
      errorCode: "provider_stream_error",
      errorMessage: error instanceof Error ? error.message : "Provider stream failed.",
    };

    if (!recorded) {
      runGatewayBackgroundTask({
        message: "gateway runtime stream error recording failed",
        metadata: { errorCode: runtimeError.errorCode },
        name: "gateway.stream.runtime_error",
        task: async () => {
          await Promise.resolve(input.recordRuntimeError(runtimeError));
        },
      });
    }
    recorded = true;
    output.destroy(error instanceof Error ? error : new Error(runtimeError.errorMessage));
  });
  source.pipe(output);
  output.once("close", () => {
    if (!source.destroyed && !source.readableEnded) {
      source.destroy();
    }
  });

  return output;
}

export function wrapProviderStreamWithMidStreamHealthRecording(
  source: Readable,
  input: {
    candidate: FallbackChainCandidate;
    databaseUrl?: string;
  },
): Readable {
  let bytesSent = false;

  source.on("data", () => {
    bytesSent = true;
  });

  source.once("error", (error) => {
    const errorMessage = error instanceof Error ? error.message : "Provider stream failed.";
    const healthStatus = classifyProviderFailureStatus({
      errorCode: "provider_stream_error",
      errorMessage,
      statusCode: undefined,
    });
    const shared = {
      databaseUrl: input.databaseUrl,
      errorCode: "provider_stream_error",
      errorMessage,
      metadata: { failedBeforeFirstByte: !bytesSent },
      status: healthStatus,
      trigger: "request_path" as const,
    };
    runGatewayBackgroundTask({
      message: "gateway stream provider health recording failed",
      metadata: {
        providerId: input.candidate.providerId,
        providerModelId: input.candidate.providerModelId,
      },
      name: "gateway.stream.health",
      task: async () => {
        await recordProviderHealthEvent({
          ...shared,
          providerId: input.candidate.providerId,
        });
        await recordProviderHealthEvent({
          ...shared,
          providerId: input.candidate.providerId,
          providerModelId: input.candidate.providerModelId,
        });
      },
    });
  });

  return source;
}

export function wrapProviderStreamWithConcurrencyRelease(
  source: Readable,
  input: {
    databaseUrl?: string;
    lease: GatewayConcurrencyLease | undefined;
  },
): Readable {
  let settled = false;
  const release = () => {
    if (settled) {
      return;
    }
    settled = true;
    runGatewayBackgroundTask({
      message: "gateway concurrency release failed",
      metadata: input.lease
        ? {
            agentId: input.lease.agentId,
            windowStart: input.lease.window.windowStart.toISOString(),
          }
        : undefined,
      name: "gateway.concurrency.release",
      task: () => releaseGatewayConcurrency(input),
    });
  };
  source.once("end", release);
  source.once("error", release);
  source.once("close", release);
  return source;
}

export function composeGatewayProviderStreamPipeline(input: {
  candidate: FallbackChainCandidate;
  databaseUrl?: string;
  firstValue: Uint8Array;
  idleTimeoutMs?: number;
  lease: GatewayConcurrencyLease | undefined;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  recordRuntimeError: (error: GatewayRuntimeStreamError) => Promise<void> | void;
}): Readable {
  return wrapProviderStreamWithConcurrencyRelease(
    wrapProviderStreamWithMidStreamHealthRecording(
      wrapProviderStreamWithErrorRecording(
        createReadaheadStream(input.reader, input.firstValue, {
          idleTimeoutMs: input.idleTimeoutMs,
        }),
        { recordRuntimeError: input.recordRuntimeError },
      ),
      {
        candidate: input.candidate,
        databaseUrl: input.databaseUrl,
      },
    ),
    {
      databaseUrl: input.databaseUrl,
      lease: input.lease,
    },
  );
}

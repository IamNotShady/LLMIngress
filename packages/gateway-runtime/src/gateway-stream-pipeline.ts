import { PassThrough, Readable } from "node:stream";
import { type GatewayConcurrencyLease, releaseGatewayConcurrency } from "./gateway-agent-limits.ts";
import { runGatewayBackgroundTask } from "./gateway-background-tasks.ts";
import { gatewayStreamIdleTimeoutMs } from "./gateway-env.ts";

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
  databaseUrl?: string;
  firstValue: Uint8Array;
  idleTimeoutMs?: number;
  lease: GatewayConcurrencyLease | undefined;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}): Readable {
  return wrapProviderStreamWithConcurrencyRelease(
    createReadaheadStream(input.reader, input.firstValue, {
      idleTimeoutMs: input.idleTimeoutMs,
    }),
    {
      databaseUrl: input.databaseUrl,
      lease: input.lease,
    },
  );
}

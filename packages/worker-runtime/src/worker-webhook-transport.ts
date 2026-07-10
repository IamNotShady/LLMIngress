import { lookup as dnsLookup } from "node:dns/promises";
import type { RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type WorkerWebhookLookupResult = {
  address: string;
  family: 4 | 6;
};

export type WorkerWebhookLookup = (hostname: string) => Promise<WorkerWebhookLookupResult>;

export type WorkerWebhookRequestInput = {
  allowedHosts?: string[];
  body: unknown;
  idempotencyKey: string;
  lookup?: WorkerWebhookLookup;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: string;
};

export type WorkerWebhookResult =
  | {
      responseBody: string | null;
      responseStatus: number;
      status: "sent";
    }
  | {
      errorCode: WorkerWebhookErrorCode;
      errorMessage: string;
      responseBody?: string | null;
      responseStatus: number | null;
      status: "failed";
    };

export type WorkerWebhookErrorCode =
  | "webhook_http_error"
  | "webhook_request_failed"
  | "webhook_response_too_large"
  | "webhook_target_blocked"
  | "webhook_timeout";

type WorkerWebhookEnvironment = Partial<Record<string, string | undefined>>;
type Ipv4Octets = [number, number, number, number];

const defaultTimeoutMs = 10_000;
const defaultMaxResponseBytes = 8_192;

export async function sendWorkerWebhookRequest(
  input: WorkerWebhookRequestInput,
): Promise<WorkerWebhookResult> {
  const timeoutMs = normalizePositiveInteger(input.timeoutMs, workerWebhookTimeoutMs());
  const maxResponseBytes = normalizePositiveInteger(
    input.maxResponseBytes,
    workerWebhookMaxResponseBytes(),
  );
  const allowedHosts = normalizeAllowedHosts(input.allowedHosts ?? readWorkerWebhookAllowedHosts());
  const parsedUrl = parseWebhookUrl(input.url);
  if (!parsedUrl.ok) {
    return failed("webhook_target_blocked", parsedUrl.message, null);
  }

  if (input.signal?.aborted) {
    return failed("webhook_request_failed", "Webhook request was aborted before dispatch.", null);
  }

  const hostname = normalizeHostname(parsedUrl.url.hostname);
  const resolved = await resolveWebhookTarget(hostname, input.lookup);
  if (!resolved.ok) {
    return failed("webhook_request_failed", resolved.message, null);
  }

  if (!isAllowedWebhookTarget(hostname, resolved.address.address, allowedHosts)) {
    return failed("webhook_target_blocked", "Webhook target resolved to a blocked address.", null);
  }

  return dispatchWebhookRequest({
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    maxResponseBytes,
    resolvedAddress: resolved.address,
    signal: input.signal,
    timeoutMs,
    url: parsedUrl.url,
  });
}

export function readWorkerWebhookAllowedHosts(
  env: WorkerWebhookEnvironment = process.env,
): string[] {
  return normalizeAllowedHosts(env.WORKER_WEBHOOK_ALLOWED_HOSTS?.split(",") ?? []);
}

export function workerWebhookTimeoutMs(env: WorkerWebhookEnvironment = process.env): number {
  return normalizePositiveInteger(
    Number.parseInt(env.WORKER_WEBHOOK_TIMEOUT_MS ?? "", 10),
    defaultTimeoutMs,
  );
}

export function workerWebhookMaxResponseBytes(env: WorkerWebhookEnvironment = process.env): number {
  return normalizePositiveInteger(
    Number.parseInt(env.WORKER_WEBHOOK_MAX_RESPONSE_BYTES ?? "", 10),
    defaultMaxResponseBytes,
  );
}

function parseWebhookUrl(rawUrl: string): { ok: true; url: URL } | { message: string; ok: false } {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return { message: "Webhook target URL is invalid.", ok: false };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { message: "Webhook target URL must use http or https.", ok: false };
  }

  if (url.username || url.password) {
    return { message: "Webhook target URL must not include credentials.", ok: false };
  }

  if (!url.hostname) {
    return { message: "Webhook target URL must include a hostname.", ok: false };
  }

  return { ok: true, url };
}

async function resolveWebhookTarget(
  hostname: string,
  lookup: WorkerWebhookLookup | undefined,
): Promise<{ address: WorkerWebhookLookupResult; ok: true } | { message: string; ok: false }> {
  const numericFamily = isIP(hostname);
  if (numericFamily === 4 || numericFamily === 6) {
    return { address: { address: hostname, family: numericFamily }, ok: true };
  }

  try {
    const resolved = lookup
      ? await lookup(hostname)
      : await dnsLookup(hostname, { family: 0, verbatim: true });
    const family = resolved.family === 6 ? 6 : 4;
    return { address: { address: normalizeHostname(resolved.address), family }, ok: true };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : "Webhook target DNS lookup failed.",
      ok: false,
    };
  }
}

function dispatchWebhookRequest(input: {
  body: unknown;
  idempotencyKey: string;
  maxResponseBytes: number;
  resolvedAddress: WorkerWebhookLookupResult;
  signal?: AbortSignal;
  timeoutMs: number;
  url: URL;
}): Promise<WorkerWebhookResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify(input.body ?? {});
    const request = input.url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = {
      headers: {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
      },
      hostname: normalizeHostname(input.url.hostname),
      lookup: (_hostname, _options, callback) => {
        if (typeof _options === "object" && _options && "all" in _options && _options.all) {
          callback(null, [
            {
              address: input.resolvedAddress.address,
              family: input.resolvedAddress.family,
            },
          ]);
          return;
        }

        callback(null, input.resolvedAddress.address, input.resolvedAddress.family);
      },
      method: "POST",
      path: `${input.url.pathname}${input.url.search}`,
      port: input.url.port ? Number(input.url.port) : undefined,
      protocol: input.url.protocol,
    };

    let responseBody = Buffer.alloc(0);
    let responseStatus: number | null = null;
    let settled = false;
    let timedOut = false;

    const settle = (result: WorkerWebhookResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortRequest);
      resolve(result);
    };

    const abortRequest = () => {
      clientRequest.destroy();
      settle(failed("webhook_request_failed", "Webhook request was aborted.", responseStatus));
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      clientRequest.destroy();
      settle(failed("webhook_timeout", "Webhook request timed out.", null));
    }, input.timeoutMs);

    const clientRequest = request(options, (response) => {
      responseStatus = response.statusCode ?? null;

      response.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        const nextLength = responseBody.length + chunk.length;
        if (nextLength > input.maxResponseBytes) {
          const available = Math.max(0, input.maxResponseBytes - responseBody.length);
          if (available > 0) {
            responseBody = Buffer.concat([responseBody, chunk.subarray(0, available)]);
          }
          response.destroy();
          clientRequest.destroy();
          settle({
            errorCode: "webhook_response_too_large",
            errorMessage: "Webhook response exceeded maximum size.",
            responseBody: bufferToResponseBody(responseBody),
            responseStatus,
            status: "failed",
          });
          return;
        }
        responseBody = Buffer.concat([responseBody, chunk]);
      });

      response.on("end", () => {
        if (settled) {
          return;
        }
        const bodyText = bufferToResponseBody(responseBody);
        if (responseStatus && responseStatus >= 200 && responseStatus < 300) {
          settle({
            responseBody: bodyText,
            responseStatus,
            status: "sent",
          });
          return;
        }
        settle({
          errorCode: "webhook_http_error",
          errorMessage:
            responseStatus === null
              ? "Webhook request failed without an HTTP status."
              : `Webhook returned HTTP ${responseStatus}.`,
          responseBody: bodyText,
          responseStatus,
          status: "failed",
        });
      });
    });

    input.signal?.addEventListener("abort", abortRequest, { once: true });

    clientRequest.on("error", (error) => {
      if (settled) {
        return;
      }
      if (timedOut) {
        settle(failed("webhook_timeout", "Webhook request timed out.", null));
        return;
      }
      settle(
        failed(
          "webhook_request_failed",
          error instanceof Error ? error.message : "Webhook request failed.",
          responseStatus,
        ),
      );
    });

    clientRequest.end(body);
  });
}

function isAllowedWebhookTarget(
  hostname: string,
  resolvedAddress: string,
  allowedHosts: string[],
): boolean {
  if (
    allowedHosts.includes(normalizeHostname(hostname)) ||
    allowedHosts.includes(normalizeHostname(resolvedAddress))
  ) {
    return true;
  }

  return !isBlockedAddress(resolvedAddress);
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isBlockedIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalized);
  if (!ipv6) {
    return true;
  }

  const mappedIpv4 = readIpv4MappedIpv6(ipv6);
  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4);
  }

  const first = ipv6[0];
  const second = ipv6[1];
  if (first === undefined || second === undefined) {
    return true;
  }

  return (
    ipv6.every((byte) => byte === 0) ||
    isIpv6Loopback(ipv6) ||
    first === 0xff ||
    (first & 0xfe) === 0xfc ||
    (first === 0xfe && (second & 0xc0) === 0x80)
  );
}

function isBlockedIpv4(octets: Ipv4Octets): boolean {
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first >= 224 && first <= 239)
  );
}

function isIpv6Loopback(bytes: number[]): boolean {
  return bytes.slice(0, 15).every((byte) => byte === 0) && (bytes[15] ?? -1) === 1;
}

function readIpv4MappedIpv6(bytes: number[]): Ipv4Octets | null {
  const tenth = bytes[10];
  const eleventh = bytes[11];
  if (bytes.slice(0, 10).every((byte) => byte === 0) && tenth === 0xff && eleventh === 0xff) {
    const first = bytes[12];
    const second = bytes[13];
    const third = bytes[14];
    const fourth = bytes[15];
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return null;
    }
    return [first, second, third, fourth];
  }
  return null;
}

function parseIpv4(address: string): Ipv4Octets | null {
  if (isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  const fourth = octets[3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null;
  }
  return [first, second, third, fourth];
}

function parseIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }

  const normalized = replaceIpv4Tail(address.toLowerCase());
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = readIpv6Parts(halves[0] ?? "");
  const right = readIpv6Parts(halves[1] ?? "");
  if (!left || !right) {
    return null;
  }

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }

  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) {
    return null;
  }

  return words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
}

function replaceIpv4Tail(address: string): string {
  if (!address.includes(".")) {
    return address;
  }

  const lastColon = address.lastIndexOf(":");
  if (lastColon < 0) {
    return address;
  }

  const ipv4 = parseIpv4(address.slice(lastColon + 1));
  if (!ipv4) {
    return address;
  }

  const high = (ipv4[0] << 8) | ipv4[1];
  const low = (ipv4[2] << 8) | ipv4[3];
  return `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
}

function readIpv6Parts(value: string): number[] | null {
  if (!value) {
    return [];
  }

  const parts = value.split(":");
  const parsed = parts.map((part) => Number.parseInt(part, 16));
  if (
    parts.some((part) => part.length === 0 || part.length > 4) ||
    parsed.some((part) => Number.isNaN(part) || part < 0 || part > 0xffff)
  ) {
    return null;
  }
  return parsed;
}

function normalizeAllowedHosts(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeHostname(value))
        .filter((value) => value.length > 0 && value !== "*"),
    ),
  ];
}

function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function bufferToResponseBody(buffer: Buffer): string | null {
  if (buffer.length === 0) {
    return null;
  }
  return buffer.toString("utf8");
}

function failed(
  errorCode: WorkerWebhookErrorCode,
  errorMessage: string,
  responseStatus: number | null,
): WorkerWebhookResult {
  return {
    errorCode,
    errorMessage,
    responseStatus,
    status: "failed",
  };
}

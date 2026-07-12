import type { MasterKeySource } from "@llmingress/security/master-key";
import { isRecord } from "@llmingress/util";
import type { JobHandler } from "./worker-job-runner.ts";
import { refreshProviderModels } from "./worker-model-refresh.ts";

export type {
  ConnectivityCheckProvider,
  ProviderConnectivityCheckResult,
} from "@llmingress/provider/connectivity";
export { checkProviderConnectivity } from "@llmingress/provider/connectivity";

type CreateProviderConnectivityCheckJobHandlerOptions = {
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  masterKeySource?: MasterKeySource;
  timeoutMs?: number;
};

export function createProviderConnectivityCheckJobHandler(
  options: CreateProviderConnectivityCheckJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const payload = readConnectivityCheckPayload(job.payload);
    return refreshProviderModels({
      ...options,
      followUpProbe: true,
      jobId: job.id,
      jobTrigger: job.trigger,
      providerId: payload.providerId,
      requestedProviderApiKeyId: payload.providerApiKeyId,
      timeoutMs: payload.timeoutMs ?? options.timeoutMs,
    });
  };
}

function readConnectivityCheckPayload(payload: unknown): {
  providerApiKeyId?: string;
  providerId: string;
  timeoutMs?: number;
} {
  if (!isRecord(payload)) {
    throw new Error("provider_connectivity_check job payload is required.");
  }
  if (typeof payload.providerId !== "string" || !payload.providerId.trim()) {
    throw new Error("provider_connectivity_check job payload requires providerId.");
  }
  if (payload.providerApiKeyId !== undefined && typeof payload.providerApiKeyId !== "string") {
    throw new Error("provider_connectivity_check job payload providerApiKeyId must be a string.");
  }
  return {
    providerApiKeyId: payload.providerApiKeyId?.trim() || undefined,
    providerId: payload.providerId,
    timeoutMs:
      typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
        ? payload.timeoutMs
        : undefined,
  };
}

import {
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import { PostgresClient } from "@llmingress/db/client";
import {
  type ConfigChangedNotification,
  createConfigChangedListener as createPostgresConfigChangedListener,
} from "@llmingress/db/config-versions";
import { buildManualPriceOverride, buildSyncedPriceSnapshot } from "@llmingress/db/price-rows";
import {
  createHealthSummaryChangedListener as createPostgresHealthSummaryChangedListener,
  type HealthSummaryChangedPayload,
} from "@llmingress/db/provider-health";
import {
  type ModelInputModality,
  type ModelOutputModality,
  normalizeProviderModelCapabilities,
  normalizeRoutePolicyRules,
  type ProviderModelCapabilities,
  type RouteCandidateHealthStatus,
  type RoutePolicyRules,
  type RoutePolicyStrategy,
} from "@llmingress/domain";
import { createLogger } from "@llmingress/logging";
import {
  createGatewayRuntimeStatusRecorder,
  type GatewayRuntimeStatusEvent,
  type RecordGatewayRuntimeStatus,
} from "./gateway-runtime-status.ts";

const logger = createLogger("gateway");

export type GatewayProviderSnapshot = {
  id: string;
  providerKey: string;
  displayName: string;
};

export type GatewayRoutePolicyStrategy = RoutePolicyStrategy;

export type GatewayRouteCandidateSnapshot = {
  candidateOrder: number;
  capabilities?: ProviderModelCapabilities;
  contextWindow?: number | null;
  displayName: string;
  healthStatus: RouteCandidateHealthStatus;
  inputModalities: ModelInputModality[] | null;
  maxOutputTokens: number | null;
  modelId: string;
  outputModalities: ModelOutputModality[] | null;
  price: ModelTokenPrice;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  supportsTools?: boolean;
};

export type GatewayRoutePolicySnapshot = {
  candidates: GatewayRouteCandidateSnapshot[];
  id: string;
  rules?: RoutePolicyRules;
  strategy: GatewayRoutePolicyStrategy;
  virtualModelId: string;
  virtualModelName: string;
};

export type GatewayConfigSnapshot = {
  version: number;
  providers: GatewayProviderSnapshot[];
  routePolicies: GatewayRoutePolicySnapshot[];
  loadedAt: Date;
};

export type GatewayConfigRuntime = {
  getSnapshot: () => GatewayConfigSnapshot;
  reconcile: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type ConfigChangedListener = {
  close: () => Promise<void>;
};

type CreateConfigChangedListener = (
  onNotification: (notification: ConfigChangedNotification) => void,
) => Promise<ConfigChangedListener>;

type CreateHealthSummaryChangedListener = (
  onNotification: (payload: HealthSummaryChangedPayload) => void,
) => Promise<ConfigChangedListener>;

type GatewayConfigRuntimeOptions = {
  createConfigChangedListener?: CreateConfigChangedListener;
  createHealthSummaryChangedListener?: CreateHealthSummaryChangedListener;
  databaseUrl?: string;
  enableNotifications?: boolean;
  gatewayInstanceId?: string;
  heartbeatIntervalMs?: number;
  loadLatestSnapshot?: () => Promise<GatewayConfigSnapshot>;
  recordRuntimeStatus?: RecordGatewayRuntimeStatus;
  reconcileIntervalMs?: number;
};

type ProviderRow = {
  displayName: string;
  id: string;
  providerKey: string;
};

export type RoutePolicyCandidateRow = {
  candidateOrder: number;
  capabilityMetadata: unknown;
  displayName: string;
  id: string;
  cachedInputUsdPerMillionTokens: string | null;
  contextWindow: number | null;
  inputUsdPerMillionTokens: string | null;
  healthStatus: RouteCandidateHealthStatus;
  inputModalities: ModelInputModality[] | null;
  maxOutputTokens: number | null;
  modelId: string;
  outputModalities: ModelOutputModality[] | null;
  outputUsdPerMillionTokens: string | null;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  rules: unknown;
  strategy: GatewayRoutePolicyStrategy;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  supportsTools: boolean;
  syncedAt: Date | null;
  syncedCachedInputUsdPerMillionTokens: string | null;
  syncedInputUsdPerMillionTokens: string | null;
  syncedOutputUsdPerMillionTokens: string | null;
  syncedPriceVersion: string | null;
  syncedSourceUrl: string | null;
  updatedAt: Date | null;
  virtualModelId: string;
  virtualModelName: string;
};

type VersionRow = {
  version: number;
};

const emptySnapshot: GatewayConfigSnapshot = {
  loadedAt: new Date(0),
  providers: [],
  routePolicies: [],
  version: 0,
};

export function createGatewayConfigRuntime(
  options: GatewayConfigRuntimeOptions,
): GatewayConfigRuntime {
  const loadLatestSnapshot = options.loadLatestSnapshot ?? createPostgresSnapshotLoader(options);
  const enableNotifications = options.enableNotifications !== false;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
  const gatewayInstanceId = options.gatewayInstanceId ?? "gateway";
  const recordRuntimeStatus =
    options.recordRuntimeStatus ??
    createGatewayRuntimeStatusRecorder({ databaseUrl: options.databaseUrl, gatewayInstanceId });

  let currentSnapshot = emptySnapshot;
  let listener: ConfigChangedListener | undefined;
  let healthListener: ConfigChangedListener | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reloadInFlight: Promise<void> | undefined;
  let trailingReloadRequest: ReloadRequest | undefined;

  type ReloadRequest = {
    force: boolean;
    targetVersion: number | null;
  };

  // Recording runtime status must never crash gateway boot or abort a config reload.
  async function recordRuntimeStatusSafe(event: GatewayRuntimeStatusEvent): Promise<void> {
    try {
      await recordRuntimeStatus(event);
    } catch (error) {
      logger.error({ err: error }, "failed to record runtime status");
    }
  }

  function shouldSkipReload(request: ReloadRequest): boolean {
    if (request.force || request.targetVersion === null) {
      return false;
    }
    return request.targetVersion <= currentSnapshot.version;
  }

  function mergeTrailingReload(request: ReloadRequest): void {
    if (!trailingReloadRequest) {
      trailingReloadRequest = request;
      return;
    }

    trailingReloadRequest = {
      force: trailingReloadRequest.force || request.force,
      targetVersion:
        trailingReloadRequest.targetVersion === null || request.targetVersion === null
          ? null
          : Math.max(trailingReloadRequest.targetVersion, request.targetVersion),
    };
  }

  async function runReload(request: ReloadRequest): Promise<void> {
    if (shouldSkipReload(request)) {
      return;
    }

    if (reloadInFlight) {
      mergeTrailingReload(request);
      await reloadInFlight;
      return;
    }

    reloadInFlight = (async () => {
      let nextRequest: ReloadRequest | undefined = request;
      while (nextRequest) {
        if (!shouldSkipReload(nextRequest)) {
          await performReload(nextRequest);
        }
        nextRequest = trailingReloadRequest;
        trailingReloadRequest = undefined;
      }
    })();

    try {
      await reloadInFlight;
    } finally {
      reloadInFlight = undefined;
    }
  }

  async function performReload(request: ReloadRequest): Promise<void> {
    let nextSnapshot: GatewayConfigSnapshot;
    try {
      nextSnapshot = await loadLatestSnapshot();
    } catch (error) {
      await recordRuntimeStatusSafe({
        type: "reload-failed",
        targetConfigVersion: request.targetVersion,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const previousVersion = currentSnapshot.version;
    if (request.force || nextSnapshot.version > previousVersion) {
      currentSnapshot = nextSnapshot;
    }
    if (nextSnapshot.version > previousVersion) {
      await recordRuntimeStatusSafe({
        type: "reload-succeeded",
        appliedConfigVersion: nextSnapshot.version,
        targetConfigVersion: request.targetVersion ?? nextSnapshot.version,
      });
    }
  }

  function scheduleReload(request: ReloadRequest): void {
    runReload(request).catch((error) => {
      logger.error({ err: error }, "gateway config reload failed");
    });
  }

  return {
    getSnapshot: () => currentSnapshot,
    // forceReload (not reloadIfNewer) so reconcile also recovers health-only
    // changes whose config version is unchanged, including ones whose
    // health_summary_changed LISTEN/NOTIFY was dropped.
    reconcile: () => runReload({ force: true, targetVersion: null }),
    start: async () => {
      currentSnapshot = await loadLatestSnapshot();
      await recordRuntimeStatusSafe({
        type: "startup",
        appliedConfigVersion: currentSnapshot.version,
        startedAt: new Date(),
      });

      if (enableNotifications) {
        const createConfigChangedListener =
          options.createConfigChangedListener ?? createPostgresNotificationListener(options);
        listener = await createConfigChangedListener((notification) => {
          scheduleReload({ force: false, targetVersion: notification.version });
        });

        const createHealthChangedListener =
          options.createHealthSummaryChangedListener ??
          createPostgresHealthNotificationListener(options);
        healthListener = await createHealthChangedListener((_payload) => {
          scheduleReload({ force: true, targetVersion: null });
        });
      }

      if (reconcileIntervalMs > 0) {
        reconcileTimer = setInterval(() => {
          scheduleReload({ force: true, targetVersion: null });
        }, reconcileIntervalMs);
        reconcileTimer.unref?.();
      }

      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          void recordRuntimeStatusSafe({
            type: "heartbeat",
            appliedConfigVersion: currentSnapshot.version,
          });
        }, heartbeatIntervalMs);
        heartbeatTimer.unref?.();
      }
    },
    stop: async () => {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = undefined;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      await listener?.close();
      listener = undefined;
      await healthListener?.close();
      healthListener = undefined;
      if (reloadInFlight) {
        try {
          await reloadInFlight;
        } catch (error) {
          logger.error({ err: error }, "gateway config reload failed during stop");
        }
      }
    },
  };
}

export async function loadGatewayConfigSnapshot(
  databaseUrl: string | undefined,
): Promise<GatewayConfigSnapshot> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const version = await client.query<VersionRow>(
      "select coalesce(max(version), 0)::integer as version from config_versions",
    );
    const providers = await client.query<ProviderRow>(
      `
        select id::text as id,
               provider_key as "providerKey",
               display_name as "displayName"
        from providers
        where enabled = true
          and deleted_at is null
        order by provider_key
      `,
    );
    const routePolicyCandidates = await client.query<RoutePolicyCandidateRow>(
      `
        select route_policies.id::text as id,
               route_policies.strategy,
               route_policies.rules,
               virtual_models.id::text as "virtualModelId",
               virtual_models.name as "virtualModelName",
               route_policy_candidates.provider_model_id::text as "providerModelId",
               route_policy_candidates.candidate_order as "candidateOrder",
               provider_models.model_id as "modelId",
               provider_models.display_name as "displayName",
               provider_models.context_window as "contextWindow",
               provider_models.input_modalities as "inputModalities",
               provider_models.output_modalities as "outputModalities",
               provider_models.max_output_tokens as "maxOutputTokens",
               provider_models.supports_function_calling as "supportsFunctionCalling",
               provider_models.supports_reasoning as "supportsReasoning",
               provider_models.supports_function_calling as "supportsTools",
               provider_models.capability_metadata as "capabilityMetadata",
               providers.id::text as "providerId",
               providers.provider_key as "providerKey",
               provider_models.manual_input_usd_per_million_tokens::text
                 as "inputUsdPerMillionTokens",
               provider_models.manual_cached_input_usd_per_million_tokens::text
                 as "cachedInputUsdPerMillionTokens",
               provider_models.manual_output_usd_per_million_tokens::text
                 as "outputUsdPerMillionTokens",
               provider_models.manual_price_updated_at as "updatedAt",
               provider_models.synced_input_usd_per_million_tokens::text
                 as "syncedInputUsdPerMillionTokens",
               provider_models.synced_cached_input_usd_per_million_tokens::text
                 as "syncedCachedInputUsdPerMillionTokens",
               provider_models.synced_output_usd_per_million_tokens::text
                 as "syncedOutputUsdPerMillionTokens",
               provider_models.synced_price_version
                 as "syncedPriceVersion",
               provider_models.synced_price_source_url
                 as "syncedSourceUrl",
               provider_models.synced_price_synced_at
                 as "syncedAt",
               coalesce(provider_health_summary.status, 'unknown') as "healthStatus"
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
        join route_policy_candidates
          on route_policy_candidates.route_policy_id = route_policies.id
        join provider_models on provider_models.id = route_policy_candidates.provider_model_id
        join providers on providers.id = provider_models.provider_id
        left join provider_health_summary
          on provider_health_summary.provider_id = providers.id
         and provider_health_summary.provider_model_id = provider_models.id
        where virtual_models.enabled = true
          and virtual_models.deleted_at is null
          and route_policies.deleted_at is null
          and providers.enabled = true
          and providers.deleted_at is null
          and provider_models.deleted_at is null
          and provider_models.availability = 'available'
        order by virtual_models.name,
                 route_policies.id,
                 route_policy_candidates.candidate_order
      `,
    );

    return {
      loadedAt: new Date(),
      providers: providers.rows,
      routePolicies: rowToRoutePolicySnapshots(routePolicyCandidates.rows),
      version: version.rows[0]?.version ?? 0,
    };
  } finally {
    await client.end();
  }
}

export function rowToRoutePolicySnapshots(
  rows: RoutePolicyCandidateRow[],
): GatewayRoutePolicySnapshot[] {
  const routePolicies = new Map<string, GatewayRoutePolicySnapshot>();

  for (const row of rows) {
    let routePolicy = routePolicies.get(row.id);
    if (!routePolicy) {
      routePolicy = {
        candidates: [],
        id: row.id,
        rules: normalizeRoutePolicyRules(row.rules),
        strategy: row.strategy,
        virtualModelId: row.virtualModelId,
        virtualModelName: row.virtualModelName,
      };
      routePolicies.set(row.id, routePolicy);
    }

    routePolicy.candidates.push({
      candidateOrder: row.candidateOrder,
      capabilities: normalizeProviderModelCapabilities(row.capabilityMetadata),
      contextWindow: row.contextWindow,
      displayName: row.displayName,
      healthStatus: row.healthStatus,
      inputModalities: row.inputModalities,
      maxOutputTokens: row.maxOutputTokens,
      modelId: row.modelId,
      outputModalities: row.outputModalities,
      price: resolveEffectiveModelTokenPrice({
        manualOverride: buildManualPriceOverride({
          cachedInputUsdPerMillionTokens: row.cachedInputUsdPerMillionTokens,
          inputUsdPerMillionTokens: row.inputUsdPerMillionTokens,
          modelId: row.modelId,
          outputUsdPerMillionTokens: row.outputUsdPerMillionTokens,
          providerKey: row.providerKey,
          updatedAt: row.updatedAt,
        }),
        modelId: row.modelId,
        providerKey: row.providerKey,
        syncedPrice: buildSyncedPriceSnapshot({
          cachedInputUsdPerMillionTokens: row.syncedCachedInputUsdPerMillionTokens,
          inputUsdPerMillionTokens: row.syncedInputUsdPerMillionTokens,
          modelId: row.modelId,
          outputUsdPerMillionTokens: row.syncedOutputUsdPerMillionTokens,
          priceVersion: row.syncedPriceVersion,
          providerKey: row.providerKey,
          sourceUrl: row.syncedSourceUrl,
          syncedAt: row.syncedAt,
        }),
      }),
      providerId: row.providerId,
      providerKey: row.providerKey,
      providerModelId: row.providerModelId,
      supportsFunctionCalling: row.supportsFunctionCalling,
      supportsReasoning: row.supportsReasoning,
      supportsTools: row.supportsTools,
    });
  }

  return [...routePolicies.values()];
}

function createPostgresSnapshotLoader(options: GatewayConfigRuntimeOptions) {
  return () => loadGatewayConfigSnapshot(options.databaseUrl);
}

function createPostgresNotificationListener(
  options: GatewayConfigRuntimeOptions,
): CreateConfigChangedListener {
  return (onNotification) =>
    createPostgresConfigChangedListener({
      databaseUrl: options.databaseUrl,
      onNotification,
    });
}

function createPostgresHealthNotificationListener(
  options: GatewayConfigRuntimeOptions,
): CreateHealthSummaryChangedListener {
  return (onNotification) =>
    createPostgresHealthSummaryChangedListener({
      databaseUrl: options.databaseUrl,
      onNotification,
    });
}

import {
  type ManualPriceOverride,
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
  type SyncedPriceSnapshot,
} from "@llmingress/billing/price-registry";
import {
  type ConfigChangedNotification,
  createConfigChangedListener as createPostgresConfigChangedListener,
} from "@llmingress/db/config-versions";
import {
  createHealthSummaryChangedListener as createPostgresHealthSummaryChangedListener,
  type HealthSummaryChangedPayload,
} from "@llmingress/db/provider-health";
import { isRemovedProviderKey } from "@llmingress/db/providers";
import { PostgresClient } from "@llmingress/db/routes";
import {
  normalizeProviderModelCapabilities,
  normalizeRoutePolicyRules,
  type ProviderModelCapabilities,
  type RouteCandidateHealthStatus,
  type RoutePolicyRules,
  type RoutePolicyStrategy,
} from "@llmingress/domain";
import {
  createGatewayRuntimeStatusRecorder,
  type GatewayRuntimeStatusEvent,
  noopRuntimeStatusRecorder,
  type RecordGatewayRuntimeStatus,
} from "./gateway-runtime-status.js";

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
  modelId: string;
  price: ModelTokenPrice;
  providerId: string;
  providerKey: string;
  providerModelId: string;
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
  modelId: string;
  outputUsdPerMillionTokens: string | null;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  rules: unknown;
  strategy: GatewayRoutePolicyStrategy;
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
    (options.databaseUrl
      ? createGatewayRuntimeStatusRecorder({ databaseUrl: options.databaseUrl, gatewayInstanceId })
      : noopRuntimeStatusRecorder);

  let currentSnapshot = emptySnapshot;
  let listener: ConfigChangedListener | undefined;
  let healthListener: ConfigChangedListener | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reloadInFlight: Promise<void> | undefined;

  // Recording runtime status must never crash gateway boot or abort a config reload.
  async function recordRuntimeStatusSafe(event: GatewayRuntimeStatusEvent): Promise<void> {
    try {
      await recordRuntimeStatus(event);
    } catch (error) {
      console.error("[gateway] failed to record runtime status", error);
    }
  }

  async function reloadIfNewer(targetVersion?: number): Promise<void> {
    if (targetVersion !== undefined && targetVersion <= currentSnapshot.version) {
      return;
    }

    if (reloadInFlight) {
      await reloadInFlight;
      if (targetVersion === undefined || targetVersion > currentSnapshot.version) {
        await reloadIfNewer(targetVersion);
      }
      return;
    }

    reloadInFlight = (async () => {
      let nextSnapshot: GatewayConfigSnapshot;
      try {
        nextSnapshot = await loadLatestSnapshot();
      } catch (error) {
        await recordRuntimeStatusSafe({
          type: "reload-failed",
          targetConfigVersion: targetVersion ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      if (nextSnapshot.version > currentSnapshot.version) {
        currentSnapshot = nextSnapshot;
        await recordRuntimeStatusSafe({
          type: "reload-succeeded",
          appliedConfigVersion: nextSnapshot.version,
          targetConfigVersion: targetVersion ?? nextSnapshot.version,
        });
      }
    })();

    try {
      await reloadInFlight;
    } finally {
      reloadInFlight = undefined;
    }
  }

  async function forceReload(): Promise<void> {
    if (reloadInFlight) {
      await reloadInFlight;
      // After the in-flight reload settles, do one more unconditional reload
      // to ensure health changes that arrived during the in-flight load are applied.
      await forceReload();
      return;
    }

    reloadInFlight = (async () => {
      let nextSnapshot: GatewayConfigSnapshot;
      try {
        nextSnapshot = await loadLatestSnapshot();
      } catch (error) {
        await recordRuntimeStatusSafe({
          type: "reload-failed",
          targetConfigVersion: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Unconditional swap — health changes don't bump config version.
      const previousVersion = currentSnapshot.version;
      currentSnapshot = nextSnapshot;
      // Only a config-version bump is a "reload"; same-version health refreshes are silent.
      if (nextSnapshot.version > previousVersion) {
        await recordRuntimeStatusSafe({
          type: "reload-succeeded",
          appliedConfigVersion: nextSnapshot.version,
          targetConfigVersion: nextSnapshot.version,
        });
      }
    })();

    try {
      await reloadInFlight;
    } finally {
      reloadInFlight = undefined;
    }
  }

  return {
    getSnapshot: () => currentSnapshot,
    // forceReload (not reloadIfNewer) so reconcile also recovers health-only
    // changes whose config version is unchanged, including ones whose
    // health_summary_changed LISTEN/NOTIFY was dropped.
    reconcile: () => forceReload(),
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
          void reloadIfNewer(notification.version);
        });

        const createHealthChangedListener =
          options.createHealthSummaryChangedListener ??
          (options.databaseUrl ? createPostgresHealthNotificationListener(options) : undefined);
        if (createHealthChangedListener) {
          healthListener = await createHealthChangedListener((_payload) => {
            void forceReload();
          });
        }
      }

      if (reconcileIntervalMs > 0) {
        reconcileTimer = setInterval(() => {
          void forceReload();
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
    },
  };
}

export async function loadGatewayConfigSnapshot(
  databaseUrl: string,
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
               provider_models.supports_tools as "supportsTools",
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
      providers: providers.rows.filter((provider) => !isRemovedProviderKey(provider.providerKey)),
      routePolicies: rowToRoutePolicySnapshots(
        routePolicyCandidates.rows.filter(
          (candidate) => !isRemovedProviderKey(candidate.providerKey),
        ),
      ),
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
      modelId: row.modelId,
      price: resolveEffectiveModelTokenPrice({
        manualOverride: rowToManualPriceOverride(row),
        modelId: row.modelId,
        providerKey: row.providerKey,
        syncedPrice: rowToSyncedPriceSnapshot(row),
      }),
      providerId: row.providerId,
      providerKey: row.providerKey,
      providerModelId: row.providerModelId,
      supportsTools: row.supportsTools,
    });
  }

  return [...routePolicies.values()];
}

function rowToManualPriceOverride(row: RoutePolicyCandidateRow): ManualPriceOverride | null {
  if (
    row.inputUsdPerMillionTokens === null ||
    row.outputUsdPerMillionTokens === null ||
    row.updatedAt === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.cachedInputUsdPerMillionTokens === null
        ? null
        : Number(row.cachedInputUsdPerMillionTokens),
    inputUsdPerMillionTokens: Number(row.inputUsdPerMillionTokens),
    modelId: row.modelId,
    outputUsdPerMillionTokens: Number(row.outputUsdPerMillionTokens),
    providerKey: row.providerKey,
    updatedAt: row.updatedAt,
  };
}

function rowToSyncedPriceSnapshot(row: RoutePolicyCandidateRow): SyncedPriceSnapshot | null {
  if (
    row.syncedInputUsdPerMillionTokens === null ||
    row.syncedOutputUsdPerMillionTokens === null ||
    row.syncedPriceVersion === null ||
    row.syncedAt === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.syncedCachedInputUsdPerMillionTokens === null
        ? null
        : Number(row.syncedCachedInputUsdPerMillionTokens),
    inputUsdPerMillionTokens: Number(row.syncedInputUsdPerMillionTokens),
    modelId: row.modelId,
    outputUsdPerMillionTokens: Number(row.syncedOutputUsdPerMillionTokens),
    priceVersion: row.syncedPriceVersion,
    providerKey: row.providerKey,
    sourceUrl: row.syncedSourceUrl,
    syncedAt: row.syncedAt,
  };
}

function createPostgresSnapshotLoader(options: GatewayConfigRuntimeOptions) {
  if (!options.databaseUrl) {
    throw new Error("Gateway config runtime requires databaseUrl or loadLatestSnapshot.");
  }

  return () => loadGatewayConfigSnapshot(options.databaseUrl as string);
}

function createPostgresNotificationListener(
  options: GatewayConfigRuntimeOptions,
): CreateConfigChangedListener {
  if (!options.databaseUrl) {
    throw new Error("Gateway config runtime requires databaseUrl or createConfigChangedListener.");
  }

  return (onNotification) =>
    createPostgresConfigChangedListener({
      databaseUrl: options.databaseUrl as string,
      onNotification,
    });
}

function createPostgresHealthNotificationListener(
  options: GatewayConfigRuntimeOptions,
): CreateHealthSummaryChangedListener {
  if (!options.databaseUrl) {
    throw new Error(
      "Gateway config runtime requires databaseUrl or createHealthSummaryChangedListener.",
    );
  }

  return (onNotification) =>
    createPostgresHealthSummaryChangedListener({
      databaseUrl: options.databaseUrl as string,
      onNotification,
    });
}

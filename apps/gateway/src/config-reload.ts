import {
  type ManualPriceOverride,
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
  type SyncedPriceSnapshot,
} from "@llmingress/billing/price-registry";
import {
  type ConfigChangedNotification,
  createConfigChangedListener as createPostgresConfigChangedListener,
} from "@llmingress/config";
import { Client } from "pg";
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

export type GatewayRoutePolicyStrategy = "fixed" | "cost_first" | "balanced" | "quality_first";

export type GatewayRouteCandidateSnapshot = {
  candidateOrder: number;
  displayName: string;
  isFallback: boolean;
  modelId: string;
  price: ModelTokenPrice;
  providerId: string;
  providerKey: string;
  providerModelId: string;
};

export type GatewayRoutePolicySnapshot = {
  candidates: GatewayRouteCandidateSnapshot[];
  id: string;
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

type GatewayConfigRuntimeOptions = {
  createConfigChangedListener?: CreateConfigChangedListener;
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

type RoutePolicyCandidateRow = {
  candidateOrder: number;
  displayName: string;
  id: string;
  inputUsdPerMillionTokens: string | null;
  isFallback: boolean;
  modelId: string;
  outputUsdPerMillionTokens: string | null;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  strategy: GatewayRoutePolicyStrategy;
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

  return {
    getSnapshot: () => currentSnapshot,
    reconcile: () => reloadIfNewer(),
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
      }

      if (reconcileIntervalMs > 0) {
        reconcileTimer = setInterval(() => {
          void reloadIfNewer();
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
    },
  };
}

export async function loadGatewayConfigSnapshot(
  databaseUrl: string,
): Promise<GatewayConfigSnapshot> {
  const client = new Client({ connectionString: databaseUrl });
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
        order by provider_key
      `,
    );
    const routePolicyCandidates = await client.query<RoutePolicyCandidateRow>(
      `
        select route_policies.id::text as id,
               route_policies.strategy,
               virtual_models.id::text as "virtualModelId",
               virtual_models.name as "virtualModelName",
               route_policy_candidates.provider_model_id::text as "providerModelId",
               route_policy_candidates.candidate_order as "candidateOrder",
               route_policy_candidates.is_fallback as "isFallback",
               provider_models.model_id as "modelId",
               provider_models.display_name as "displayName",
               providers.id::text as "providerId",
               providers.provider_key as "providerKey",
               model_price_overrides.input_usd_per_million_tokens::text
                 as "inputUsdPerMillionTokens",
               model_price_overrides.output_usd_per_million_tokens::text
                 as "outputUsdPerMillionTokens",
               model_price_overrides.updated_at as "updatedAt",
               latest_price_registry_snapshot.input_usd_per_million_tokens::text
                 as "syncedInputUsdPerMillionTokens",
               latest_price_registry_snapshot.cached_input_usd_per_million_tokens::text
                 as "syncedCachedInputUsdPerMillionTokens",
               latest_price_registry_snapshot.output_usd_per_million_tokens::text
                 as "syncedOutputUsdPerMillionTokens",
               latest_price_registry_snapshot.price_version
                 as "syncedPriceVersion",
               latest_price_registry_snapshot.source_url
                 as "syncedSourceUrl",
               latest_price_registry_snapshot.snapshot_at
                 as "syncedAt"
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
        join route_policy_candidates
          on route_policy_candidates.route_policy_id = route_policies.id
        join provider_models on provider_models.id = route_policy_candidates.provider_model_id
        join providers on providers.id = provider_models.provider_id
        left join model_price_overrides
          on lower(model_price_overrides.provider_key) = lower(providers.provider_key)
         and model_price_overrides.model_id = provider_models.model_id
        left join lateral (
          select input_usd_per_million_tokens,
                 cached_input_usd_per_million_tokens,
                 output_usd_per_million_tokens,
                 price_version,
                 source_url,
                 snapshot_at
          from price_registry_snapshots
          where lower(price_registry_snapshots.provider_key) = lower(providers.provider_key)
            and price_registry_snapshots.model_id = provider_models.model_id
          order by snapshot_at desc, created_at desc
          limit 1
        ) latest_price_registry_snapshot on true
        where virtual_models.enabled = true
          and providers.enabled = true
          and provider_models.availability = 'available'
        order by virtual_models.name,
                 route_policies.id,
                 route_policy_candidates.is_fallback,
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

function rowToRoutePolicySnapshots(rows: RoutePolicyCandidateRow[]): GatewayRoutePolicySnapshot[] {
  const routePolicies = new Map<string, GatewayRoutePolicySnapshot>();

  for (const row of rows) {
    let routePolicy = routePolicies.get(row.id);
    if (!routePolicy) {
      routePolicy = {
        candidates: [],
        id: row.id,
        strategy: row.strategy,
        virtualModelId: row.virtualModelId,
        virtualModelName: row.virtualModelName,
      };
      routePolicies.set(row.id, routePolicy);
    }

    routePolicy.candidates.push({
      candidateOrder: row.candidateOrder,
      displayName: row.displayName,
      isFallback: row.isFallback,
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

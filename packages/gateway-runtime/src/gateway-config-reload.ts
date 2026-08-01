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
import type {
  ModelInputModality,
  ModelOutputModality,
  RouteEndpointProtocol,
  RoutePolicyStrategy,
} from "@llmingress/domain";
import { createLogger } from "@llmingress/logging";

const logger = createLogger("gateway");

export type GatewayProviderSnapshot = {
  id: string;
  providerKey: string;
  displayName: string;
};

export type GatewayRoutePolicyStrategy = RoutePolicyStrategy;

export type GatewayRouteCandidateSnapshot = {
  candidateOrder: number;
  contextWindow?: number | null;
  displayName: string;
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
  tags: string[];
  weight: number | null;
};

export type GatewayRoutePolicySnapshot = {
  candidates: GatewayRouteCandidateSnapshot[];
  endpointProtocol: RouteEndpointProtocol;
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
  getReadinessStatus: () => GatewayConfigReadinessStatus;
  getSnapshot: () => GatewayConfigSnapshot;
  reconcile: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type GatewayConfigReadinessStatus = {
  hasLoadedSnapshot: boolean;
  lastReloadFailed: boolean;
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
  loadLatestSnapshot?: () => Promise<GatewayConfigSnapshot>;
  reconcileIntervalMs?: number;
};

type ProviderRow = {
  displayName: string;
  id: string;
  providerKey: string;
};

export type RoutePolicyCandidateRow = {
  candidateOrder: number;
  displayName: string;
  id: string;
  cachedInputUsdPerMillionTokens: string | null;
  contextWindow: number | null;
  inputUsdPerMillionTokens: string | null;
  inputModalities: ModelInputModality[] | null;
  maxOutputTokens: number | null;
  modelId: string;
  outputModalities: ModelOutputModality[] | null;
  outputUsdPerMillionTokens: string | null;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  endpointProtocol: RouteEndpointProtocol;
  strategy: GatewayRoutePolicyStrategy;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  syncedAt: Date | null;
  syncedCachedInputUsdPerMillionTokens: string | null;
  syncedInputUsdPerMillionTokens: string | null;
  syncedOutputUsdPerMillionTokens: string | null;
  syncedPriceVersion: string | null;
  syncedSourceUrl: string | null;
  tags: string[] | null;
  updatedAt: Date | null;
  virtualModelId: string;
  virtualModelName: string;
  weight: string | null;
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
  let currentSnapshot = emptySnapshot;
  let hasLoadedSnapshot = false;
  let lastReloadFailed = false;
  let listener: ConfigChangedListener | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let reloadInFlight: Promise<void> | undefined;
  let trailingReloadRequest: ReloadRequest | undefined;

  type ReloadRequest = {
    force: boolean;
    targetVersion: number | null;
  };

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
      lastReloadFailed = true;
      throw error;
    }

    lastReloadFailed = false;

    const previousVersion = currentSnapshot.version;
    if (request.force || nextSnapshot.version > previousVersion) {
      currentSnapshot = nextSnapshot;
    }
  }

  function scheduleReload(request: ReloadRequest): void {
    runReload(request).catch((error) => {
      logger.error({ err: error }, "gateway config reload failed");
    });
  }

  return {
    getReadinessStatus: () => ({ hasLoadedSnapshot, lastReloadFailed }),
    getSnapshot: () => currentSnapshot,
    reconcile: () => runReload({ force: true, targetVersion: null }),
    start: async () => {
      currentSnapshot = await loadLatestSnapshot();
      hasLoadedSnapshot = true;
      lastReloadFailed = false;

      if (enableNotifications) {
        const createConfigChangedListener =
          options.createConfigChangedListener ?? createPostgresNotificationListener(options);
        listener = await createConfigChangedListener((notification) => {
          scheduleReload({ force: false, targetVersion: notification.version });
        });
      }

      if (reconcileIntervalMs > 0) {
        reconcileTimer = setInterval(() => {
          scheduleReload({ force: true, targetVersion: null });
        }, reconcileIntervalMs);
        reconcileTimer.unref?.();
      }
    },
    stop: async () => {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = undefined;
      }
      await listener?.close();
      listener = undefined;
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
               route_policies.endpoint_protocol as "endpointProtocol",
               virtual_models.id::text as "virtualModelId",
               virtual_models.name as "virtualModelName",
               route_policy_candidates.provider_model_id::text as "providerModelId",
               route_policy_candidates.candidate_order as "candidateOrder",
               route_policy_candidates.tags,
               route_policy_candidates.weight::text as weight,
               provider_models.model_id as "modelId",
               provider_models.display_name as "displayName",
               provider_models.context_window as "contextWindow",
               provider_models.input_modalities as "inputModalities",
               provider_models.output_modalities as "outputModalities",
               provider_models.max_output_tokens as "maxOutputTokens",
               provider_models.supports_function_calling as "supportsFunctionCalling",
               provider_models.supports_reasoning as "supportsReasoning",
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
                 as "syncedAt"
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
        join route_policy_candidates
          on route_policy_candidates.route_policy_id = route_policies.id
        join provider_models on provider_models.id = route_policy_candidates.provider_model_id
        join providers on providers.id = provider_models.provider_id
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
        endpointProtocol: row.endpointProtocol,
        id: row.id,
        strategy: row.strategy,
        virtualModelId: row.virtualModelId,
        virtualModelName: row.virtualModelName,
      };
      routePolicies.set(row.id, routePolicy);
    }

    routePolicy.candidates.push({
      candidateOrder: row.candidateOrder,
      contextWindow: row.contextWindow,
      displayName: row.displayName,
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
      tags: row.tags ?? [],
      weight: row.weight === null ? null : Number(row.weight),
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

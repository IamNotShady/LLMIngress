import {
  type ManualPriceOverride,
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import {
  type ConfigChangedNotification,
  createConfigChangedListener as createPostgresConfigChangedListener,
} from "@llmingress/config";
import { Client } from "pg";

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
  loadLatestSnapshot?: () => Promise<GatewayConfigSnapshot>;
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

  let currentSnapshot = emptySnapshot;
  let listener: ConfigChangedListener | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let reloadInFlight: Promise<void> | undefined;

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
      const nextSnapshot = await loadLatestSnapshot();
      if (nextSnapshot.version > currentSnapshot.version) {
        currentSnapshot = nextSnapshot;
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
    },
    stop: async () => {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = undefined;
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
               model_price_overrides.updated_at as "updatedAt"
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
        join route_policy_candidates
          on route_policy_candidates.route_policy_id = route_policies.id
        join provider_models on provider_models.id = route_policy_candidates.provider_model_id
        join providers on providers.id = provider_models.provider_id
        left join model_price_overrides
          on lower(model_price_overrides.provider_key) = lower(providers.provider_key)
         and model_price_overrides.model_id = provider_models.model_id
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

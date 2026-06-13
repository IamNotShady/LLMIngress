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

export type GatewayConfigSnapshot = {
  version: number;
  providers: GatewayProviderSnapshot[];
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

type VersionRow = {
  version: number;
};

const emptySnapshot: GatewayConfigSnapshot = {
  loadedAt: new Date(0),
  providers: [],
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

    return {
      loadedAt: new Date(),
      providers: providers.rows,
      version: version.rows[0]?.version ?? 0,
    };
  } finally {
    await client.end();
  }
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

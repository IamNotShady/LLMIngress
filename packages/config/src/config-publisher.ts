import { randomUUID } from "node:crypto";
import { Client } from "pg";

export const CONFIG_CHANGED_CHANNEL = "config_changed";

export type ConfigChangeSource = "console" | "worker" | "system" | "migration";

export type ConfigChange = {
  table: string;
  recordId?: string | null;
};

export type PublishedConfigChange = ConfigChange & {
  id: string;
};

export type ConfigPublishResult = {
  version: number;
  configVersionId: string;
  source: ConfigChangeSource;
  changes: PublishedConfigChange[];
};

export type ConfigChangedPayload = {
  version: number;
  configVersionId: string;
  source: ConfigChangeSource;
  changeCount: number;
};

export type ConfigChangedNotification = ConfigChangedPayload & {
  channel: typeof CONFIG_CHANGED_CHANNEL;
};

export type ConfigPublishQueryResult<T> = {
  rows: T[];
};

export type ConfigPublishClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<ConfigPublishQueryResult<T>>;
};

type ConfigPublishConnection = ConfigPublishClient & {
  end?: () => Promise<void>;
};

type CreateConfigPublisherOptions = {
  databaseUrl?: string;
  connect?: () => Promise<ConfigPublishConnection>;
};

type PublishConfigChangeInput = {
  source: ConfigChangeSource;
  description?: string;
  changes: ConfigChange[];
  write: (client: ConfigPublishClient) => Promise<void>;
};

type ConfigVersionRow = {
  id: string;
  version: number;
};

type ConfigChangedListenerOptions = {
  databaseUrl: string;
  onNotification: (notification: ConfigChangedNotification) => void;
};

export function createConfigPublisher(options: CreateConfigPublisherOptions) {
  return {
    publish: (input: PublishConfigChangeInput) => publishConfigChange(options, input),
  };
}

export async function createConfigChangedListener(options: ConfigChangedListenerOptions): Promise<{
  close: () => Promise<void>;
}> {
  const client = new Client({ connectionString: options.databaseUrl });
  client.on("notification", (message) => {
    if (message.channel !== CONFIG_CHANGED_CHANNEL || !message.payload) {
      return;
    }

    try {
      const payload = JSON.parse(message.payload) as ConfigChangedPayload;
      options.onNotification({
        ...payload,
        channel: CONFIG_CHANGED_CHANNEL,
      });
    } catch {
      return;
    }
  });

  await client.connect();
  await client.query(`listen ${CONFIG_CHANGED_CHANNEL}`);

  return {
    close: async () => {
      await client.query(`unlisten ${CONFIG_CHANGED_CHANNEL}`);
      await client.end();
    },
  };
}

async function publishConfigChange(
  options: CreateConfigPublisherOptions,
  input: PublishConfigChangeInput,
): Promise<ConfigPublishResult> {
  if (input.changes.length === 0) {
    throw new Error("Config publisher requires at least one config change.");
  }

  const connection = await connect(options);

  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock($1)", [11_000_011]);
    await input.write(connection);

    const version = await insertConfigVersion(connection, input);
    const changes = await insertConfigChanges(connection, input, version.configVersionId);
    const result: ConfigPublishResult = {
      version: version.version,
      configVersionId: version.configVersionId,
      source: input.source,
      changes,
    };

    await connection.query("select pg_notify($1, $2)", [
      CONFIG_CHANGED_CHANNEL,
      JSON.stringify(buildConfigChangedPayload(result)),
    ]);
    await connection.query("commit");

    return result;
  } catch (error) {
    await connection.query("rollback").catch(() => {});
    throw error;
  } finally {
    await connection.end?.();
  }
}

function buildConfigChangedPayload(result: ConfigPublishResult): ConfigChangedPayload {
  return {
    version: result.version,
    configVersionId: result.configVersionId,
    source: result.source,
    changeCount: result.changes.length,
  };
}

async function connect(options: CreateConfigPublisherOptions): Promise<ConfigPublishConnection> {
  if (options.connect) {
    return options.connect();
  }

  if (!options.databaseUrl) {
    throw new Error("Config publisher requires databaseUrl or connect.");
  }

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  return {
    query: async <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values ? [...values] : undefined);
      return { rows: result.rows as T[] };
    },
    end: async () => {
      await client.end();
    },
  };
}

async function insertConfigVersion(
  client: ConfigPublishClient,
  input: PublishConfigChangeInput,
): Promise<{ configVersionId: string; version: number }> {
  const result = await client.query<ConfigVersionRow>(
    "insert into config_versions (version, source, description) select coalesce(max(version), 0) + 1, $1, $2 from config_versions returning id::text, version",
    [input.source, input.description ?? null],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Config publisher failed to create config version.");
  }

  return {
    configVersionId: row.id,
    version: row.version,
  };
}

async function insertConfigChanges(
  client: ConfigPublishClient,
  input: PublishConfigChangeInput,
  configVersionId: string,
): Promise<PublishedConfigChange[]> {
  const changes: PublishedConfigChange[] = [];

  for (const change of input.changes) {
    const id = randomUUID();
    await client.query(
      "insert into config_change_events (id, config_version_id, source, changed_table, changed_record_id) values ($1, $2, $3, $4, $5)",
      [id, configVersionId, input.source, change.table, change.recordId ?? null],
    );
    changes.push({ ...change, id });
  }

  return changes;
}

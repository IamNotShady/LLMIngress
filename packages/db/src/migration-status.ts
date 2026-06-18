import { Client, type QueryResultRow } from "pg";

export type MigrationStatusMigration = {
  checksum: string;
  id: string;
  name: string;
};

export type AppliedMigrationStatus = {
  appliedAt: Date;
  checksum: string;
  id: string;
  name: string;
};

export type MigrationChecksumMismatch = {
  appliedChecksum: string;
  expectedChecksum: string;
  id: string;
};

export type MigrationStatusKind = "mismatch" | "pending" | "uninitialized" | "up_to_date";

export type MigrationStatusSummary = {
  appliedCount: number;
  checksumMismatches: MigrationChecksumMismatch[];
  currentSchemaVersion: string | null;
  latestMigrationId: string | null;
  latestMigrationName: string | null;
  migrateCheckHealth: {
    command: "pnpm run db:migrate:check";
    message: string;
    status: "blocked" | "ready";
  };
  pendingCount: number;
  pendingMigrations: Pick<MigrationStatusMigration, "id" | "name">[];
  status: MigrationStatusKind;
  totalCount: number;
};

type AppliedMigrationRow = QueryResultRow & {
  applied_at: Date;
  checksum: string;
  id: string;
  name: string;
};

type SchemaVersionRow = QueryResultRow & {
  version: string;
};

export const shippedSqlMigrations: MigrationStatusMigration[] = [
  {
    checksum: "793a079d4d978a49bbd50fce36e868dfa2a110c3e47d3cf554a8397c90070606",
    id: "0001",
    name: "create_schema_version",
  },
  {
    checksum: "b874655baab3e693783baa9ba34bab3cdcd7af2cab0ad73e9625a9ad64d31a53",
    id: "0002",
    name: "core_config_schema",
  },
  {
    checksum: "1897fcdb0b25189e00f3456d80aef53993a7be5605c94c1d8185b5051ae1dfde",
    id: "0003",
    name: "runtime_records_jobs_schema",
  },
  {
    checksum: "2c3fe7d7a982a2b0aaea2ac6b049bc53b3d39b0f1a79f6c343b47102c2c5e69a",
    id: "0004",
    name: "console_auth_schema",
  },
  {
    checksum: "19a2bce61ec841cfdadeeec4e4a8dc6816022c15becb96271f9c84580c06532e",
    id: "0005",
    name: "model_price_overrides",
  },
  {
    checksum: "b350ec33260e38cb90dc91f550b52b91b2db2b6d945551a8d04eaf3e8edfc6dc",
    id: "0006",
    name: "provider_key_secure_storage",
  },
  {
    checksum: "e861f18888c83835a35e3314d767aae8528ee5af7f469a367155d1b3138bf192",
    id: "0007",
    name: "provider_templates",
  },
  {
    checksum: "2c72096424b78bb24506476615a97b70858af6d6099ca46d2bb22fc1f1807d4c",
    id: "0008",
    name: "ollama_provider_template",
  },
  {
    checksum: "e67e5e9e9e80c881aad3ad8acdf905ef0e159687dc610bf81beaf6c91a406df6",
    id: "0009",
    name: "remote_openai_compatible_templates",
  },
  {
    checksum: "d2f0191712dd5e831a4f2f70ed52cc22adc2cd2b37dd88b4b28a1dab21be6f27",
    id: "0010",
    name: "local_provider_templates",
  },
  {
    checksum: "d359f730fd555fcbfff4958a451aa72d7e9fcdaf4f3611bc979be4a949963545",
    id: "0011",
    name: "openrouter_provider",
  },
  {
    checksum: "c4f13adf27d510e892cf74f8d1c1ce1b5a85ea9b8bd91eb6b8a8a1acf4038078",
    id: "0012",
    name: "gemini_provider",
  },
  {
    checksum: "482606052b58145e78bc9b9aafe180da1b95c1123d5c9da6883116ed239111e8",
    id: "0013",
    name: "provider_multi_key_failover",
  },
  {
    checksum: "52a86d0c41c9625bcb1149aaa75635c75c0ab97360b70c082ae57cca0c42edf9",
    id: "0014",
    name: "price_registry_snapshots",
  },
  {
    checksum: "8a4a7d627fc704d64f7379a30c7dcf5fe4d8676fe0193c388d8009b4505b59ad",
    id: "0015",
    name: "billing_reconciliation",
  },
  {
    checksum: "a71ffa86f0f1c09ed12bc36accba7255d49d3ffa4bbe0654a201b918e9c67acb",
    id: "0016",
    name: "jsonl_request_log_export",
  },
  {
    checksum: "e27124e5c28c9fdd38634478e56614590465d30e9f65ce18329b0f95dafc882c",
    id: "0017",
    name: "cost_report_export",
  },
  {
    checksum: "99e048949865f663735fb157137c60a7513e4f8412e2f6419af8b7040680dcd1",
    id: "0018",
    name: "notification_channels",
  },
  {
    checksum: "4bec8dd6b3808938ff23d54f40305d4947096e50165b000ecfb93289fc82833a",
    id: "0019",
    name: "webhook_event_export",
  },
  {
    checksum: "2fbeb0f5655ca8e0f68288bb5986fc116d14aa2d0544d8738d94c8ec79c40aac",
    id: "0020",
    name: "budget_threshold_alerts",
  },
  {
    checksum: "3a5806520e66b7e045169033b1be7fed77d6fa3bc4766c400c89e7e5e3265b1c",
    id: "0021",
    name: "rate_limit_alerts",
  },
  {
    checksum: "f16a567274d5939c739f7fd7bb00bf88e07526a27f9cf44f4aca08fdcdae3496",
    id: "0022",
    name: "provider_failure_alerts",
  },
  {
    checksum: "c659fdc22f61d6a62fffb0a1003f8165d338b6b81096ce5d009e0da8dc8d0fba",
    id: "0023",
    name: "fallback_exhaustion_alerts",
  },
  {
    checksum: "bf88fbe37f7a3c443bdc9c66f41235ceacf5306dba5f42af8bb0ac87e8a46121",
    id: "0024",
    name: "provider_model_prices",
  },
  {
    checksum: "fec8a2f10b88ca2f7d1d7f0e320a341b045c811233a25705e014abb38041208a",
    id: "0025",
    name: "remove_process_heartbeats",
  },
  {
    checksum: "d6a8228d1de41ff485fa3ebbe7a3edfc34fcf45336abdc22852a0ea431e09bd0",
    id: "0026",
    name: "provider_key_operational_metadata",
  },
  {
    checksum: "81567da886f409a2d0364d853f103b07d01ea57899058f3afc3825c9a726fefa",
    id: "0027",
    name: "agent_platform_status_logging",
  },
  {
    checksum: "f95f77c77c9d3a05b6b57656b4e958106581ac8c4218a7c4588f4e8b9592dd6a",
    id: "0028",
    name: "activity_detail_metadata",
  },
];

export async function getMigrationStatusFromDatabase(input: {
  databaseUrl: string;
  migrations: MigrationStatusMigration[];
}): Promise<MigrationStatusSummary> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const [hasMigrationHistory, hasSchemaVersion] = await Promise.all([
      tableExists(client, "migration_history"),
      tableExists(client, "schema_version"),
    ]);
    const appliedMigrations = hasMigrationHistory ? await readAppliedMigrations(client) : [];
    const currentSchemaVersion = hasSchemaVersion ? await readCurrentSchemaVersion(client) : null;

    return summarizeMigrationStatus({
      appliedMigrations,
      currentSchemaVersion,
      migrations: input.migrations,
    });
  } finally {
    await client.end();
  }
}

export function summarizeMigrationStatus(input: {
  appliedMigrations: AppliedMigrationStatus[];
  currentSchemaVersion: string | null;
  migrations: MigrationStatusMigration[];
}): MigrationStatusSummary {
  const appliedById = new Map(
    input.appliedMigrations.map((migration): [string, AppliedMigrationStatus] => [
      migration.id,
      migration,
    ]),
  );
  const pendingMigrations = input.migrations
    .filter((migration) => !appliedById.has(migration.id))
    .map(({ id, name }) => ({ id, name }));
  const checksumMismatches = input.migrations.flatMap((migration) => {
    const applied = appliedById.get(migration.id);
    if (!applied || applied.checksum === migration.checksum) {
      return [];
    }

    return [
      {
        appliedChecksum: applied.checksum,
        expectedChecksum: migration.checksum,
        id: migration.id,
      },
    ];
  });
  const latestMigration = input.migrations.at(-1) ?? null;
  const status = readMigrationStatusKind({
    appliedCount: input.appliedMigrations.length,
    checksumMismatches,
    currentSchemaVersion: input.currentSchemaVersion,
    pendingMigrations,
  });

  return {
    appliedCount: input.appliedMigrations.length,
    checksumMismatches,
    currentSchemaVersion: input.currentSchemaVersion,
    latestMigrationId: latestMigration?.id ?? null,
    latestMigrationName: latestMigration?.name ?? null,
    migrateCheckHealth: {
      command: "pnpm run db:migrate:check",
      message:
        checksumMismatches.length > 0
          ? "Migration validation is blocked by checksum mismatch."
          : pendingMigrations.length > 0
            ? "Migration validation can run; pending migrations remain."
            : "Migration validation can run; schema is up to date.",
      status: checksumMismatches.length > 0 ? "blocked" : "ready",
    },
    pendingCount: pendingMigrations.length,
    pendingMigrations,
    status,
    totalCount: input.migrations.length,
  };
}

export function formatMigrationStatusReport(status: MigrationStatusSummary): string {
  return [
    `Migration status: ${formatMigrationStatusKind(status.status)}`,
    `Current schema: ${status.currentSchemaVersion ?? "not initialized"}`,
    `Latest migration: ${
      status.latestMigrationId && status.latestMigrationName
        ? formatMigrationLabel(status.latestMigrationId, status.latestMigrationName)
        : "none"
    }`,
    `Applied migrations: ${status.appliedCount}/${status.totalCount}`,
    `Pending migrations: ${formatMigrationList(status.pendingMigrations)}`,
    `db:migrate:check health: ${formatMigrateCheckHealth(status)}`,
  ].join("\n");
}

function readMigrationStatusKind(input: {
  appliedCount: number;
  checksumMismatches: MigrationChecksumMismatch[];
  currentSchemaVersion: string | null;
  pendingMigrations: Pick<MigrationStatusMigration, "id" | "name">[];
}): MigrationStatusKind {
  if (input.checksumMismatches.length > 0) {
    return "mismatch";
  }
  if (input.appliedCount === 0 && input.currentSchemaVersion === null) {
    return "uninitialized";
  }
  return input.pendingMigrations.length > 0 ? "pending" : "up_to_date";
}

function formatMigrationStatusKind(status: MigrationStatusKind): string {
  return status.replaceAll("_", " ");
}

function formatMigrateCheckHealth(status: MigrationStatusSummary): string {
  const healthLabel = status.migrateCheckHealth.status === "ready" ? "Ready" : "Blocked";
  return `${healthLabel} - ${status.migrateCheckHealth.message}`;
}

function formatMigrationList(migrations: Pick<MigrationStatusMigration, "id" | "name">[]): string {
  if (migrations.length === 0) {
    return "none";
  }
  return migrations
    .map((migration) => formatMigrationLabel(migration.id, migration.name))
    .join(", ");
}

function formatMigrationLabel(id: string, name: string): string {
  return `${id}_${name}`;
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
          and table_type = 'BASE TABLE'
      )
    `,
    [tableName],
  );
  return result.rows[0]?.exists ?? false;
}

async function readAppliedMigrations(client: Client): Promise<AppliedMigrationStatus[]> {
  const result = await client.query<AppliedMigrationRow>(
    `
      select id,
             name,
             checksum,
             applied_at
      from migration_history
      order by id
    `,
  );
  return result.rows.map((row) => ({
    appliedAt: row.applied_at,
    checksum: row.checksum,
    id: row.id,
    name: row.name,
  }));
}

async function readCurrentSchemaVersion(client: Client): Promise<string | null> {
  const result = await client.query<SchemaVersionRow>(
    `
      select version
      from schema_version
      where id = 1
    `,
  );
  return result.rows[0]?.version ?? null;
}

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

export const shippedSqlMigrations: MigrationStatusMigration[] = [
  {
    checksum: "793a079d4d978a49bbd50fce36e868dfa2a110c3e47d3cf554a8397c90070606",
    id: "0001",
    name: "create_schema_version",
  },
  {
    checksum: "2dc26fd292475ffa8b4e644e6e320815b232708684421e077ab42d5c200d67f9",
    id: "0002",
    name: "core_config_schema",
  },
  {
    checksum: "4895bcf4af76a2d5cd6108bf7acc8b11878177c3c324fa416ef9b8b26a1e9d15",
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
    checksum: "eedc6d995a2a318db24862be68ff9b9f5eec3c7307e40fabbde5e8384c020b11",
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
    checksum: "d80ef98fea9a220107ed3cce14bf7aa0e9663dd12dc2c5e7929d5a26850cb32b",
    id: "0028",
    name: "activity_detail_metadata",
  },
  {
    checksum: "44a2a8a3d47f0ad29f7d563e1ad21439de29088fcb7a029afb91734fbfe3b15d",
    id: "0029",
    name: "analytics_backend_indexes",
  },
  {
    checksum: "824d5fa0b5dd07005b38c2a6d8ddcee33c69ec3fade3630f7026443b32cefdda",
    id: "0030",
    name: "advanced_route_rules_preview",
  },
  {
    checksum: "aade4f0ce0fd5ba37b4cc2216a152cb2b51c4a0d953932ffb6a0b79e478d9a61",
    id: "0031",
    name: "concurrency_limit_policy",
  },
  {
    checksum: "fee55665a009264ad29490823db64204cda0db46fe4fc70cd54b56974aa733b7",
    id: "0032",
    name: "agent_owned_api_key",
  },
  {
    checksum: "d888af9f3c75fe615aed2525dc3518a7fd02d93906bb3f8b704c34ae1875f2fe",
    id: "0033",
    name: "allow_duplicate_provider_keys",
  },
  {
    checksum: "f57e8961e6dfca28a843dcfdac6d4e3920e1e67d175af16d06a5a707a2270136",
    id: "0034",
    name: "virtual_model_description",
  },
  {
    checksum: "fd0bf9211e00dc92ad691346ca63f0e7efe526ec48948a07addaa343d8c87e38",
    id: "0035",
    name: "virtual_model_description_schema_version",
  },
  {
    checksum: "1a08ddf084191f6cdd0a2ef9bf3fd3683f766c3e2cedef2aabee4d96dfbbe43a",
    id: "0036",
    name: "merge_provider_model_prices",
  },
  {
    checksum: "b7f753937c590a875d085a334a609cbd72bafd26e8d7e52c9dc096152faef573",
    id: "0037",
    name: "merge_request_savings_and_schema_version",
  },
  {
    checksum: "a85ff3529f2bb3c3dfc4fe7c40f88ac1bc953ff9a0a2f119f3f33d20d04de494",
    id: "0038",
    name: "config_soft_delete",
  },
  {
    checksum: "7ea8e078e801b5dd0e628a05988d39f470e02c08da839181067dd966b30a2966",
    id: "0039",
    name: "merge_export_tasks_into_jobs",
  },
  {
    checksum: "d83b3e68defc31c996c3d843acb5949ace5f5a7e5871f14300a83894c6414a29",
    id: "0040",
    name: "merge_config_changes_into_versions",
  },
  {
    checksum: "463e8fdf39b18da5da19d7a0f6e927fc57dcfd604bbcf98d348c6c533401412f",
    id: "0041",
    name: "provider_openai_compatible_urls",
  },
  {
    checksum: "b6c2598d758b3b77a49e3457319f2aa19fc102369346d3cc43e0567049d35c0b",
    id: "0042",
    name: "remove_unsupported_remote_provider_templates",
  },
  {
    checksum: "9a88ee5ad2a2347bfe4a6d58169d4a93e40fd24053205beddd9e69526110b78e",
    id: "0043",
    name: "provider_health_status_taxonomy",
  },
  {
    checksum: "3053a00657302e0ee7e17547e39e4044c9b1b187a0f406acca841a63fd6c1595",
    id: "0044",
    name: "provider_api_key_test_status_taxonomy",
  },
  {
    checksum: "db1a1a440cfc7985deb7b03ebe1bdcd41fe47b7f6d01c5f820e9249aacb764a9",
    id: "0045",
    name: "provider_subscription_oauth",
  },
];

export async function getMigrationStatusFromDatabase(input: {
  databaseUrl: string;
  migrations: MigrationStatusMigration[];
}): Promise<MigrationStatusSummary> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const hasMigrationHistory = await tableExists(client, "migration_history");
    const appliedMigrations = hasMigrationHistory ? await readAppliedMigrations(client) : [];
    const currentSchemaVersion = appliedMigrations.at(-1)?.id ?? null;

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

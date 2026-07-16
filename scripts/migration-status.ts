import { parseArgs } from "node:util";
import { formatMigrationStatusReport, getMigrationStatus } from "@llmingress/db";
import { readPostgresDatabaseUrl } from "@llmingress/db/client";

type CliOptions = {
  databaseUrl: string;
};

function readCliOptions(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: { "database-url": { type: "string" } },
    strict: true,
  });
  const databaseUrl = values["database-url"] ?? readPostgresDatabaseUrl({ env });

  return { databaseUrl };
}

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2), process.env);
  const status = await getMigrationStatus({ databaseUrl: options.databaseUrl });
  console.log(formatMigrationStatusReport(status));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

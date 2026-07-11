import { parseArgs } from "node:util";
import { formatMigrationStatusReport, getMigrationStatus } from "@llmingress/db";

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
  const databaseUrl = values["database-url"] ?? env.DATABASE_URL;

  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL or --database-url is required.");
  }

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

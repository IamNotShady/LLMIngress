import { parseArgs } from "node:util";
import { runMigrations } from "@llmingress/db";

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

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2), process.env);
  const result = await runMigrations({ databaseUrl: options.databaseUrl });

  console.log(
    `Applied ${result.applied.length} ${pluralize(result.applied.length, "migration")}; ` +
      `skipped ${result.skipped.length}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

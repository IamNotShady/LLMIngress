import { formatMigrationStatusReport, getMigrationStatus } from "@llmingress/db";

type CliOptions = {
  databaseUrl: string;
};

function readCliOptions(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const databaseUrl = readFlagValue(args, "--database-url") ?? env.DATABASE_URL;

  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL or --database-url is required.");
  }

  return { databaseUrl };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
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

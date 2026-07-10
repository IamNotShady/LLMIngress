import {
  buildBackupOutputPath,
  createBackupArtifact,
  readBackupSettings,
} from "@llmingress/worker-runtime/worker-backup";

type BackupCliOptions = {
  databaseUrl: string;
  mode: "manual" | "pre_migration" | "scheduled";
  outputPath: string;
};

function readCliOptions(args: string[], env: NodeJS.ProcessEnv): BackupCliOptions {
  const databaseUrl = readFlagValue(args, "--database-url") ?? env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL or --database-url is required.");
  }

  const now = new Date();
  const mode = readBackupMode(readFlagValue(args, "--mode") ?? "pre_migration");
  const outputPath =
    readFlagValue(args, "--output-path") ??
    buildBackupOutputPath(readBackupSettings(env).outputDir, mode, now);

  return {
    databaseUrl,
    mode,
    outputPath,
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function readBackupMode(value: string): BackupCliOptions["mode"] {
  if (value === "manual" || value === "pre_migration" || value === "scheduled") {
    return value;
  }
  throw new Error("--mode must be manual, scheduled, or pre_migration.");
}

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2), process.env);
  const result = await createBackupArtifact(options);

  console.log(
    `Backup artifact written to ${result.outputPath}: ` +
      `${result.rowCount} row(s), ${result.tableCount} table(s), ` +
      `${result.skippedTableCount} skipped table(s).`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

import { readFileSync } from "node:fs";

type BootstrapEnvironment = Record<string, string | undefined>;

type BootstrapConfigFile = {
  gatewayPort?: number;
  consolePort?: number;
  workerHeartbeatMs?: number;
  databaseUrl?: string;
  masterKey?: string;
  masterKeyFile?: string;
};

type LoadBootstrapRuntimeConfigOptions = {
  env?: BootstrapEnvironment;
  configFilePath?: string;
};

export type MasterKeySource =
  | {
      kind: "inline";
      value: string;
    }
  | {
      kind: "file";
      path: string;
    };

export type BootstrapRuntimeConfig = {
  gatewayPort: number;
  consolePort: number;
  workerHeartbeatMs: number;
  databaseUrl: string;
  masterKeySource: MasterKeySource;
};

export function loadBootstrapRuntimeConfig(
  options: LoadBootstrapRuntimeConfigOptions = {},
): BootstrapRuntimeConfig {
  const env = options.env ?? process.env;
  const configFilePath = options.configFilePath ?? env.LLMINGRESS_BOOTSTRAP_CONFIG;
  const fileConfig = configFilePath ? readBootstrapConfigFile(configFilePath) : {};

  return {
    gatewayPort: readPort("GATEWAY_PORT", env.GATEWAY_PORT, fileConfig.gatewayPort, 4000),
    consolePort: readPort("CONSOLE_PORT", env.CONSOLE_PORT, fileConfig.consolePort, 3000),
    workerHeartbeatMs: readPositiveInteger(
      "WORKER_HEARTBEAT_MS",
      env.WORKER_HEARTBEAT_MS,
      fileConfig.workerHeartbeatMs,
      30_000,
    ),
    databaseUrl: readDatabaseUrl(env.DATABASE_URL ?? fileConfig.databaseUrl),
    masterKeySource: readMasterKeySource(env, fileConfig),
  };
}

function readBootstrapConfigFile(path: string): BootstrapConfigFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BootstrapConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LLMINGRESS_BOOTSTRAP_CONFIG could not be read: ${message}`);
  }
}

function readPort(
  name: string,
  envValue: string | undefined,
  fileValue: unknown,
  fallback: number,
): number {
  const value = readPositiveInteger(name, envValue, fileValue, fallback);
  if (value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}

function readPositiveInteger(
  name: string,
  envValue: string | undefined,
  fileValue: unknown,
  fallback: number,
): number {
  const rawValue = envValue ?? fileValue ?? fallback;
  const value =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
        ? Number(rawValue)
        : Number.NaN;

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readDatabaseUrl(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("DATABASE_URL is required.");
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error("protocol must be postgresql:");
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DATABASE_URL is invalid: ${message}`);
  }
}

function readMasterKeySource(
  env: BootstrapEnvironment,
  fileConfig: BootstrapConfigFile,
): MasterKeySource {
  const inlineKey = env.MASTER_KEY ?? fileConfig.masterKey;
  if (inlineKey?.trim()) {
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.MASTER_KEY_FILE ?? fileConfig.masterKeyFile;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required.");
}

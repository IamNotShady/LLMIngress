import { readFileSync } from "node:fs";
import { z } from "zod";

type BootstrapEnvironment = Record<string, string | undefined>;

const bootstrapConfigFileSchema = z.object({
  consolePort: portLikeValue("consolePort"),
  databaseUrl: optionalStringField("databaseUrl"),
  gatewayPort: portLikeValue("gatewayPort"),
  masterKey: optionalStringField("masterKey"),
  masterKeyFile: optionalStringField("masterKeyFile"),
  workerHeartbeatMs: portLikeValue("workerHeartbeatMs"),
});

export type BootstrapConfigFile = z.infer<typeof bootstrapConfigFileSchema>;

const bootstrapDatabaseUrlConfigFileSchema = z.object({
  databaseUrl: optionalStringField("databaseUrl"),
});

export type BootstrapDatabaseUrlConfigFile = z.infer<typeof bootstrapDatabaseUrlConfigFileSchema>;

function portLikeValue(name: string) {
  return z
    .custom<number | string>((value) => typeof value === "number" || typeof value === "string", {
      message: `${name} must be a number or numeric string.`,
    })
    .optional();
}

function optionalStringField(name: string) {
  return z
    .custom<string>((value) => typeof value === "string", { message: `${name} must be a string.` })
    .optional();
}

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
  masterKeySource: MasterKeySource;
  securityWarnings: string[];
};

export type ConsoleSetupMode =
  | { kind: "locked" }
  | { kind: "password_only" }
  | { kind: "token_required"; token: string };

const insecurePublicDefaultMasterKey = "test-master-key-change-me";

export function loadBootstrapRuntimeConfig(
  options: LoadBootstrapRuntimeConfigOptions = {},
): BootstrapRuntimeConfig {
  const env = options.env ?? process.env;
  const configFilePath = options.configFilePath ?? env.LLMINGRESS_BOOTSTRAP_CONFIG;
  const fileConfig = configFilePath ? readBootstrapConfigFile(configFilePath) : {};

  const masterKeySource = readMasterKeySource(env, fileConfig);
  return {
    gatewayPort: readPort("GATEWAY_PORT", env.GATEWAY_PORT, fileConfig.gatewayPort, 4000),
    consolePort: readPort("CONSOLE_PORT", env.CONSOLE_PORT, fileConfig.consolePort, 3000),
    workerHeartbeatMs: readPositiveInteger(
      "WORKER_HEARTBEAT_MS",
      env.WORKER_HEARTBEAT_MS,
      fileConfig.workerHeartbeatMs,
      30_000,
    ),
    masterKeySource,
    securityWarnings: readBootstrapSecurityWarnings(env, masterKeySource),
  };
}

export function readBootstrapConfigFile(path: string): BootstrapConfigFile {
  try {
    const parsed = bootstrapConfigFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "bootstrap config file is invalid");
    }
    return parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LLMINGRESS_BOOTSTRAP_CONFIG could not be read: ${message}`);
  }
}

export function readBootstrapDatabaseUrlConfigFile(path: string): BootstrapDatabaseUrlConfigFile {
  try {
    const parsed = bootstrapDatabaseUrlConfigFileSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "bootstrap databaseUrl is invalid");
    }
    return parsed.data;
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

function readMasterKeySource(
  env: BootstrapEnvironment,
  fileConfig: BootstrapConfigFile,
): MasterKeySource {
  const inlineKey = env.MASTER_KEY ?? fileConfig.masterKey;
  if (inlineKey?.trim()) {
    assertMasterKeySafeForRuntime(env, inlineKey);
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.MASTER_KEY_FILE ?? fileConfig.masterKeyFile;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required.");
}

function assertMasterKeySafeForRuntime(env: BootstrapEnvironment, inlineKey: string): void {
  if (env.NODE_ENV !== "production" || inlineKey !== insecurePublicDefaultMasterKey) {
    return;
  }
  if (env.LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY === "true") {
    return;
  }
  throw new Error(
    "Production startup refused the public default MASTER_KEY. Generate a URL-safe random MASTER_KEY or set LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY=true temporarily to acknowledge the risk.",
  );
}

function readBootstrapSecurityWarnings(
  env: BootstrapEnvironment,
  masterKeySource: MasterKeySource,
): string[] {
  if (
    env.NODE_ENV === "production" &&
    masterKeySource.kind === "inline" &&
    masterKeySource.value === insecurePublicDefaultMasterKey &&
    env.LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY === "true"
  ) {
    return [
      "HIGH PRIORITY: production is using the public default MASTER_KEY through LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY.",
    ];
  }
  return [];
}

export function gatewayPublicBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

export function consolePublicBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env.CONSOLE_PUBLIC_BASE_URL?.trim();
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CONSOLE_PUBLIC_BASE_URL must be an absolute URL origin: ${message}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CONSOLE_PUBLIC_BASE_URL must use http or https.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CONSOLE_PUBLIC_BASE_URL must be an origin without path, query, or hash.");
  }

  return url.origin;
}

export function readConsoleListenHost(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CONSOLE_HOST?.trim() || "127.0.0.1";
}

export function readConsoleSetupMode(
  env: Record<string, string | undefined> = process.env,
): ConsoleSetupMode {
  const setupToken = readConsoleSetupToken(env);
  if (setupToken) {
    return { kind: "token_required", token: setupToken };
  }
  if (isLoopbackHost(readConsoleListenHost(env))) {
    return { kind: "password_only" };
  }
  return { kind: "locked" };
}

export function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

function readConsoleSetupToken(env: Record<string, string | undefined>): string | null {
  const value = env.CONSOLE_SETUP_TOKEN?.trim();
  if (!value) {
    return null;
  }
  if (value.length < 32) {
    throw new Error("CONSOLE_SETUP_TOKEN must be at least 32 characters.");
  }
  return value;
}

export type ConsoleOriginValidationInput = {
  configuredOrigin?: string | null;
  method: string;
  originHeader?: string | null;
  requestUrl: string;
};

export type ConsoleOriginValidationResult =
  | { ok: true }
  | {
      code: "csrf_origin_mismatch";
      error: "Request origin is not allowed.";
      ok: false;
    };

export function validateConsoleOrigin(
  input: ConsoleOriginValidationInput,
): ConsoleOriginValidationResult {
  if (input.method === "GET" || input.method === "HEAD" || input.method === "OPTIONS") {
    return { ok: true };
  }

  const origin = input.originHeader;
  if (!origin || origin === "null") {
    return csrfOriginMismatch();
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return csrfOriginMismatch();
  }

  if (parsedOrigin.origin !== origin) {
    return csrfOriginMismatch();
  }

  const expectedOrigin = input.configuredOrigin ?? new URL(input.requestUrl).origin;
  if (origin !== expectedOrigin) {
    return csrfOriginMismatch();
  }

  return { ok: true };
}

function csrfOriginMismatch(): ConsoleOriginValidationResult {
  return {
    code: "csrf_origin_mismatch",
    error: "Request origin is not allowed.",
    ok: false,
  };
}

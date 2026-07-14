import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

type RuntimeOptions = {
  backupRetention: number;
  bindAddress: string;
  consoleOrigin: string;
  consolePort: number;
  gatewayPort: number;
  gatewayUrl: string;
  instance: string;
  postgresUid: number;
  stateDirectory: string;
};

const command = process.argv[2];

try {
  if (command === "configure") {
    configure(readRuntimeOptions(process.argv.slice(3)));
  } else if (command === "prepare") {
    prepare(process.argv.slice(3));
  } else if (command === "commit") {
    commit(process.argv.slice(3));
  } else if (command === "rollback") {
    rollback(readStateDirectory(process.argv.slice(3)));
  } else if (command === "clear") {
    clearTransaction(readStateDirectory(process.argv.slice(3)));
  } else {
    throw new Error("init requires configure, prepare, commit, rollback, or clear");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function configure(options: RuntimeOptions): void {
  mkdirSync(options.stateDirectory, { mode: 0o700, recursive: true });
  const postgresPasswordPath = join(options.stateDirectory, "postgres-password");
  const masterKeyPath = join(options.stateDirectory, "master-key");
  if (!existsSync(postgresPasswordPath)) {
    writeProtectedFile(postgresPasswordPath, randomBytes(32).toString("base64url"), options.postgresUid);
  }
  if (!existsSync(masterKeyPath)) {
    writeProtectedFile(masterKeyPath, randomBytes(32).toString("base64url"), 1001);
  }
  writeBootstrapConfig(options, readFileSync(postgresPasswordPath, "utf8").trim());
}

function prepare(args: string[]): void {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "app-image": { type: "string" },
      "backup-file": { type: "string" },
      "backup-retention": { type: "string" },
      "bind-address": { type: "string" },
      "console-origin": { type: "string" },
      "console-port": { type: "string" },
      "gateway-port": { type: "string" },
      "gateway-url": { type: "string" },
      instance: { type: "string" },
      "postgres-image": { type: "string" },
      "postgres-uid": { type: "string" },
      "state-directory": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  const runtime = validateRuntimeValues(values);
  const transactionDirectory = join(runtime.stateDirectory, "transaction");
  if (existsSync(transactionDirectory)) {
    throw new Error("an upgrade transaction is already active");
  }
  mkdirSync(transactionDirectory, { mode: 0o700 });
  for (const filename of ["bootstrap.json", "install-state.env"]) {
    const source = join(runtime.stateDirectory, filename);
    if (existsSync(source)) {
      copyFileSync(source, join(transactionDirectory, filename));
    }
  }
  const oldState = readStateFile(join(runtime.stateDirectory, "install-state.env"));
  writeEnvFile(join(transactionDirectory, "journal.env"), {
    BACKUP_FILE: validateBackupFile(values["backup-file"] ?? ""),
    OLD_APP_IMAGE: validateImage(oldState.APP_IMAGE, "old app image"),
    OLD_POSTGRES_IMAGE: validateImage(oldState.POSTGRES_IMAGE, "old postgres image"),
    OLD_VERSION: validateVersion(oldState.INSTALLED_VERSION),
    TARGET_APP_IMAGE: validateImage(values["app-image"], "target app image"),
    TARGET_VERSION: validateVersion(values.version),
  });
  configure(runtime);
}

function commit(args: string[]): void {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "app-image": { type: "string" },
      "backup-retention": { type: "string" },
      "bind-address": { type: "string" },
      "console-origin": { type: "string" },
      "console-port": { type: "string" },
      "gateway-port": { type: "string" },
      "gateway-url": { type: "string" },
      instance: { type: "string" },
      "postgres-image": { type: "string" },
      "state-directory": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  const runtime = validateRuntimeValues({ ...values, "postgres-uid": "1" });
  writeEnvFile(join(runtime.stateDirectory, "install-state.env"), {
    APP_IMAGE: validateImage(values["app-image"], "app image"),
    BACKUP_RETENTION: String(runtime.backupRetention),
    BIND_ADDRESS: runtime.bindAddress,
    CONSOLE_ORIGIN: runtime.consoleOrigin,
    CONSOLE_PORT: String(runtime.consolePort),
    GATEWAY_PORT: String(runtime.gatewayPort),
    GATEWAY_URL: runtime.gatewayUrl,
    INSTALLED_VERSION: validateVersion(values.version),
    INSTANCE: runtime.instance,
    POSTGRES_IMAGE: validateImage(values["postgres-image"], "postgres image"),
    SCHEMA_VERSION: "1",
  });
  rmSync(join(runtime.stateDirectory, "transaction"), { force: true, recursive: true });
}

function rollback(stateDirectory: string): void {
  const transactionDirectory = join(stateDirectory, "transaction");
  if (!existsSync(transactionDirectory)) {
    return;
  }
  for (const filename of ["bootstrap.json", "install-state.env"]) {
    const source = join(transactionDirectory, filename);
    if (existsSync(source)) {
      copyFileSync(source, join(stateDirectory, filename));
    }
  }
}

function clearTransaction(stateDirectory: string): void {
  rmSync(join(stateDirectory, "transaction"), { force: true, recursive: true });
}

function readRuntimeOptions(args: string[]): RuntimeOptions {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "backup-retention": { type: "string" },
      "bind-address": { type: "string" },
      "console-origin": { type: "string" },
      "console-port": { type: "string" },
      "gateway-port": { type: "string" },
      "gateway-url": { type: "string" },
      instance: { type: "string" },
      "postgres-uid": { type: "string" },
      "state-directory": { type: "string" },
    },
    strict: true,
  });
  return validateRuntimeValues(values);
}

function validateRuntimeValues(values: Record<string, string | undefined>): RuntimeOptions {
  const instance = values.instance ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
    throw new Error("instance must match [a-z0-9][a-z0-9-]{0,31}");
  }
  const bindAddress = values["bind-address"] ?? "";
  if (!isIPv4(bindAddress)) {
    throw new Error("bind-address must be an IPv4 address");
  }
  return {
    backupRetention: readInteger(values["backup-retention"], "backup-retention", 1, 100),
    bindAddress,
    consoleOrigin: validateHttpUrl(values["console-origin"], "console-origin"),
    consolePort: readInteger(values["console-port"], "console-port", 1024, 65_535),
    gatewayPort: readInteger(values["gateway-port"], "gateway-port", 1024, 65_535),
    gatewayUrl: validateHttpUrl(values["gateway-url"], "gateway-url"),
    instance,
    postgresUid: readInteger(values["postgres-uid"], "postgres-uid", 1, 65_535),
    stateDirectory: values["state-directory"] || "/state",
  };
}

function writeBootstrapConfig(options: RuntimeOptions, postgresPassword: string): void {
  const password = encodeURIComponent(postgresPassword);
  const content = `${JSON.stringify(
    {
      consolePort: options.consolePort,
      databaseUrl: `postgresql://postgres:${password}@postgres:5432/llmingress`,
      gatewayPort: options.gatewayPort,
      masterKeyFile: "/run/llmingress/master-key",
      workerHeartbeatMs: 30_000,
    },
    null,
    2,
  )}\n`;
  writeProtectedFile(join(options.stateDirectory, "bootstrap.json"), content, 1001);
}

function writeProtectedFile(path: string, value: string, uid: number): void {
  writeAtomic(path, value.endsWith("\n") ? value : `${value}\n`);
  chownSync(path, uid, uid);
  chmodSync(path, 0o400);
}

function writeEnvFile(path: string, values: Record<string, string>): void {
  const content = `${Object.entries(values)
    .map(([key, value]) => `${key}=${validateLineValue(value, key)}`)
    .join("\n")}\n`;
  writeAtomic(path, content);
  chmodSync(path, 0o400);
}

function writeAtomic(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function readStateDirectory(args: string[]): string {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: { "state-directory": { type: "string" } },
    strict: true,
  });
  return values["state-directory"] || "/state";
}

function readStateFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error("installed state is missing");
  }
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) {
          throw new Error("installed state is invalid");
        }
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function readInteger(value: string | undefined, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function validateHttpUrl(value: string | undefined, name: string): string {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an HTTP or HTTPS URL`);
  }
}

function validateVersion(value: string | undefined): string {
  if (!value || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("version must be a v-prefixed semantic version");
  }
  return value;
}

function validateImage(value: string | undefined, name: string): string {
  if (!value || /\s/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateBackupFile(value: string): string {
  if (value && !/^upgrade-v[0-9A-Za-z.-]+-[0-9]{8}T[0-9]{6}Z\.dump$/.test(value)) {
    throw new Error("backup file is invalid");
  }
  return value;
}

function validateLineValue(value: string, name: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} contains a newline`);
  }
  return value;
}

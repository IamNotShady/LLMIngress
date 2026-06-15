import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Environment = Record<string, string | undefined>;

export type LoadedEnvFile = {
  name: string;
  path: string;
};

type LoadEnvFilesOptions = {
  cwd?: string;
  env?: Environment;
  fileNames?: string[];
};

export function loadEnvFiles(
  options: LoadEnvFilesOptions = {},
): { loadedFiles: LoadedEnvFile[]; loadedValues: Record<string, string> } {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fileNames = options.fileNames ?? [".env", ".env.local"];
  const shellDefinedKeys = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  );
  const loadedFiles: LoadedEnvFile[] = [];
  const loadedValues: Record<string, string> = {};

  for (const name of fileNames) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (!shellDefinedKeys.has(key)) {
        env[key] = value;
        loadedValues[key] = value;
      }
    }
    loadedFiles.push({ name, path });
  }

  return { loadedFiles, loadedValues };
}

export function formatShellExports(values: Record<string, string>): string {
  const lines = Object.entries(values).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`,
  );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const [, key, rawValue = ""] = match;
    values[key] = readEnvValue(rawValue.trim());
  }

  return values;
}

function readEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const unquoted = value.slice(1, -1);
    return value.startsWith('"') ? unescapeDoubleQuotedValue(unquoted) : unquoted;
  }

  return stripInlineComment(value).trim();
}

function stripInlineComment(value: string): string {
  const markerIndex = value.search(/\s#/);
  return markerIndex === -1 ? value : value.slice(0, markerIndex);
}

function unescapeDoubleQuotedValue(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

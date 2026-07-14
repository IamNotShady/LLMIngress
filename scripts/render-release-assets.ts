import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      "allow-local-images": { type: "boolean", default: false },
      "app-image": { type: "string" },
      "output-directory": { type: "string", default: "dist/release" },
      "postgres-image": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });

  const version = requireValue(values.version, "--version");
  const appImage = requireValue(values["app-image"], "--app-image");
  const postgresImage = requireValue(values["postgres-image"], "--postgres-image");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version must be a v-prefixed semantic version");
  }
  if (!values["allow-local-images"]) {
    assertDigestImage(appImage, "--app-image");
    assertDigestImage(postgresImage, "--postgres-image");
  }
  if (!postgresImage.startsWith("postgres:18.4-alpine")) {
    throw new Error("--postgres-image must use postgres:18.4-alpine");
  }

  const outputDirectory = resolve(values["output-directory"] ?? "dist/release");
  const template = await readFile(resolve("scripts/docker/install.sh.template"), "utf8");
  const installer = template
    .replaceAll("@@LLMINGRESS_VERSION@@", version)
    .replaceAll("@@LLMINGRESS_IMAGE@@", appImage)
    .replaceAll("@@POSTGRES_IMAGE@@", postgresImage);
  if (installer.includes("@@")) {
    throw new Error("installer template still contains unresolved placeholders");
  }

  await mkdir(outputDirectory, { recursive: true });
  const installerPath = resolve(outputDirectory, "install.sh");
  await writeFile(installerPath, installer, "utf8");
  chmodSync(installerPath, 0o755);
  await writeFile(
    resolve(outputDirectory, "release-manifest.json"),
    `${JSON.stringify(
      {
        appImage,
        postgresImage,
        schemaVersion: 1,
        version,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const checksum = createHash("sha256").update(installer).digest("hex");
  await writeFile(
    resolve(outputDirectory, "install.sh.sha256"),
    `${checksum}  install.sh\n`,
    "utf8",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertDigestImage(image: string, name: string): void {
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(`${name} must be pinned to a sha256 digest`);
  }
}

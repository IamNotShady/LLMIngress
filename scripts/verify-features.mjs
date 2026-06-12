import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { features } = JSON.parse(readFileSync(resolve(root, "feature_list.json"), "utf8"));

const passing = features.filter((feature) => feature.status === "passing");
const failures = [];

console.log(`Regressing ${passing.length} passing feature(s)...`);

for (const feature of passing) {
  process.stdout.write(`${feature.id} ${feature.name} ... `);
  const startedAt = Date.now();
  const result = spawnSync("bash", ["-c", feature.verification], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.status === 0) {
    console.log(`PASS (${seconds}s)`);
  } else {
    console.log(`FAIL (${seconds}s)`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const tail = output.split("\n").slice(-20).join("\n");
    console.error(`--- ${feature.id} output (last 20 lines) ---\n${tail}\n---`);
    failures.push(feature.id);
  }
}

if (failures.length > 0) {
  console.error(
    `\nRegression FAILED for: ${failures.join(", ")}\n` +
      "Per AGENTS.md, set each failed feature's status to \"failing\" in feature_list.json " +
      "and record the regression failure in its evidence before continuing.",
  );
  process.exit(1);
}

console.log(`\nAll ${passing.length} passing feature(s) re-verified.`);

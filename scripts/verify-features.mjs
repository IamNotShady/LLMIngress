import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unitFilePattern = "tests/features/[A-Za-z0-9_-]+\\.unit\\.test\\.ts";
const e2eFilePattern = "tests/e2e/[A-Za-z0-9_-]+\\.e2e\\.spec\\.ts";
const standardVerificationPattern = new RegExp(
  `^pnpm exec vitest run (?<unitFiles>${unitFilePattern}(?: ${unitFilePattern})*) && ` +
    `pnpm test:e2e (?<e2eFiles>${e2eFilePattern}(?: ${e2eFilePattern})*) --workers=1$`,
);
const featureCommandTimeoutMs = 900_000;
const batchUnitTimeoutMs = 600_000;
const batchE2eTimeoutMs = 1_800_000;

export function parseStandardVerification(verification) {
  const match = standardVerificationPattern.exec(verification);
  if (!match?.groups) {
    return null;
  }

  return {
    e2eFiles: match.groups.e2eFiles.split(" "),
    unitFiles: match.groups.unitFiles.split(" "),
  };
}

export function buildOptimizedPlan(features) {
  const passingFeatures = features.filter((feature) => feature.status === "passing");
  const standardByFeatureId = new Map();
  const unitFiles = [];
  const e2eFiles = [];
  const seenUnitFiles = new Set();
  const seenE2eFiles = new Set();

  for (const feature of passingFeatures) {
    const parsed = parseStandardVerification(feature.verification);
    if (!parsed) {
      throw new Error(
        `Feature ${feature.id} must use the standard unit + E2E verification format.`,
      );
    }

    standardByFeatureId.set(feature.id, parsed);
    for (const unitFile of parsed.unitFiles) {
      if (!seenUnitFiles.has(unitFile)) {
        seenUnitFiles.add(unitFile);
        unitFiles.push(unitFile);
      }
    }
    for (const e2eFile of parsed.e2eFiles) {
      if (!seenE2eFiles.has(e2eFile)) {
        seenE2eFiles.add(e2eFile);
        e2eFiles.push(e2eFile);
      }
    }
  }

  return {
    e2eFiles,
    passingFeatures,
    standardByFeatureId,
    standardFeatures: passingFeatures,
    unitFiles,
  };
}

export function assertOptimizedPlanCoverage(plan, passingFeatures = plan.passingFeatures) {
  const coveredFeatureIds = new Set(plan.standardFeatures.map((feature) => feature.id));
  const missingFeatureIds = passingFeatures
    .filter((feature) => feature.status === "passing")
    .map((feature) => feature.id)
    .filter((id) => !coveredFeatureIds.has(id));

  if (missingFeatureIds.length > 0) {
    throw new Error(
      `Missing optimized coverage for passing feature(s): ${missingFeatureIds.join(", ")}`,
    );
  }
}

export function formatDryRunPlan(plan) {
  const lines = [
    `Optimized feature regression plan: ${plan.passingFeatures.length} passing feature(s).`,
    `Standard feature(s): ${plan.standardFeatures.length}`,
    "Legacy feature(s): 0",
    `Unit batch file(s): ${plan.unitFiles.length}`,
    `E2E batch file(s): ${plan.e2eFiles.length}`,
    "",
  ];

  for (const feature of plan.standardFeatures) {
    const parsed = plan.standardByFeatureId.get(feature.id);
    lines.push(`${feature.id} -> batch unit: ${parsed.unitFiles.join(" ")}`);
    lines.push(`${feature.id} -> batch e2e: ${parsed.e2eFiles.join(" ")}`);
  }

  return lines.join("\n");
}

export function runOptimizedPlan(plan, options = {}) {
  const execute = options.execute ?? ((command, runOptions) => runShellCommand(command, runOptions));
  const print = options.print ?? console.log;
  const timings = [];
  const failures = [];

  print(`Regressing ${plan.passingFeatures.length} passing feature(s) with optimized runner...`);
  print(`Plan: ${plan.standardFeatures.length} standard feature(s), 0 legacy feature(s).`);

  if (plan.unitFiles.length > 0) {
    const unitCommand = `pnpm exec vitest run ${plan.unitFiles.map(shellQuote).join(" ")}`;
    const unitResult = runTimedCommand({
      command: unitCommand,
      execute,
      label: "unit batch",
      print,
      timeoutMs: batchUnitTimeoutMs,
      timings,
    });
    if (unitResult.status !== 0) {
      printCommandTail("unit batch", unitResult.output, print);
      failures.push(
        ...runFallbackFeatureCommands("unit batch", plan.standardFeatures, {
          execute,
          print,
          timings,
        }),
      );
      printSlowTimings(timings, print);
      return { failures: unique(failures), timings };
    }
  }

  if (plan.e2eFiles.length > 0) {
    const e2eCommand = `pnpm test:e2e ${plan.e2eFiles.map(shellQuote).join(" ")} --workers=50%`;
    const e2eResult = runTimedCommand({
      command: e2eCommand,
      execute,
      label: "e2e batch",
      print,
      timeoutMs: batchE2eTimeoutMs,
      timings,
    });
    if (e2eResult.status !== 0) {
      printCommandTail("e2e batch", e2eResult.output, print);
      failures.push(
        ...runFallbackFeatureCommands("e2e batch", plan.standardFeatures, {
          execute,
          print,
          timings,
        }),
      );
    }
  }

  printSlowTimings(timings, print);
  return { failures: unique(failures), timings };
}

export function loadFeatureList(featureListPath = resolve(root, "feature_list.json")) {
  const { features } = JSON.parse(readFileSync(featureListPath, "utf8"));
  return features;
}

export function main(args = process.argv.slice(2), options = {}) {
  const print = options.print ?? console.log;
  const printError = options.printError ?? console.error;
  const features = options.features ?? loadFeatureList();

  try {
    const dryRun = parseArguments(args);
    const plan = buildOptimizedPlan(features);
    assertOptimizedPlanCoverage(plan);

    if (dryRun) {
      print(formatDryRunPlan(plan));
      print("\nStandard verification coverage passed.");
      return 0;
    }

    const result = runOptimizedPlan(plan, {
      execute: options.execute,
      print,
    });
    return finish(result.failures, features, print, printError);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseArguments(args) {
  for (const arg of args) {
    if (arg !== "--dry-run") {
      throw new Error(`Unknown verify-features argument: ${arg}`);
    }
  }
  return args.includes("--dry-run");
}

function runFeatureCommands(features, options) {
  const failures = [];

  for (const feature of features) {
    const result = runTimedCommand({
      command: feature.verification,
      execute: options.execute,
      label: `${feature.id} ${feature.name}`,
      print: options.print,
      timeoutMs: featureCommandTimeoutMs,
      timings: options.timings,
    });
    if (result.status !== 0) {
      printCommandTail(feature.id, result.output, options.print);
      failures.push(feature.id);
    }
  }

  return failures;
}

function runFallbackFeatureCommands(reason, features, options) {
  options.print(`Falling back to per-feature verification after ${reason} failure...`);
  return runFeatureCommands(features, options);
}

function runTimedCommand({ command, execute, label, print, timeoutMs, timings }) {
  const startedAt = Date.now();
  const result = execute(command, { label, timeoutMs });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const status = result.status ?? 1;

  timings.push({ label, seconds: Number(seconds) });
  print(`${label} ... ${status === 0 ? "PASS" : "FAIL"} (${seconds}s)`);

  return { output: result.output ?? "", status };
}

function runShellCommand(command, options = {}) {
  const result = spawnSync("bash", ["-c", command], {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeoutMs ?? featureCommandTimeoutMs,
  });

  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    status: result.status ?? 1,
  };
}

function printCommandTail(label, output, print) {
  const tailLineCount = 80;
  const tail = output.trim().split("\n").slice(-tailLineCount).join("\n");
  print(`--- ${label} output (last ${tailLineCount} lines) ---\n${tail}\n---`);
}

function printSlowTimings(timings, print) {
  if (timings.length === 0) {
    return;
  }

  print("\nSlowest feature verification stages:");
  for (const timing of [...timings].sort((left, right) => right.seconds - left.seconds).slice(0, 10)) {
    print(`- ${timing.label}: ${timing.seconds.toFixed(1)}s`);
  }
}

function finish(failures, features, print, printError) {
  const uniqueFailures = unique(failures);
  if (uniqueFailures.length > 0) {
    printError(
      `\nRegression FAILED for: ${uniqueFailures.join(", ")}\n` +
        'Per AGENTS.md, set each failed feature\'s status to "failing" in feature_list.json ' +
        "and record the regression failure in its evidence before continuing.",
    );
    return 1;
  }

  const passingCount = features.filter((feature) => feature.status === "passing").length;
  print(`\nAll ${passingCount} passing feature(s) re-verified.`);
  return 0;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function unique(values) {
  return [...new Set(values)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

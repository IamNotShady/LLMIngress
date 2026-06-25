import { EventEmitter } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachConsoleChildLifecycle } from "../../apps/console/src/main";
import { readConsolePort, shouldClearConsoleNextArtifacts } from "../../scripts/run-with-env";
import {
  assertOptimizedPlanCoverage,
  buildOptimizedPlan,
  formatDryRunPlan,
  parseStandardVerification,
  runOptimizedPlan,
} from "../../scripts/verify-features.mjs";
import { withProcessLock } from "../support/process-lock";

const standardVerification =
  "pnpm exec vitest run tests/features/feat-999-example.unit.test.ts && pnpm test:e2e tests/e2e/feat-999-example.e2e.spec.ts --grep 'example behavior'";

const standardFeature = {
  description: "standard",
  evidence: "",
  id: "feat-999",
  name: "Standard Feature",
  status: "passing",
  verification: standardVerification,
};

const legacyFeature = {
  description: "legacy",
  evidence: "",
  id: "feat-998",
  name: "Legacy Feature",
  status: "passing",
  verification:
    "bash -lc 'test -n \"$TEST_DATABASE_URL\"' && pnpm exec vitest run tests/features/feat-998-example.unit.test.ts",
};

describe("feat-060 optimized feature verification runner", () => {
  it("parses the standard unit plus e2e verification shape", () => {
    expect(parseStandardVerification(standardVerification)).toEqual({
      e2eFile: "tests/e2e/feat-999-example.e2e.spec.ts",
      grep: "example behavior",
      unitFile: "tests/features/feat-999-example.unit.test.ts",
    });
  });

  it("keeps non-standard verification commands in the legacy bucket", () => {
    const plan = buildOptimizedPlan([standardFeature, legacyFeature]);

    expect(plan.standardFeatures.map((feature) => feature.id)).toEqual(["feat-999"]);
    expect(plan.legacyFeatures.map((feature) => feature.id)).toEqual(["feat-998"]);
    expect(plan.unitFiles).toEqual(["tests/features/feat-999-example.unit.test.ts"]);
    expect(plan.e2eFiles).toEqual(["tests/e2e/feat-999-example.e2e.spec.ts"]);
  });

  it("prints a dry-run coverage map without executing commands", () => {
    const plan = buildOptimizedPlan([standardFeature, legacyFeature]);

    expect(formatDryRunPlan(plan)).toContain(
      "feat-999 -> batch unit: tests/features/feat-999-example.unit.test.ts",
    );
    expect(formatDryRunPlan(plan)).toContain("feat-998 -> legacy:");
  });

  it("fails compare coverage when any passing feature is missing", () => {
    const plan = buildOptimizedPlan([standardFeature]);

    expect(() => assertOptimizedPlanCoverage(plan, [standardFeature, legacyFeature])).toThrow(
      /Missing optimized coverage for passing feature\(s\): feat-998/,
    );
  });

  it("falls back to original feature verification when a batch fails", () => {
    const plan = buildOptimizedPlan([standardFeature]);
    const executed: string[] = [];
    const result = runOptimizedPlan(plan, {
      execute: (command) => {
        executed.push(command);
        return command.includes("vitest run tests/features/feat-999-example.unit.test.ts")
          ? { output: "unit failed", status: 1 }
          : { output: "", status: 0 };
      },
      print: () => undefined,
      root: process.cwd(),
    });

    expect(executed).toEqual([
      "pnpm exec vitest run tests/features/feat-999-example.unit.test.ts",
      standardVerification,
    ]);
    expect(result.failures).toEqual(["feat-999"]);
  });

  it("does not keep a batch failure when fallback feature verification passes", () => {
    const plan = buildOptimizedPlan([standardFeature]);
    const executed: string[] = [];
    const result = runOptimizedPlan(plan, {
      execute: (command) => {
        executed.push(command);
        if (command === "pnpm test:e2e tests/e2e/feat-999-example.e2e.spec.ts --workers=1") {
          return { output: "batch-only e2e failure", status: 1 };
        }
        return { output: "", status: 0 };
      },
      print: () => undefined,
      root: process.cwd(),
    });

    expect(executed).toEqual([
      "pnpm exec vitest run tests/features/feat-999-example.unit.test.ts",
      "pnpm test:e2e tests/e2e/feat-999-example.e2e.spec.ts --workers=1",
      standardVerification,
    ]);
    expect(result.failures).toEqual([]);
  });
});

describe("feat-060 e2e cache cleanup guard", () => {
  it("does not clear the Console Next cache while the live Console port is occupied", () => {
    expect(
      shouldClearConsoleNextArtifacts({
        args: ["test"],
        command: "playwright",
        consolePortListening: true,
      }),
    ).toBe(false);
    expect(
      shouldClearConsoleNextArtifacts({
        args: ["test"],
        command: "playwright",
        consolePortListening: false,
      }),
    ).toBe(true);
  });

  it("uses CONSOLE_PORT when checking for a live Console server", () => {
    expect(readConsolePort({ CONSOLE_PORT: "3111" })).toBe(3111);
    expect(readConsolePort({ CONSOLE_PORT: "not-a-port" })).toBe(3000);
  });
});

describe("feat-060 process lock stale owner handling", () => {
  const createdLockNames: string[] = [];

  afterEach(async () => {
    for (const lockName of createdLockNames.splice(0)) {
      await rm(join(tmpdir(), `${lockName}.lock`), { force: true });
    }
  });

  it("removes a stale PID lock and enters the critical section", async () => {
    const lockName = `llmingress-stale-${Date.now()}`;
    createdLockNames.push(lockName);
    await writeFile(join(tmpdir(), `${lockName}.lock`), "99999999");

    await expect(withProcessLock(lockName, async () => "entered", 200)).resolves.toBe("entered");
  });

  it("does not remove a lock owned by a live process", async () => {
    const lockName = `llmingress-live-${Date.now()}`;
    createdLockNames.push(lockName);
    await writeFile(join(tmpdir(), `${lockName}.lock`), String(process.pid));

    await expect(withProcessLock(lockName, async () => "entered", 20)).rejects.toThrow(
      /Timed out waiting for process lock/,
    );
  });

  it("reports malformed lock files instead of silently waiting", async () => {
    const lockName = `malformed-${Date.now()}`;
    createdLockNames.push(lockName);
    await writeFile(join(tmpdir(), `${lockName}.lock`), "not-a-pid");

    await expect(withProcessLock(lockName, async () => "entered", 200)).rejects.toThrow(
      /Malformed process lock/,
    );
  });

  it("keeps the lock through a post-operation settle window", async () => {
    const lockName = `llmingress-settle-${Date.now()}`;
    createdLockNames.push(lockName);
    const firstStartedAt = Date.now();
    const first = withProcessLock(lockName, async () => "first", 1_000, 80);
    await sleep(10);

    await Promise.all([
      first,
      withProcessLock(
        lockName,
        async () => {
          return Date.now() - firstStartedAt;
        },
        1_000,
        0,
      ),
    ]).then(([, secondEnteredAfterMs]) => {
      expect(secondEnteredAfterMs).toBeGreaterThanOrEqual(70);
    });
  });
});

describe("feat-060 console wrapper shutdown", () => {
  it("forwards parent SIGTERM to the child and exits after the child exits", () => {
    const child = new FakeChildProcess();
    const runtime = new FakeConsoleRuntime();

    attachConsoleChildLifecycle(child, runtime);
    runtime.emit("SIGTERM");

    expect(child.killCalls).toEqual(["SIGTERM"]);
    expect(runtime.exitCodes).toEqual([]);

    child.emit("exit", null, "SIGTERM");

    expect(runtime.exitCodes).toEqual([143]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeChildProcess extends EventEmitter {
  readonly killCalls: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

class FakeConsoleRuntime extends EventEmitter {
  readonly exitCodes: number[] = [];
  readonly selfSignals: NodeJS.Signals[] = [];

  exit(code: number): void {
    this.exitCodes.push(code);
  }

  killSelf(signal: NodeJS.Signals): void {
    this.selfSignals.push(signal);
  }
}

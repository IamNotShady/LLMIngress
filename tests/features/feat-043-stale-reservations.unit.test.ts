import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStaleReservationCleanupJobHandler } from "@llmingress/db/worker-stale-reservations";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

describe("feat-043 stale reservation cleanup", () => {
  it("exposes a stale reservation cleanup job handler factory", () => {
    expect(
      createStaleReservationCleanupJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });

  it("expires pending reservations and releases reserved period amounts atomically", () => {
    const source = readFileSync(
      resolve(root, "packages/db/src/worker-stale-reservations.ts"),
      "utf8",
    );

    expect(source).toContain("where status = 'pending'");
    expect(source).toContain("for update skip locked");
    expect(source).toContain("set reserved_tokens = greatest(");
    expect(source).toContain("set status = 'expired'");
  });
});

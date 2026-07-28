import { describe, expect, it } from "vitest";
import { axisLabelsForWindow } from "../../apps/console/src/app/_ui/usage/axis.ts";

const bucketsFrom = (start: string, count: number, stepMs: number) =>
  Array.from({ length: count }, (_, index) => ({
    bucketStart: new Date(new Date(start).getTime() + index * stepMs),
    costUsd: "0",
    failedCount: 0,
    requestCount: 0,
    succeededCount: 0,
    totalTokens: 0,
  }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date("2026-07-26T09:00:00.000Z");

describe("usage chart axis", () => {
  it("never labels the same bucket twice when the trend is shorter than the axis", () => {
    // A console that has served for three hours has three buckets; spacing five
    // labels across them landed on the same bucket twice, and React saw two
    // children keyed "06:00".
    for (const count of [1, 2, 3, 4]) {
      const labels = axisLabelsForWindow(
        "24h",
        bucketsFrom("2026-07-26T06:00:00.000Z", count, HOUR),
        now,
      );
      expect(labels, `${count} buckets`).toHaveLength(count);
      expect(new Set(labels).size, `${count} buckets`).toBe(count);
    }
  });

  it("spans the whole trend with five labels once there are enough buckets", () => {
    const labels = axisLabelsForWindow(
      "24h",
      bucketsFrom("2026-07-26T00:00:00.000Z", 24, HOUR),
      now,
    );
    // The first and last bucket, with three evenly spaced between them.
    expect(labels).toEqual(["00:00", "06:00", "12:00", "17:00", "23:00"]);
  });

  it("labels days beyond the 24h window, and nothing at all without a trend", () => {
    expect(axisLabelsForWindow("7d", bucketsFrom("2026-07-20T00:00:00.000Z", 7, DAY), now)).toEqual(
      ["07-20", "07-22", "07-23", "07-25", "07-26"],
    );
    expect(axisLabelsForWindow("30d", [], now)).toEqual([]);
  });
});

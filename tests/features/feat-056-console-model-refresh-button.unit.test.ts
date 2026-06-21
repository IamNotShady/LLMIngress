import { describe, expect, it } from "vitest";
import {
  buildJobCreatedNotificationPayload,
  buildModelRefreshJobPayload,
  normalizeProviderModelRefreshInput,
} from "../../packages/db/src/provider-jobs";

describe("feat-056 Console provider model refresh button", () => {
  it("normalizes provider refresh form input for a model_refresh job", () => {
    expect(normalizeProviderModelRefreshInput({ providerId: " provider-123 " })).toEqual({
      providerId: "provider-123",
    });
  });

  it("rejects missing provider ids before enqueueing a model_refresh job", () => {
    expect(() => normalizeProviderModelRefreshInput({ providerId: "" })).toThrow(/provider id/i);
  });

  it("builds stable job payloads and wake notifications", () => {
    expect(buildModelRefreshJobPayload("provider-123")).toEqual({
      providerId: "provider-123",
    });
    expect(buildJobCreatedNotificationPayload("job-123")).toEqual({
      jobId: "job-123",
    });
  });
});

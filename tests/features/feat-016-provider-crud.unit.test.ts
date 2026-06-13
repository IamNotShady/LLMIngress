import { describe, expect, it } from "vitest";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-016 provider CRUD and enablement", () => {
  it("normalizes provider form input for persistence", () => {
    expect(
      normalizeProviderFormInput({
        baseUrl: " https://api.openai.com/v1 ",
        displayName: " OpenAI API ",
        providerKey: " OpenAI ",
        providerType: "api_key",
      }),
    ).toEqual({
      baseUrl: "https://api.openai.com/v1",
      displayName: "OpenAI API",
      providerKey: "openai",
      providerType: "api_key",
    });
  });

  it("rejects empty provider keys and unsupported provider types", () => {
    expect(() =>
      normalizeProviderFormInput({
        displayName: "OpenAI",
        providerKey: "",
        providerType: "api_key",
      }),
    ).toThrow(/provider key/i);

    expect(() =>
      normalizeProviderFormInput({
        displayName: "OpenAI",
        providerKey: "openai",
        providerType: "subscription",
      }),
    ).toThrow(/provider type/i);
  });

  it("core provider schema supports listing edit and enablement fields", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0002");

    expect(migration?.sql).toContain("create table if not exists providers");
    expect(migration?.sql).toContain("provider_key text not null unique");
    expect(migration?.sql).toContain("display_name text not null");
    expect(migration?.sql).toContain("base_url text");
    expect(migration?.sql).toContain("enabled boolean not null default true");
  });
});

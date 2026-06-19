import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateAgentApiKeyPlaintext,
  prepareAgentApiKeyForStorage,
} from "../../apps/console/src/server/agents";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-108 agent-owned single API key", () => {
  it("ships baseline schema with the credential on agents and a cleanup migration for old key tables", () => {
    const baseline = loadSqlMigrations().find(
      (candidate) => candidate.id === "0002" && candidate.name === "core_config_schema",
    );
    const cleanup = loadSqlMigrations().find(
      (candidate) => candidate.id === "0032" && candidate.name === "agent_owned_api_key",
    );

    expect(baseline?.sql).toContain("create table if not exists agents");
    expect(baseline?.sql).toContain("key_prefix text unique");
    expect(baseline?.sql).toContain("key_hash text unique");
    expect(baseline?.sql).toContain(
      "default_virtual_model_id uuid references virtual_models (id) on delete restrict",
    );
    expect(baseline?.sql).toContain("create table if not exists agent_virtual_models");
    expect(baseline?.sql).toContain("agent_id uuid not null references agents (id)");
    expect(baseline?.sql).not.toContain("create table if not exists agent_api_keys");
    expect(cleanup?.sql).toContain("truncate table agents cascade");
    expect(cleanup?.sql).toContain("drop table if exists agent_api_key_virtual_models");
    expect(cleanup?.sql).toContain("drop table if exists agent_api_keys");
    expect(cleanup?.sql).toContain("set version = '0032'");
  });

  it("generates one Agent credential and stores only prefix plus hash", () => {
    const plaintext = generateAgentApiKeyPlaintext();
    const stored = prepareAgentApiKeyForStorage(plaintext);

    expect(plaintext).toMatch(/^llmi_[A-Za-z0-9_-]{32,}$/);
    expect(stored.keyPrefix).toBe(plaintext.slice(0, 12));
    expect(stored.keyHash).toBe(buildGatewayAgentApiKeyHash(plaintext));
    expect(JSON.stringify(stored)).not.toContain(plaintext);
  });

  it("removes Console multi-key lifecycle surfaces for Agents", () => {
    const consoleSections = readFileSync("apps/console/src/app/_modules/sections.tsx", "utf8");
    const importExport = readFileSync("apps/console/src/server/import-export.ts", "utf8");

    expect(existsSync("apps/console/src/server/agent-api-keys.ts")).toBe(false);
    expect(consoleSections).not.toContain("agentApiKeysByAgentId");
    expect(consoleSections).not.toContain("listAgentApiKeyMetadata");
    expect(consoleSections).not.toContain("groupByAgentApiKeyId");
    expect(consoleSections).not.toContain("keys[0]");
    expect(importExport).not.toContain("agentApiKeys");
    expect(importExport).not.toContain("writeAgentApiKeys");
  });
});

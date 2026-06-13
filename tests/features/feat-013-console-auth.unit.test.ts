import { describe, expect, it } from "vitest";
import {
  hashAdminPassword,
  sessionCookieName,
  verifyAdminPassword,
} from "../../apps/console/src/server/auth";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-013 console first run and login", () => {
  it("hashes admin passwords and verifies only the original password", async () => {
    const password = "correct horse battery staple";
    const passwordHash = await hashAdminPassword(password);

    expect(passwordHash).toMatch(/^scrypt:v1:/);
    expect(passwordHash).not.toContain(password);
    await expect(verifyAdminPassword(password, passwordHash)).resolves.toBe(true);
    await expect(verifyAdminPassword("wrong password", passwordHash)).resolves.toBe(false);
  });

  it("stores a singleton admin and hashed expiring sessions", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0004");

    expect(migration?.sql).toContain("create table if not exists console_admins");
    expect(migration?.sql).toContain("id smallint primary key");
    expect(migration?.sql).toContain("check (id = 1)");
    expect(migration?.sql).toContain("password_hash text not null");
    expect(migration?.sql).toContain("create table if not exists console_sessions");
    expect(migration?.sql).toContain("token_hash text not null unique");
    expect(migration?.sql).toContain("expires_at timestamptz not null");
    expect(sessionCookieName).toBe("llmingress_console_session");
  });
});

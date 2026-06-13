import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_CHANGED_CHANNEL, createConfigPublisher } from "../../packages/config/src/index";

describe("feat-011 config publisher", () => {
  it("wraps config writes versioning change events and notify in one transaction", async () => {
    const providerId = randomUUID();
    const connection = createFakeConnection();
    const publisher = createConfigPublisher({
      connect: async () => connection,
    });

    const result = await publisher.publish({
      source: "console",
      description: "Enable OpenAI provider",
      changes: [{ table: "providers", recordId: providerId }],
      write: async (client) => {
        await client.query(
          "insert into providers (id, provider_type, provider_key, display_name) values ($1, $2, $3, $4)",
          [providerId, "api_key", "openai", "OpenAI"],
        );
      },
    });

    expect(result).toMatchObject({
      version: 7,
      configVersionId: "42",
      source: "console",
    });
    expect(result.changes).toEqual([
      expect.objectContaining({
        table: "providers",
        recordId: providerId,
      }),
    ]);
    expect(connection.ended).toBe(true);
    expect(connection.queries.map((query) => query.text)).toEqual([
      "begin",
      "select pg_advisory_xact_lock($1)",
      "insert into providers (id, provider_type, provider_key, display_name) values ($1, $2, $3, $4)",
      "insert into config_versions (version, source, description) select coalesce(max(version), 0) + 1, $1, $2 from config_versions returning id::text, version",
      "insert into config_change_events (id, config_version_id, source, changed_table, changed_record_id) values ($1, $2, $3, $4, $5)",
      "select pg_notify($1, $2)",
      "commit",
    ]);

    const notify = connection.queries.find((query) => query.text === "select pg_notify($1, $2)");
    expect(notify?.values?.[0]).toBe(CONFIG_CHANGED_CHANNEL);
    expect(JSON.parse(String(notify?.values?.[1]))).toMatchObject({
      version: 7,
      configVersionId: "42",
      source: "console",
      changeCount: 1,
    });
  });

  it("rolls back and skips notify when the config write fails", async () => {
    const connection = createFakeConnection();
    const publisher = createConfigPublisher({
      connect: async () => connection,
    });

    await expect(
      publisher.publish({
        source: "worker",
        description: "Broken model refresh",
        changes: [{ table: "provider_models", recordId: randomUUID() }],
        write: async (client) => {
          await client.query("insert into provider_models (id) values ($1)", [randomUUID()]);
          throw new Error("provider write failed");
        },
      }),
    ).rejects.toThrow(/provider write failed/);

    expect(connection.ended).toBe(true);
    expect(connection.queries.map((query) => query.text)).toEqual([
      "begin",
      "select pg_advisory_xact_lock($1)",
      "insert into provider_models (id) values ($1)",
      "rollback",
    ]);
    expect(connection.queries.some((query) => query.text.includes("pg_notify"))).toBe(false);
  });

  it("rejects empty change sets before opening a database connection", async () => {
    const connect = vi.fn();
    const publisher = createConfigPublisher({ connect });

    await expect(
      publisher.publish({
        source: "console",
        description: "No-op",
        changes: [],
        write: async () => {},
      }),
    ).rejects.toThrow(/at least one config change/);
    expect(connect).not.toHaveBeenCalled();
  });
});

type RecordedQuery = {
  text: string;
  values?: readonly unknown[];
};

function createFakeConnection() {
  const queries: RecordedQuery[] = [];

  return {
    ended: false,
    queries,
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text: normalizeSql(text), values });
      if (text.includes("insert into config_versions")) {
        return { rows: [{ id: "42", version: 7 }] };
      }
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type AgentApiKeyMetadata = {
  agentId: string;
  createdAt: Date;
  enabled: boolean;
  id: string;
  keyPrefix: string;
  updatedAt: Date;
};

export type AgentApiKeyStorageRow = QueryResultRow & {
  agent_id: string;
  created_at: Date;
  enabled: boolean;
  id: string;
  key_hash: string;
  key_prefix: string;
  updated_at: Date;
};

export type StoredAgentApiKey = {
  keyHash: string;
  keyPrefix: string;
};

type AgentApiKeySaveResult = {
  action: "created" | "rotated";
  metadata: AgentApiKeyMetadata;
  plaintext: string;
};

type AgentApiKeyRequestCountRow = QueryResultRow & {
  request_count: number;
};

const agentApiKeyPrefixLength = 12;

export function generateAgentApiKeyPlaintext(): string {
  return `llmi_${randomBytes(32).toString("base64url")}`;
}

export function buildAgentApiKeyHash(plaintext: string): string {
  return `sha256:v1:${createHash("sha256")
    .update("llmingress:agent-api-key:v1")
    .update(plaintext)
    .digest("base64url")}`;
}

export function prepareAgentApiKeyForStorage(plaintext: string): StoredAgentApiKey {
  const normalized = normalizeAgentApiKeyPlaintext(plaintext);
  return {
    keyHash: buildAgentApiKeyHash(normalized),
    keyPrefix: normalized.slice(0, agentApiKeyPrefixLength),
  };
}

export function toAgentApiKeyMetadata(row: AgentApiKeyStorageRow): AgentApiKeyMetadata {
  return {
    agentId: row.agent_id,
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    id: row.id,
    keyPrefix: row.key_prefix,
    updatedAt: new Date(row.updated_at),
  };
}

export async function listAgentApiKeyMetadata(databaseUrl: string): Promise<AgentApiKeyMetadata[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<AgentApiKeyStorageRow>(
      `
        select id::text,
               agent_id::text,
               key_prefix,
               key_hash,
               enabled,
               created_at,
               updated_at
        from agent_api_keys
        order by created_at
      `,
    );
    return result.rows.map(toAgentApiKeyMetadata);
  });
}

export async function createAgentApiKey(input: {
  agentId: string;
  databaseUrl: string;
}): Promise<AgentApiKeySaveResult> {
  const plaintext = generateAgentApiKeyPlaintext();
  const stored = prepareAgentApiKeyForStorage(plaintext);
  const keyId = randomUUID();
  let metadata: AgentApiKeyMetadata | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create agent API key ${input.agentId}`,
    changes: [{ table: "agent_api_keys", recordId: keyId }],
    write: async (client) => {
      const result = await client.query<AgentApiKeyStorageRow>(
        `
          insert into agent_api_keys (id, agent_id, key_prefix, key_hash, enabled)
          values ($1, $2, $3, $4, true)
          returning id::text,
                    agent_id::text,
                    key_prefix,
                    key_hash,
                    enabled,
                    created_at,
                    updated_at
        `,
        [keyId, input.agentId, stored.keyPrefix, stored.keyHash],
      );
      metadata = toAgentApiKeyMetadata(requireRow(result.rows[0]));
    },
  });

  return {
    action: "created",
    metadata: requireMetadata(metadata),
    plaintext,
  };
}

export async function rotateAgentApiKey(input: {
  databaseUrl: string;
  id: string;
}): Promise<AgentApiKeySaveResult> {
  const plaintext = generateAgentApiKeyPlaintext();
  const stored = prepareAgentApiKeyForStorage(plaintext);
  let metadata: AgentApiKeyMetadata | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Rotate agent API key ${input.id}`,
    changes: [{ table: "agent_api_keys", recordId: input.id }],
    write: async (client) => {
      const result = await client.query<AgentApiKeyStorageRow>(
        `
          update agent_api_keys
          set key_prefix = $2,
              key_hash = $3,
              enabled = true,
              updated_at = now()
          where id = $1
          returning id::text,
                    agent_id::text,
                    key_prefix,
                    key_hash,
                    enabled,
                    created_at,
                    updated_at
        `,
        [input.id, stored.keyPrefix, stored.keyHash],
      );
      metadata = toAgentApiKeyMetadata(requireRow(result.rows[0]));
    },
  });

  return {
    action: "rotated",
    metadata: requireMetadata(metadata),
    plaintext,
  };
}

export async function disableAgentApiKey(input: {
  databaseUrl: string;
  id: string;
}): Promise<AgentApiKeyMetadata> {
  let metadata: AgentApiKeyMetadata | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Disable agent API key ${input.id}`,
    changes: [{ table: "agent_api_keys", recordId: input.id }],
    write: async (client) => {
      const result = await client.query<AgentApiKeyStorageRow>(
        `
          update agent_api_keys
          set enabled = false,
              updated_at = now()
          where id = $1
          returning id::text,
                    agent_id::text,
                    key_prefix,
                    key_hash,
                    enabled,
                    created_at,
                    updated_at
        `,
        [input.id],
      );
      metadata = toAgentApiKeyMetadata(requireRow(result.rows[0]));
    },
  });

  return requireMetadata(metadata);
}

export async function deleteAgentApiKey(input: { databaseUrl: string; id: string }): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete agent API key ${input.id}`,
    changes: [{ table: "agent_api_keys", recordId: input.id }],
    write: async (client) => {
      await assertAgentApiKeyExists(client, input.id);
      const requestCount = await readRequestAttributionCount(client, input.id);
      if (requestCount > 0) {
        throw new Error("Cannot delete Agent API key with request attribution.");
      }

      const result = await client.query<{ id: string }>(
        "delete from agent_api_keys where id = $1 returning id::text",
        [input.id],
      );
      if (!result.rows[0]) {
        throw new Error("Agent API key was not deleted.");
      }
    },
  });
}

async function assertAgentApiKeyExists(client: QueryClient, id: string): Promise<void> {
  const result = await client.query("select 1 from agent_api_keys where id = $1 for update", [id]);
  if (!result.rows[0]) {
    throw new Error("Agent API key was not found.");
  }
}

async function readRequestAttributionCount(client: QueryClient, id: string): Promise<number> {
  const result = await client.query<AgentApiKeyRequestCountRow>(
    `
      select count(*)::integer as request_count
      from request_activity
      where agent_api_key_id = $1
    `,
    [id],
  );
  return result.rows[0]?.request_count ?? 0;
}

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

function normalizeAgentApiKeyPlaintext(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw new Error("Agent API key plaintext is required.");
  }
  if (plaintext.length <= agentApiKeyPrefixLength) {
    throw new Error("Agent API key must be longer than the stored prefix.");
  }
  return plaintext;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Agent API key was not found.");
  }
  return row;
}

function requireMetadata(metadata: AgentApiKeyMetadata | undefined): AgentApiKeyMetadata {
  if (!metadata) {
    throw new Error("Agent API key metadata was not saved.");
  }
  return metadata;
}

async function withClient<T>(
  databaseUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

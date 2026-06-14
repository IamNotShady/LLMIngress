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

export type AgentApiKeyVirtualModel = {
  displayName: string;
  id: string;
  name: string;
};

export type AgentApiKeyVirtualModelAccess = {
  agentApiKeyId: string;
  allowedVirtualModels: AgentApiKeyVirtualModel[];
  defaultVirtualModel: AgentApiKeyVirtualModel | null;
};

export type AgentApiKeyVirtualModelAccessInput = {
  allowedVirtualModelIds?: readonly (string | null | undefined)[] | string | null;
  defaultVirtualModelId?: string | null;
  id?: string | null;
};

export type NormalizedAgentApiKeyVirtualModelAccessInput = {
  allowedVirtualModelIds: string[];
  defaultVirtualModelId: string | null;
  id: string;
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

type AgentApiKeyVirtualModelAccessBaseRow = QueryResultRow & {
  agent_api_key_id: string;
  default_virtual_model_display_name: string | null;
  default_virtual_model_id: string | null;
  default_virtual_model_name: string | null;
};

type AgentApiKeyAllowedVirtualModelRow = QueryResultRow & {
  agent_api_key_id: string;
  display_name: string;
  id: string;
  name: string;
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

export function normalizeAgentApiKeyVirtualModelAccessInput(
  input: AgentApiKeyVirtualModelAccessInput,
): NormalizedAgentApiKeyVirtualModelAccessInput {
  const id = normalizeRequiredText(input.id, "Agent API key id");
  const allowedVirtualModelIds = Array.from(
    new Set(normalizeTextList(input.allowedVirtualModelIds)),
  );
  const defaultVirtualModelId = normalizeOptionalText(input.defaultVirtualModelId);

  assertDefaultVirtualModelIsAllowed({ allowedVirtualModelIds, defaultVirtualModelId });

  return {
    allowedVirtualModelIds,
    defaultVirtualModelId,
    id,
  };
}

export function formatAgentApiKeyVirtualModelAccess(input: {
  allowedVirtualModels: AgentApiKeyVirtualModel[];
  defaultVirtualModel: AgentApiKeyVirtualModel | null;
}): { allowedLabel: string; defaultLabel: string } {
  return {
    allowedLabel:
      input.allowedVirtualModels.length === 0
        ? "None"
        : input.allowedVirtualModels.map(formatVirtualModelLabel).join(", "),
    defaultLabel: input.defaultVirtualModel
      ? formatVirtualModelLabel(input.defaultVirtualModel)
      : "None",
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

export async function listAgentApiKeyVirtualModelAccess(
  databaseUrl: string,
): Promise<AgentApiKeyVirtualModelAccess[]> {
  return withClient(databaseUrl, async (client) => readAgentApiKeyVirtualModelAccess(client));
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

export async function updateAgentApiKeyVirtualModelAccess(input: {
  access: NormalizedAgentApiKeyVirtualModelAccessInput;
  databaseUrl: string;
}): Promise<AgentApiKeyVirtualModelAccess> {
  let savedAccess: AgentApiKeyVirtualModelAccess | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update Agent API key virtual model access ${input.access.id}`,
    changes: [
      { table: "agent_api_keys", recordId: input.access.id },
      { table: "agent_api_key_virtual_models", recordId: input.access.id },
    ],
    write: async (client) => {
      assertDefaultVirtualModelIsAllowed(input.access);
      await assertAgentApiKeyExists(client, input.access.id);
      await assertVirtualModelsAvailable(client, input.access.allowedVirtualModelIds);

      await client.query("delete from agent_api_key_virtual_models where agent_api_key_id = $1", [
        input.access.id,
      ]);

      for (const virtualModelId of input.access.allowedVirtualModelIds) {
        await client.query(
          `
            insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id)
            values ($1, $2)
          `,
          [input.access.id, virtualModelId],
        );
      }

      await client.query(
        `
          update agent_api_keys
          set default_virtual_model_id = $2,
              updated_at = now()
          where id = $1
        `,
        [input.access.id, input.access.defaultVirtualModelId],
      );

      savedAccess = requireAgentApiKeyVirtualModelAccess(
        await readAgentApiKeyVirtualModelAccessById(client, input.access.id),
      );
    },
  });

  return requireAgentApiKeyVirtualModelAccess(savedAccess);
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

async function assertVirtualModelsAvailable(
  client: QueryClient,
  virtualModelIds: readonly string[],
): Promise<void> {
  if (virtualModelIds.length === 0) {
    return;
  }

  const result = await client.query<{ id: string }>(
    `
      select id::text
      from virtual_models
      where enabled = true
        and id = any($1::uuid[])
    `,
    [virtualModelIds],
  );
  const availableIds = new Set(result.rows.map((row) => row.id));
  const missingId = virtualModelIds.find((id) => !availableIds.has(id));
  if (missingId) {
    throw new Error(`Allowed Virtual Model was not found or is disabled: ${missingId}`);
  }
}

async function readAgentApiKeyVirtualModelAccessById(
  client: QueryClient,
  agentApiKeyId: string,
): Promise<AgentApiKeyVirtualModelAccess | undefined> {
  return (await readAgentApiKeyVirtualModelAccess(client, agentApiKeyId))[0];
}

async function readAgentApiKeyVirtualModelAccess(
  client: QueryClient,
  agentApiKeyId?: string,
): Promise<AgentApiKeyVirtualModelAccess[]> {
  const baseResult = await client.query<AgentApiKeyVirtualModelAccessBaseRow>(
    `
      select agent_api_keys.id::text as agent_api_key_id,
             default_virtual_models.id::text as default_virtual_model_id,
             default_virtual_models.name as default_virtual_model_name,
             default_virtual_models.display_name as default_virtual_model_display_name
      from agent_api_keys
      left join virtual_models default_virtual_models
        on default_virtual_models.id = agent_api_keys.default_virtual_model_id
      where ($1::uuid is null or agent_api_keys.id = $1::uuid)
      order by agent_api_keys.created_at
    `,
    [agentApiKeyId ?? null],
  );
  const allowedResult = await client.query<AgentApiKeyAllowedVirtualModelRow>(
    `
      select agent_api_key_virtual_models.agent_api_key_id::text,
             virtual_models.id::text,
             virtual_models.name,
             virtual_models.display_name
      from agent_api_key_virtual_models
      join virtual_models on virtual_models.id = agent_api_key_virtual_models.virtual_model_id
      where ($1::uuid is null or agent_api_key_virtual_models.agent_api_key_id = $1::uuid)
      order by virtual_models.name
    `,
    [agentApiKeyId ?? null],
  );
  const allowedByAgentApiKeyId = new Map<string, AgentApiKeyVirtualModel[]>();
  for (const row of allowedResult.rows) {
    const values = allowedByAgentApiKeyId.get(row.agent_api_key_id) ?? [];
    values.push({
      displayName: row.display_name,
      id: row.id,
      name: row.name,
    });
    allowedByAgentApiKeyId.set(row.agent_api_key_id, values);
  }

  return baseResult.rows.map((row) => ({
    agentApiKeyId: row.agent_api_key_id,
    allowedVirtualModels: allowedByAgentApiKeyId.get(row.agent_api_key_id) ?? [],
    defaultVirtualModel:
      row.default_virtual_model_id &&
      row.default_virtual_model_name &&
      row.default_virtual_model_display_name
        ? {
            displayName: row.default_virtual_model_display_name,
            id: row.default_virtual_model_id,
            name: row.default_virtual_model_name,
          }
        : null,
  }));
}

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

function formatVirtualModelLabel(virtualModel: AgentApiKeyVirtualModel): string {
  return `${virtualModel.displayName} (${virtualModel.name})`;
}

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

function assertDefaultVirtualModelIsAllowed(input: {
  allowedVirtualModelIds: readonly string[];
  defaultVirtualModelId: string | null;
}): void {
  if (
    input.defaultVirtualModelId &&
    !input.allowedVirtualModelIds.includes(input.defaultVirtualModelId)
  ) {
    throw new Error("Default Virtual Model must be included in the allowed Virtual Models.");
  }
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeTextList(
  values: readonly (string | null | undefined)[] | string | null | undefined,
): string[] {
  const rawValues = Array.isArray(values) ? values : values ? [values] : [];
  return rawValues.flatMap((value) => {
    const normalized = normalizeOptionalText(value);
    return normalized ? [normalized] : [];
  });
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

function requireAgentApiKeyVirtualModelAccess(
  access: AgentApiKeyVirtualModelAccess | undefined,
): AgentApiKeyVirtualModelAccess {
  if (!access) {
    throw new Error("Agent API key virtual model access was not saved.");
  }
  return access;
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

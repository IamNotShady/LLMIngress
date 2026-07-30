import { createHash, randomBytes, randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import type { RouteEndpointProtocol } from "@llmingress/domain";
import {
  type ApiKeyLimitRuleInput,
  assertCompleteApiKeyLimitRules,
  type ConsoleApiKeyLimit,
  readApiKeyLimitsWithClient,
  replaceApiKeyLimitRulesWithClient,
} from "./console-api-key-limits.ts";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

export type ApiKeyFormInput = {
  name?: string | null;
};

export type NormalizedApiKeyFormInput = {
  name: string;
};

export type ConsoleApiKey = NormalizedApiKeyFormInput & {
  createdAt: Date;
  enabled: boolean;
  id: string;
  keyPrefix: string;
  /**
   * Derived from the key's most recent request — api_keys has no such column,
   * so a key that has never served traffic reports null.
   */
  lastUsedAt: Date | null;
  limitsEnabled: boolean;
  requestAttributionCount: number;
  updatedAt: Date;
};

export type ConsoleApiKeyCreateResult = ConsoleApiKey & {
  limits: ConsoleApiKeyLimit[];
  plaintext: string;
  virtualModelAccess: ApiKeyVirtualModelAccess;
};

export type ApiKeyVirtualModel = {
  displayName: string;
  id: string;
  name: string;
};

export type ApiKeyAllowedVirtualModel = ApiKeyVirtualModel & {
  endpointProtocol: RouteEndpointProtocol | null;
};

export type ApiKeyVirtualModelAccess = {
  apiKeyId: string;
  allowedVirtualModels: ApiKeyAllowedVirtualModel[];
  defaultVirtualModel: ApiKeyVirtualModel | null;
};

export type ApiKeyVirtualModelAccessInput = {
  allowedVirtualModelIds?: readonly (string | null | undefined)[] | string | null;
  defaultVirtualModelId?: string | null;
  id?: string | null;
};

export type ApiKeyVirtualModelSelectionInput = Omit<ApiKeyVirtualModelAccessInput, "id">;

export type NormalizedApiKeyVirtualModelSelectionInput = {
  allowedVirtualModelIds: string[];
  defaultVirtualModelId: string | null;
};

export type NormalizedApiKeyVirtualModelAccessInput = NormalizedApiKeyVirtualModelSelectionInput & {
  id: string;
};

type ApiKeyRow = {
  created_at: Date;
  enabled: boolean;
  id: string;
  key_prefix: string;
  last_used_at?: Date | string | null;
  limits_enabled: boolean;
  name: string;
  request_attribution_count: number;
  updated_at: Date;
};

type ApiKeyQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

type ApiKeyVirtualModelAccessBaseRow = {
  api_key_id: string;
  default_virtual_model_display_name: string | null;
  default_virtual_model_id: string | null;
  default_virtual_model_name: string | null;
};

type ApiKeyAllowedVirtualModelRow = {
  api_key_id: string;
  display_name: string;
  endpoint_protocol: RouteEndpointProtocol | null;
  id: string;
  name: string;
};

export type StoredApiKey = {
  keyHash: string;
  keyPrefix: string;
};

const apiKeyPrefixLength = 12;

export function generateApiKeyPlaintext(): string {
  return `llmi_${randomBytes(32).toString("base64url")}`;
}

export function buildApiKeyHash(plaintext: string): string {
  return `sha256:v1:${createHash("sha256")
    .update("llmingress:api-key:v1")
    .update(plaintext.trim())
    .digest("base64url")}`;
}

export function prepareApiKeyForStorage(plaintext: string): StoredApiKey {
  const normalized = normalizeApiKeyPlaintext(plaintext);
  return {
    keyHash: buildApiKeyHash(normalized),
    keyPrefix: normalized.slice(0, apiKeyPrefixLength),
  };
}

export function normalizeApiKeyFormInput(input: ApiKeyFormInput): NormalizedApiKeyFormInput {
  const name = input.name?.trim();

  if (!name) {
    throw consoleValidationError("API key name is required.", "api_key_name_required", {
      field: "name",
    });
  }

  return {
    name,
  };
}

export async function listApiKeys(databaseUrl?: string): Promise<ConsoleApiKey[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ApiKeyRow>(
      `
        select api_keys.id::text,
               api_keys.name,
               api_keys.key_prefix,
               api_keys.enabled,
               api_keys.limits_enabled,
               api_keys.created_at,
               api_keys.updated_at,
               (
                 select count(*)::integer
                 from request_activity
                 where request_activity.api_key_id = api_keys.id
               ) as request_attribution_count,
               (
                 select max(request_activity.started_at)
                 from request_activity
                 where request_activity.api_key_id = api_keys.id
               ) as last_used_at
        from api_keys
        where api_keys.deleted_at is null
        order by api_keys.created_at desc,
                 api_keys.id desc
      `,
    );
    return result.rows.map(rowToConsoleApiKey);
  });
}

export function normalizeApiKeyVirtualModelAccessInput(
  input: ApiKeyVirtualModelAccessInput,
): NormalizedApiKeyVirtualModelAccessInput {
  const id = normalizeRequiredText(input.id, "API key id");
  return {
    ...normalizeApiKeyVirtualModelSelectionInput(input),
    id,
  };
}

export function normalizeApiKeyVirtualModelSelectionInput(
  input: ApiKeyVirtualModelSelectionInput,
): NormalizedApiKeyVirtualModelSelectionInput {
  const allowedVirtualModelIds = Array.from(
    new Set(normalizeTextList(input.allowedVirtualModelIds)),
  );
  const defaultVirtualModelId = normalizeOptionalText(input.defaultVirtualModelId);

  if (allowedVirtualModelIds.length === 0) {
    throw consoleValidationError(
      "Select at least one allowed Virtual Model.",
      "api_key_allowed_virtual_model_required",
      { field: "allowedVirtualModelIds" },
    );
  }
  assertDefaultVirtualModelIsAllowed({ allowedVirtualModelIds, defaultVirtualModelId });

  return {
    allowedVirtualModelIds,
    defaultVirtualModelId,
  };
}

export function normalizeApiKeyVirtualModelAccessFormInput(
  input: ApiKeyVirtualModelAccessInput,
): NormalizedApiKeyVirtualModelAccessInput {
  return normalizeApiKeyVirtualModelAccessInput(input);
}

export async function listApiKeyVirtualModelAccess(
  databaseUrl?: string,
): Promise<ApiKeyVirtualModelAccess[]> {
  return withPooledPostgresClient(databaseUrl, async (client) =>
    readApiKeyVirtualModelAccess(client),
  );
}

export async function updateApiKeyVirtualModelAccess(input: {
  access: NormalizedApiKeyVirtualModelAccessInput;
  databaseUrl?: string;
}): Promise<ApiKeyVirtualModelAccess> {
  let savedAccess: ApiKeyVirtualModelAccess | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update API key virtual model access ${input.access.id}`,
    changes: [
      { table: "api_keys", recordId: input.access.id },
      { table: "api_key_virtual_models", recordId: input.access.id },
    ],
    write: async (client) => {
      assertDefaultVirtualModelIsAllowed(input.access);
      await assertApiKeyExists(client, input.access.id);
      await assertVirtualModelsAvailable(client, input.access.allowedVirtualModelIds);

      await replaceApiKeyVirtualModelsWithClient(client, input.access.id, input.access);

      savedAccess = requireApiKeyVirtualModelAccess(
        await readApiKeyVirtualModelAccessById(client, input.access.id),
      );
    },
  });

  return requireApiKeyVirtualModelAccess(savedAccess);
}

export async function createApiKeyWithSettings(input: {
  apiKey: NormalizedApiKeyFormInput;
  databaseUrl?: string;
  limitRules: readonly ApiKeyLimitRuleInput[];
  limitsEnabled: boolean;
  virtualModels: NormalizedApiKeyVirtualModelSelectionInput;
}): Promise<ConsoleApiKeyCreateResult> {
  const apiKeyId = randomUUID();
  const plaintext = generateApiKeyPlaintext();
  const stored = prepareApiKeyForStorage(plaintext);
  let apiKey: ConsoleApiKeyCreateResult | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create API key ${input.apiKey.name}`,
    changes: [
      { table: "api_keys", recordId: apiKeyId },
      { table: "api_key_virtual_models", recordId: apiKeyId },
      ...(input.limitsEnabled ? [{ table: "api_key_limits" as const, recordId: apiKeyId }] : []),
    ],
    write: async (client) => {
      await assertVirtualModelsAvailable(client, input.virtualModels.allowedVirtualModelIds);
      const result = await client.query<ApiKeyRow>(
        `
          insert into api_keys (
            id,
            name,
            key_prefix,
            key_hash,
            enabled,
            limits_enabled
          )
          values ($1, $2, $3, $4, true, $5)
          returning id::text,
                    name,
                    key_prefix,
                    enabled,
                    limits_enabled,
                    created_at,
                    updated_at,
                    0::integer as request_attribution_count
        `,
        [apiKeyId, input.apiKey.name, stored.keyPrefix, stored.keyHash, input.limitsEnabled],
      );
      await replaceApiKeyVirtualModelsWithClient(client, apiKeyId, input.virtualModels);
      if (input.limitsEnabled) {
        assertCompleteApiKeyLimitRules(input.limitRules);
        await replaceApiKeyLimitRulesWithClient(client, apiKeyId, input.limitRules);
      }
      apiKey = {
        ...rowToConsoleApiKey(requireRow(result.rows[0])),
        limits: await readApiKeyLimitsWithClient(client, apiKeyId),
        plaintext,
        virtualModelAccess: requireApiKeyVirtualModelAccess(
          await readApiKeyVirtualModelAccessById(client, apiKeyId),
        ),
      };
    },
  });

  return requireSavedApiKey(apiKey);
}

export async function updateApiKeyWithSettings(input: {
  apiKey: NormalizedApiKeyFormInput;
  databaseUrl?: string;
  id: string;
  limitRules: readonly ApiKeyLimitRuleInput[];
  limitsEnabled: boolean;
  virtualModels: NormalizedApiKeyVirtualModelSelectionInput;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update API key settings ${input.id}`,
    changes: [
      { table: "api_keys", recordId: input.id },
      { table: "api_key_virtual_models", recordId: input.id },
      { table: "api_key_limits", recordId: input.id },
    ],
    write: async (client) => {
      await assertApiKeyExists(client, input.id);
      await assertVirtualModelsAvailable(client, input.virtualModels.allowedVirtualModelIds);
      await client.query(
        `
          update api_keys
          set name = $2,
              limits_enabled = $3,
              updated_at = now()
          where id = $1
            and deleted_at is null
        `,
        [input.id, input.apiKey.name, input.limitsEnabled],
      );
      await replaceApiKeyVirtualModelsWithClient(client, input.id, input.virtualModels);
      if (input.limitsEnabled) {
        assertCompleteApiKeyLimitRules(input.limitRules);
        await replaceApiKeyLimitRulesWithClient(client, input.id, input.limitRules);
      } else {
        await replaceApiKeyLimitRulesWithClient(client, input.id, []);
      }
    },
  });
}

export async function updateApiKey(input: {
  apiKey: NormalizedApiKeyFormInput;
  databaseUrl?: string;
  id: string;
}): Promise<ConsoleApiKey> {
  let apiKey: ConsoleApiKey | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update API key ${input.id}`,
    changes: [{ table: "api_keys", recordId: input.id }],
    write: async (client) => {
      const result = await client.query<ApiKeyRow>(
        `
          update api_keys
          set name = $2,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text,
                    name,
                    key_prefix,
                    enabled,
                    limits_enabled,
                    created_at,
                    updated_at,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.api_key_id = api_keys.id
                    ) as request_attribution_count
        `,
        [input.id, input.apiKey.name],
      );
      apiKey = rowToConsoleApiKey(requireRow(result.rows[0]));
    },
  });

  return requireSavedApiKey(apiKey);
}

export async function setApiKeyEnabled(input: {
  databaseUrl?: string;
  enabled: boolean;
  id: string;
}): Promise<void> {
  await updateApiKeyBooleanSetting({
    databaseUrl: input.databaseUrl,
    description: `${input.enabled ? "Enable" : "Disable"} API key ${input.id}`,
    id: input.id,
    setClause: "enabled = $2",
    value: input.enabled,
  });
}

export async function deleteApiKey(input: { databaseUrl?: string; id: string }): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete API key ${input.id}`,
    changes: [{ table: "api_keys", recordId: input.id }],
    write: async (client) => {
      await assertApiKeyExists(client, input.id);

      const result = await client.query<{ id: string }>(
        `
          update api_keys
          set deleted_at = now(),
              enabled = false,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text
        `,
        [input.id],
      );
      if (!result.rows[0]) {
        throw new Error("API key was not deleted.");
      }
    },
  });
}

async function assertApiKeyExists(client: ApiKeyQueryClient, apiKeyId: string): Promise<void> {
  const result = await client.query(
    "select 1 from api_keys where id = $1 and deleted_at is null for update",
    [apiKeyId],
  );
  if (!result.rows[0]) {
    throw consoleNotFoundError("API key was not found.", "api_key_not_found", { apiKeyId });
  }
}

async function replaceApiKeyVirtualModelsWithClient(
  client: ApiKeyQueryClient,
  apiKeyId: string,
  virtualModels: NormalizedApiKeyVirtualModelSelectionInput,
): Promise<void> {
  await client.query("delete from api_key_virtual_models where api_key_id = $1", [apiKeyId]);
  for (const virtualModelId of virtualModels.allowedVirtualModelIds) {
    await client.query(
      `insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)`,
      [apiKeyId, virtualModelId],
    );
  }
  await client.query(
    `update api_keys set default_virtual_model_id = $2, updated_at = now() where id = $1`,
    [apiKeyId, virtualModels.defaultVirtualModelId],
  );
}

async function updateApiKeyBooleanSetting(input: {
  databaseUrl?: string;
  description: string;
  id: string;
  setClause: "enabled = $2";
  value: boolean;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: input.description,
    changes: [{ table: "api_keys", recordId: input.id }],
    write: async (client) => {
      await assertApiKeyExists(client, input.id);
      await client.query(
        `update api_keys set ${input.setClause}, updated_at = now() where id = $1 and deleted_at is null`,
        [input.id, input.value],
      );
    },
  });
}

async function assertVirtualModelsAvailable(
  client: ApiKeyQueryClient,
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
        and deleted_at is null
        and id = any($1::uuid[])
    `,
    [virtualModelIds],
  );
  const availableIds = new Set(result.rows.map((row) => row.id));
  const missingId = virtualModelIds.find((id) => !availableIds.has(id));
  if (missingId) {
    throw consoleValidationError(
      `Allowed Virtual Model was not found or is disabled: ${missingId}`,
      "api_key_virtual_model_not_available",
      { virtualModelId: missingId },
    );
  }
}

async function readApiKeyVirtualModelAccessById(
  client: ApiKeyQueryClient,
  apiKeyId: string,
): Promise<ApiKeyVirtualModelAccess | undefined> {
  return (await readApiKeyVirtualModelAccess(client, apiKeyId))[0];
}

async function readApiKeyVirtualModelAccess(
  client: ApiKeyQueryClient,
  apiKeyId?: string,
): Promise<ApiKeyVirtualModelAccess[]> {
  const baseResult = await client.query<ApiKeyVirtualModelAccessBaseRow>(
    `
      select api_keys.id::text as api_key_id,
             default_virtual_models.id::text as default_virtual_model_id,
             default_virtual_models.name as default_virtual_model_name,
             default_virtual_models.description as default_virtual_model_display_name
      from api_keys
      left join virtual_models default_virtual_models
        on default_virtual_models.id = api_keys.default_virtual_model_id
       and default_virtual_models.deleted_at is null
      where api_keys.deleted_at is null
        and ($1::uuid is null or api_keys.id = $1::uuid)
      order by api_keys.created_at
    `,
    [apiKeyId ?? null],
  );
  const allowedResult = await client.query<ApiKeyAllowedVirtualModelRow>(
    `
      select api_key_virtual_models.api_key_id::text as api_key_id,
             virtual_models.id::text,
             virtual_models.name,
             virtual_models.description as display_name,
             route_policies.endpoint_protocol
      from api_key_virtual_models
      join virtual_models on virtual_models.id = api_key_virtual_models.virtual_model_id
      join api_keys on api_keys.id = api_key_virtual_models.api_key_id
      left join route_policies
        on route_policies.virtual_model_id = virtual_models.id
       and route_policies.deleted_at is null
      where api_keys.deleted_at is null
        and virtual_models.deleted_at is null
        and ($1::uuid is null or api_key_virtual_models.api_key_id = $1::uuid)
      order by virtual_models.name
    `,
    [apiKeyId ?? null],
  );
  const allowedByApiKeyId = new Map<string, ApiKeyAllowedVirtualModel[]>();
  for (const row of allowedResult.rows) {
    const values = allowedByApiKeyId.get(row.api_key_id) ?? [];
    values.push({
      displayName: row.display_name,
      endpointProtocol: row.endpoint_protocol,
      id: row.id,
      name: row.name,
    });
    allowedByApiKeyId.set(row.api_key_id, values);
  }

  return baseResult.rows.map((row) => ({
    apiKeyId: row.api_key_id,
    allowedVirtualModels: allowedByApiKeyId.get(row.api_key_id) ?? [],
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

function rowToConsoleApiKey(row: ApiKeyRow): ConsoleApiKey {
  return {
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    id: row.id,
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    limitsEnabled: row.limits_enabled,
    name: row.name,
    requestAttributionCount: row.request_attribution_count,
    updatedAt: new Date(row.updated_at),
  };
}

function normalizeApiKeyPlaintext(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw consoleValidationError("API key plaintext is required.", "api_key_required");
  }
  if (plaintext.length <= apiKeyPrefixLength) {
    throw consoleValidationError(
      "API key must be longer than the stored prefix.",
      "api_key_too_short",
    );
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
    throw consoleValidationError(
      "Default Virtual Model must be included in the allowed Virtual Models.",
      "api_key_default_virtual_model_not_allowed",
      { defaultVirtualModelId: input.defaultVirtualModelId },
    );
  }
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw consoleValidationError(`${label} is required.`, "form_field_required", { field: label });
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
    throw consoleNotFoundError("API key was not found.", "api_key_not_found");
  }
  return row;
}

function requireSavedApiKey<T extends ConsoleApiKey>(apiKey: T | undefined): T {
  if (!apiKey) {
    throw new Error("API key was not saved.");
  }
  return apiKey;
}

function requireApiKeyVirtualModelAccess(
  access: ApiKeyVirtualModelAccess | undefined,
): ApiKeyVirtualModelAccess {
  if (!access) {
    throw new Error("API key virtual model access was not saved.");
  }
  return access;
}

export async function setApiKeyLimitsEnabled(input: {
  databaseUrl?: string;
  enabled: boolean;
  id: string;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `${input.enabled ? "Enable" : "Disable"} API key limits ${input.id}`,
    changes: [
      { table: "api_keys", recordId: input.id },
      { table: "api_key_limits", recordId: input.id },
    ],
    write: async (client) => {
      if (input.enabled) {
        const rules = await readApiKeyLimitsWithClient(client, input.id);
        assertCompleteApiKeyLimitRules(rules);
      }
      const result = await client.query(
        `update api_keys
           set limits_enabled = $2, updated_at = now()
         where id = $1::uuid and deleted_at is null
         returning id`,
        [input.id, input.enabled],
      );
      if (result.rows.length === 0) {
        throw consoleNotFoundError("API key not found.", "api_key_not_found");
      }
      if (!input.enabled) {
        await replaceApiKeyLimitRulesWithClient(client, input.id, []);
      }
    },
  });
}

import { randomUUID } from "node:crypto";
import { type ConfigPublishClient, createConfigPublisher } from "@llmingress/db/config-versions";
import { PostgresClient } from "@llmingress/db/providers";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import {
  consoleConflictError,
  consoleNotFoundError,
  consoleValidationError,
} from "./console-operation-error.ts";
import {
  isKnownProviderTemplateKey,
  type ProviderTemplateCreateInput,
} from "./console-provider-templates.ts";

export type ProviderType = "api_key" | "local" | "subscription";

export type ProviderFormInput = {
  baseUrl?: string | null;
  displayName?: string | null;
  providerKey?: string | null;
  providerType?: string | null;
};

export type NormalizedProviderFormInput = {
  baseUrl: string | null;
  displayName: string;
  providerKey: string;
  providerType: ProviderType;
};

export type ConsoleProvider = NormalizedProviderFormInput & {
  enabled: boolean;
  id: string;
  providerTemplateId: string | null;
};

type ProviderRow = {
  base_url: string | null;
  display_name: string;
  enabled: boolean;
  id: string;
  provider_key: string;
  provider_template_id: string | null;
  provider_type: ProviderType;
};

export function normalizeProviderFormInput(input: ProviderFormInput): NormalizedProviderFormInput {
  const providerKey = input.providerKey?.trim().toLowerCase();
  const displayName = input.displayName?.trim();
  const providerType = input.providerType?.trim();
  const baseUrl = input.baseUrl?.trim() || null;

  if (!providerKey) {
    throw consoleValidationError("Provider key is required.", "provider_key_required", {
      field: "providerKey",
    });
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(providerKey)) {
    throw consoleValidationError(
      "Provider key must use lowercase letters, numbers, dashes, or underscores.",
      "provider_key_invalid",
      { field: "providerKey" },
    );
  }

  if (!displayName) {
    throw consoleValidationError(
      "Provider display name is required.",
      "provider_display_name_required",
      {
        field: "displayName",
      },
    );
  }

  if (isKnownProviderTemplateKey(providerKey)) {
    throw consoleValidationError(
      `${displayName} providers must be created from their provider template.`,
      "provider_template_required",
      { providerKey },
    );
  }

  if (!isProviderType(providerType)) {
    throw consoleValidationError(
      "Provider type must be api_key, local, or subscription.",
      "provider_type_invalid",
      { field: "providerType" },
    );
  }

  if (providerType === "local" || providerType === "subscription") {
    throw consoleValidationError(
      "Local providers and subscription providers must be created from a provider template.",
      "provider_template_required",
      { providerType },
    );
  }

  if (baseUrl) {
    assertUrl(baseUrl);
    assertProviderBaseUrlAllowed(providerKey, providerType, baseUrl);
  }

  return {
    baseUrl,
    displayName,
    providerKey,
    providerType,
  };
}

export async function listProviders(databaseUrl?: string): Promise<ConsoleProvider[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderRow>(
      `
        select id::text,
               provider_type,
               provider_key,
               provider_template_id,
               display_name,
               base_url,
               enabled
        from providers
        where deleted_at is null
        order by provider_key
      `,
    );
    return result.rows.map(rowToConsoleProvider);
  });
}

export async function createProvider(input: {
  databaseUrl?: string;
  provider: NormalizedProviderFormInput;
}): Promise<ConsoleProvider> {
  const providerId = randomUUID();
  let provider: ConsoleProvider | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create provider ${input.provider.providerKey}`,
    changes: [{ table: "providers", recordId: providerId }],
    write: async (client) => {
      await assertProviderKeyAvailable(client, input.provider.providerKey);
      const result = await client.query<ProviderRow>(
        `
          insert into providers (
            id,
            provider_type,
            provider_key,
            display_name,
            base_url,
            enabled
          )
          values ($1, $2, $3, $4, $5, true)
          returning id::text,
                    provider_type,
                    provider_key,
                    provider_template_id,
                    display_name,
                    base_url,
                    enabled
        `,
        [
          providerId,
          input.provider.providerType,
          input.provider.providerKey,
          input.provider.displayName,
          input.provider.baseUrl,
        ],
      );
      provider = rowToConsoleProvider(requireRow(result.rows[0]));
    },
  });

  return requireSavedProvider(provider);
}

export async function createProviderFromTemplate(input: {
  databaseUrl?: string;
  template: ProviderTemplateCreateInput;
}): Promise<ConsoleProvider> {
  const providerId = randomUUID();
  let provider: ConsoleProvider | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create provider template ${input.template.id}`,
    changes: [{ table: "providers", recordId: providerId }],
    write: async (client) => {
      await assertProviderKeyAvailable(client, input.template.providerKey);
      const result = await client.query<ProviderRow>(
        `
          insert into providers (
            id,
            provider_type,
            provider_key,
            provider_template_id,
            display_name,
            base_url,
            enabled
          )
          values ($1, $2, $3, $4, $5, $6, true)
          returning id::text,
                    provider_type,
                    provider_key,
                    provider_template_id,
                    display_name,
                    base_url,
                    enabled
        `,
        [
          providerId,
          input.template.providerType,
          input.template.providerKey,
          input.template.id,
          input.template.displayName,
          input.template.baseUrl,
        ],
      );
      provider = rowToConsoleProvider(requireRow(result.rows[0]));
    },
  });

  return requireSavedProvider(provider);
}

export async function updateProvider(input: {
  baseUrl?: string | null;
  databaseUrl?: string;
  displayName: string;
  id: string;
}): Promise<ConsoleProvider> {
  const displayName = input.displayName.trim();
  const baseUrl = input.baseUrl?.trim() || null;
  if (!displayName) {
    throw consoleValidationError(
      "Provider display name is required.",
      "provider_display_name_required",
      {
        field: "displayName",
      },
    );
  }
  if (baseUrl) {
    assertUrl(baseUrl);
  }

  let provider: ConsoleProvider | undefined;
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update provider ${input.id}`,
    changes: [{ table: "providers", recordId: input.id }],
    write: async (client) => {
      const existing = requireRow(
        (
          await client.query<ProviderRow>(
            `
              select id::text,
                     provider_type,
                     provider_key,
                     provider_template_id,
                     display_name,
                     base_url,
                     enabled
              from providers
              where id = $1
                and deleted_at is null
              for update
            `,
            [input.id],
          )
        ).rows[0],
      );
      const nextBaseUrl = resolveUpdatedBaseUrl(existing, baseUrl);
      const result = await client.query<ProviderRow>(
        `
          update providers
          set display_name = $2,
              base_url = $3,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text,
                    provider_type,
                    provider_key,
                    provider_template_id,
                    display_name,
                    base_url,
                    enabled
        `,
        [input.id, displayName, nextBaseUrl],
      );
      provider = rowToConsoleProvider(requireRow(result.rows[0]));
    },
  });

  return requireSavedProvider(provider);
}

export async function setProviderEnabled(input: {
  databaseUrl?: string;
  enabled: boolean;
  id: string;
}): Promise<ConsoleProvider> {
  let provider: ConsoleProvider | undefined;
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `${input.enabled ? "Enable" : "Disable"} provider ${input.id}`,
    changes: [{ table: "providers", recordId: input.id }],
    write: async (client) => {
      const result = await client.query<ProviderRow>(
        `
          update providers
          set enabled = $2,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text,
                    provider_type,
                    provider_key,
                    provider_template_id,
                    display_name,
                    base_url,
                    enabled
        `,
        [input.id, input.enabled],
      );
      provider = rowToConsoleProvider(requireRow(result.rows[0]));
    },
  });

  return requireSavedProvider(provider);
}

export async function deleteProvider(input: { databaseUrl?: string; id: string }): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete provider ${input.id}`,
    changes: [{ table: "providers", recordId: input.id }],
    write: async (client) => {
      const result = await client.query<{ id: string }>(
        `
          update providers
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
        throw consoleNotFoundError("Provider was not found.", "provider_not_found", {
          providerId: input.id,
        });
      }
      await client.query(
        `
          update request_activity
          set provider_api_key_id = null
          where provider_api_key_id in (
            select id
            from provider_api_keys
            where provider_id = $1
          )
        `,
        [input.id],
      );
      await client.query(
        `
          update fallback_events
          set provider_api_key_id = null
          where provider_api_key_id in (
            select id
            from provider_api_keys
            where provider_id = $1
          )
        `,
        [input.id],
      );
      await client.query("delete from provider_api_keys where provider_id = $1", [input.id]);
      await client.query(
        `
          update provider_models
          set deleted_at = now(),
              updated_at = now()
          where provider_id = $1
            and deleted_at is null
        `,
        [input.id],
      );
    },
  });
}

function rowToConsoleProvider(row: ProviderRow): ConsoleProvider {
  return {
    baseUrl: row.base_url,
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    providerKey: row.provider_key,
    providerTemplateId: row.provider_template_id,
    providerType: row.provider_type,
  };
}

function resolveUpdatedBaseUrl(
  existing: ProviderRow,
  requestedBaseUrl: string | null,
): string | null {
  if (existing.provider_template_id) {
    if (requestedBaseUrl && requestedBaseUrl !== existing.base_url) {
      throw consoleValidationError(
        "Template provider base URL cannot be changed.",
        "provider_template_base_url_immutable",
        { providerId: existing.id },
      );
    }

    return existing.base_url;
  }

  if (requestedBaseUrl) {
    assertProviderBaseUrlAllowed(existing.provider_key, existing.provider_type, requestedBaseUrl);
  }

  return requestedBaseUrl;
}

function assertProviderBaseUrlAllowed(
  providerKey: string,
  providerType: ProviderType,
  baseUrl: string,
): void {
  if (providerType === "local") {
    return;
  }

  const fixedBaseUrl = resolveProviderDescriptor(providerKey).fixedApiKeyBaseUrl;
  if (fixedBaseUrl && normalizeUrlForComparison(baseUrl) === fixedBaseUrl) {
    return;
  }

  throw consoleValidationError(
    "Custom OpenAI-compatible endpoints are not allowed.",
    "provider_base_url_not_allowed",
    { providerKey },
  );
}

function normalizeUrlForComparison(value: string): string {
  const url = new URL(value);
  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${pathname}`;
}

function requireRow(row: ProviderRow | undefined): ProviderRow {
  if (!row) {
    throw consoleNotFoundError("Provider was not found.", "provider_not_found");
  }
  return row;
}

function requireSavedProvider(provider: ConsoleProvider | undefined): ConsoleProvider {
  if (!provider) {
    throw new Error("Provider was not saved.");
  }
  return provider;
}

function isProviderType(value: string | undefined): value is ProviderType {
  return value === "api_key" || value === "local" || value === "subscription";
}

function assertUrl(value: string): void {
  try {
    new URL(value);
  } catch {
    throw consoleValidationError(
      "Provider base URL must be a valid URL.",
      "provider_base_url_invalid",
      {
        field: "baseUrl",
      },
    );
  }
}

async function assertProviderKeyAvailable(
  client: ConfigPublishClient,
  providerKey: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `provider-key:${providerKey}`,
  ]);
  const existing = await client.query<{ id: string }>(
    `
      select id::text
      from providers
      where provider_key = $1
        and deleted_at is null
      limit 1
    `,
    [providerKey],
  );
  if (existing.rows[0]) {
    throw consoleConflictError("Provider type already exists.", "provider_key_conflict", {
      providerKey,
    });
  }
}

async function withClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

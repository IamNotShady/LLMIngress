import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";
import { isKnownProviderTemplateKey, type ProviderTemplateCreateInput } from "./provider-templates";

export type ProviderType = "api_key" | "local";

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

type ProviderRow = QueryResultRow & {
  base_url: string | null;
  display_name: string;
  enabled: boolean;
  id: string;
  provider_key: string;
  provider_template_id: string | null;
  provider_type: ProviderType;
};

const fixedApiKeyProviderBaseUrls = new Map([
  ["anthropic", "https://api.anthropic.com/v1"],
  ["openai", "https://api.openai.com/v1"],
  ["openrouter", "https://openrouter.ai/api/v1"],
]);

export function normalizeProviderFormInput(input: ProviderFormInput): NormalizedProviderFormInput {
  const providerKey = input.providerKey?.trim().toLowerCase();
  const displayName = input.displayName?.trim();
  const providerType = input.providerType?.trim();
  const baseUrl = input.baseUrl?.trim() || null;

  if (!providerKey) {
    throw new Error("Provider key is required.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(providerKey)) {
    throw new Error("Provider key must use lowercase letters, numbers, dashes, or underscores.");
  }

  if (!displayName) {
    throw new Error("Provider display name is required.");
  }

  if (isKnownProviderTemplateKey(providerKey)) {
    throw new Error(`${displayName} providers must be created from their provider template.`);
  }

  if (!isProviderType(providerType)) {
    throw new Error("Provider type must be api_key or local.");
  }

  if (providerType === "local") {
    throw new Error("Local providers must be created from a provider template.");
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

export async function listProviders(databaseUrl: string): Promise<ConsoleProvider[]> {
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
        order by provider_key
      `,
    );
    return result.rows.map(rowToConsoleProvider);
  });
}

export async function createProvider(input: {
  databaseUrl: string;
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
  databaseUrl: string;
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
  databaseUrl: string;
  displayName: string;
  id: string;
}): Promise<ConsoleProvider> {
  const displayName = input.displayName.trim();
  const baseUrl = input.baseUrl?.trim() || null;
  if (!displayName) {
    throw new Error("Provider display name is required.");
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
  databaseUrl: string;
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
      throw new Error("Template provider base URL cannot be changed.");
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

  const fixedBaseUrl = fixedApiKeyProviderBaseUrls.get(providerKey);
  if (fixedBaseUrl && normalizeUrlForComparison(baseUrl) === fixedBaseUrl) {
    return;
  }

  throw new Error("Custom OpenAI-compatible endpoints are not allowed.");
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
    throw new Error("Provider was not found.");
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
  return value === "api_key" || value === "local";
}

function assertUrl(value: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error("Provider base URL must be a valid URL.");
  }
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

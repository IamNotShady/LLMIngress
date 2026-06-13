import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

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
};

type ProviderRow = QueryResultRow & {
  base_url: string | null;
  display_name: string;
  enabled: boolean;
  id: string;
  provider_key: string;
  provider_type: ProviderType;
};

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

  if (!isProviderType(providerType)) {
    throw new Error("Provider type must be api_key or local.");
  }

  if (baseUrl) {
    assertUrl(baseUrl);
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
                    display_name,
                    base_url,
                    enabled
        `,
        [input.id, displayName, baseUrl],
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
    providerType: row.provider_type,
  };
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

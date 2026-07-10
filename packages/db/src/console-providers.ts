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

export type ProviderDependencyImpact = {
  agents: Array<{ id: string; name: string }>;
  apiKeyCount: number;
  oauthConnectionCount: number;
  pendingJobCount: number;
  providerId: string;
  providerModels: Array<{ displayName: string; id: string; modelId: string }>;
  routePolicies: Array<{ id: string; virtualModelId: string; virtualModelName: string }>;
  runningJobCount: number;
  virtualModels: Array<{ id: string; name: string }>;
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

type ProviderDependencyImpactRow = {
  agent_id: string | null;
  agent_name: string | null;
  provider_model_display_name: string;
  provider_model_id: string;
  provider_model_model_id: string;
  route_policy_id: string;
  virtual_model_id: string;
  virtual_model_name: string;
};

type ProviderDependencyCountsRow = {
  api_key_count: number;
  oauth_connection_count: number;
  pending_job_count: number;
  running_job_count: number;
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

export async function getProviderDependencyImpact(input: {
  databaseUrl?: string;
  providerId: string;
}): Promise<ProviderDependencyImpact> {
  return withClient(input.databaseUrl, async (client) =>
    readProviderDependencyImpact(client, input.providerId),
  );
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
      await lockProvidersById(client, [input.id]);
      if (!input.enabled) {
        await assertProviderHasNoActiveRoutePolicyDependencies(client, input.id);
      }
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
      await lockProvidersById(client, [input.id]);
      await assertProviderHasNoActiveRoutePolicyDependencies(client, input.id);
      await assertProviderHasNoRunningJobs(client, input.id);
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
          update jobs
          set status = 'canceled',
              updated_at = now(),
              completed_at = now(),
              error_code = 'provider_deleted',
              error_message = 'Provider was deleted before the job started.'
          where status = 'pending'
            and job_type in ('provider_connectivity_check', 'model_refresh')
            and payload->>'providerId' = $1
        `,
        [input.id],
      );
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
      await client.query("delete from provider_oauth where provider_id = $1", [input.id]);
      await client.query("delete from provider_health_summary where provider_id = $1", [input.id]);
      await client.query("delete from provider_health_events where provider_id = $1", [input.id]);
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

export async function lockProvidersForProviderModels(
  client: ConfigPublishClient,
  providerModelIds: readonly string[],
): Promise<void> {
  if (providerModelIds.length === 0) {
    return;
  }
  await client.query(
    `
      select providers.id::text
      from providers
      where providers.id in (
        select distinct provider_models.provider_id
        from provider_models
        where provider_models.id = any($1::uuid[])
      )
        and providers.deleted_at is null
      order by providers.id
      for update of providers
    `,
    [providerModelIds],
  );
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

async function lockProvidersById(
  client: ConfigPublishClient,
  providerIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(providerIds)].sort();
  if (ids.length === 0) {
    return;
  }
  await client.query(
    `
      select id::text
      from providers
      where id = any($1::uuid[])
        and deleted_at is null
      order by id
      for update
    `,
    [ids],
  );
}

async function assertProviderHasNoActiveRoutePolicyDependencies(
  client: ConfigPublishClient,
  providerId: string,
): Promise<void> {
  const impact = await readProviderDependencyImpact(client, providerId);
  if (impact.routePolicies.length > 0) {
    throw consoleConflictError(
      "Provider is still used by active route policies.",
      "provider_dependency_conflict",
      { impact },
    );
  }
}

async function assertProviderHasNoRunningJobs(
  client: ConfigPublishClient,
  providerId: string,
): Promise<void> {
  const impact = await readProviderDependencyImpact(client, providerId);
  if (impact.runningJobCount > 0) {
    throw consoleConflictError("Provider has running jobs.", "provider_job_running", { impact });
  }
}

async function readProviderDependencyImpact(
  client: ConfigPublishClient,
  providerId: string,
): Promise<ProviderDependencyImpact> {
  const dependencyRows = (
    await client.query<ProviderDependencyImpactRow>(
      `
        select provider_models.id::text as provider_model_id,
               provider_models.model_id as provider_model_model_id,
               provider_models.display_name as provider_model_display_name,
               route_policies.id::text as route_policy_id,
               virtual_models.id::text as virtual_model_id,
               coalesce(nullif(virtual_models.description, ''), virtual_models.name) as virtual_model_name,
               agents.id::text as agent_id,
               agents.name as agent_name
        from provider_models
        join route_policy_candidates
          on route_policy_candidates.provider_model_id = provider_models.id
        join route_policies
          on route_policies.id = route_policy_candidates.route_policy_id
         and route_policies.deleted_at is null
        join virtual_models
          on virtual_models.id = route_policies.virtual_model_id
         and virtual_models.deleted_at is null
        left join agents
          on agents.deleted_at is null
         and agents.enabled = true
         and (
              agents.default_virtual_model_id = virtual_models.id
              or exists (
                select 1
                from agent_virtual_models
                where agent_virtual_models.agent_id = agents.id
                  and agent_virtual_models.virtual_model_id = virtual_models.id
              )
         )
        where provider_models.provider_id = $1
          and provider_models.deleted_at is null
        order by provider_models.display_name,
                 route_policies.id,
                 agents.name nulls last,
                 agents.id nulls last
      `,
      [providerId],
    )
  ).rows;

  const countRows = (
    await client.query<ProviderDependencyCountsRow>(
      `
        select
          (select count(*)::integer from provider_api_keys where provider_id = $1::uuid) as api_key_count,
          (select count(*)::integer from provider_oauth where provider_id = $1::uuid) as oauth_connection_count,
          (
            select count(*)::integer
            from jobs
            where status = 'pending'
              and job_type in ('provider_connectivity_check', 'model_refresh')
              and payload->>'providerId' = $1::text
          ) as pending_job_count,
          (
            select count(*)::integer
            from jobs
            where status = 'running'
              and job_type in ('provider_connectivity_check', 'model_refresh')
              and payload->>'providerId' = $1::text
          ) as running_job_count
      `,
      [providerId],
    )
  ).rows[0] ?? {
    api_key_count: 0,
    oauth_connection_count: 0,
    pending_job_count: 0,
    running_job_count: 0,
  };

  return {
    agents: uniqueBy(
      dependencyRows
        .filter((row) => row.agent_id && row.agent_name)
        .map((row) => ({ id: row.agent_id ?? "", name: row.agent_name ?? "" })),
      (row) => row.id,
    ),
    apiKeyCount: countRows.api_key_count,
    oauthConnectionCount: countRows.oauth_connection_count,
    pendingJobCount: countRows.pending_job_count,
    providerId,
    providerModels: uniqueBy(
      dependencyRows.map((row) => ({
        displayName: row.provider_model_display_name,
        id: row.provider_model_id,
        modelId: row.provider_model_model_id,
      })),
      (row) => row.id,
    ),
    routePolicies: uniqueBy(
      dependencyRows.map((row) => ({
        id: row.route_policy_id,
        virtualModelId: row.virtual_model_id,
        virtualModelName: row.virtual_model_name,
      })),
      (row) => row.id,
    ),
    runningJobCount: countRows.running_job_count,
    virtualModels: uniqueBy(
      dependencyRows.map((row) => ({
        id: row.virtual_model_id,
        name: row.virtual_model_name,
      })),
      (row) => row.id,
    ),
  };
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
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

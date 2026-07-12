import {
  type ModelInputModality,
  type ModelOutputModality,
  type ProviderModelCapabilityMetadata,
  resolveProviderModelCapabilities,
  type SyncedModelCapabilities,
} from "@llmingress/domain";
import { createConfigPublisher } from "./config-versions.ts";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

export type ProviderModelManualCapabilities = {
  inputModalities: ModelInputModality[];
  outputModalities: ModelOutputModality[];
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsFunctionCalling: boolean;
  supportsReasoning: boolean;
};

type ProviderModelCapabilityRow = {
  capability_metadata: unknown;
  context_window: number | null;
  input_modalities: ModelInputModality[] | null;
  max_output_tokens: number | null;
  output_modalities: ModelOutputModality[] | null;
  supports_function_calling: boolean | null;
  supports_reasoning: boolean | null;
};

export async function updateProviderModelManualCapabilities(input: {
  capabilities: ProviderModelManualCapabilities | null;
  databaseUrl?: string;
  providerModelId: string;
}): Promise<void> {
  const providerModelId = input.providerModelId.trim();
  if (!providerModelId) {
    throw consoleValidationError("Provider model id is required.", "provider_model_id_required", {
      field: "providerModelId",
    });
  }

  const manualCapabilities =
    input.capabilities === null ? undefined : normalizeManualCapabilities(input.capabilities);
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: "Update provider model manual capabilities",
    changes: [{ table: "provider_models", recordId: providerModelId }],
    write: async (client) => {
      const result = await client.query<ProviderModelCapabilityRow>(
        `
          select input_modalities,
                 output_modalities,
                 context_window,
                 max_output_tokens,
                 supports_function_calling,
                 supports_reasoning,
                 capability_metadata
          from provider_models
          where id = $1
            and deleted_at is null
          for update
        `,
        [providerModelId],
      );
      const row = result.rows[0];
      if (!row) {
        throw consoleNotFoundError("Provider model was not found.", "provider_model_not_found");
      }

      const metadata = readCapabilityMetadata(row.capability_metadata);
      const syncedCapabilities = metadata.syncedCapabilities ?? buildSyncedCapabilitiesFromRow(row);
      const resolved = resolveProviderModelCapabilities({
        manualCapabilities,
        registrySources: metadata.registrySources,
        registrySyncedAt: metadata.registrySyncedAt,
        syncedCapabilities,
      });
      const effective = resolved.effectiveCapabilities;

      await client.query(
        `
          update provider_models
          set input_modalities = $2::text[],
              output_modalities = $3::text[],
              context_window = $4,
              max_output_tokens = $5,
              supports_function_calling = $6,
              supports_reasoning = $7,
              capability_metadata = $8::jsonb,
              updated_at = now()
          where id = $1
        `,
        [
          providerModelId,
          effective.inputModalities,
          effective.outputModalities,
          effective.maxContextTokens,
          effective.maxOutputTokens,
          effective.supportsFunctionCalling,
          effective.supportsReasoning,
          JSON.stringify({
            ...stripCapabilityMetadata(row.capability_metadata),
            ...resolved.metadata,
          }),
        ],
      );
    },
  });
}

function normalizeManualCapabilities(
  capabilities: ProviderModelManualCapabilities,
): ProviderModelManualCapabilities {
  if (capabilities.inputModalities.length === 0) {
    throw consoleValidationError(
      "Input modalities are required.",
      "provider_model_capability_input_modalities_required",
      { field: "inputModalities" },
    );
  }
  if (capabilities.outputModalities.length === 0) {
    throw consoleValidationError(
      "Output modalities are required.",
      "provider_model_capability_output_modalities_required",
      { field: "outputModalities" },
    );
  }
  if (!Number.isInteger(capabilities.maxContextTokens) || capabilities.maxContextTokens <= 0) {
    throw consoleValidationError(
      "Max context tokens must be a positive integer.",
      "provider_model_capability_max_context_invalid",
      { field: "maxContextTokens" },
    );
  }
  if (!Number.isInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens <= 0) {
    throw consoleValidationError(
      "Max output tokens must be a positive integer.",
      "provider_model_capability_max_output_invalid",
      { field: "maxOutputTokens" },
    );
  }
  return capabilities;
}

function buildSyncedCapabilitiesFromRow(
  row: ProviderModelCapabilityRow,
): Partial<SyncedModelCapabilities> {
  return {
    inputModalities: row.input_modalities,
    maxContextTokens: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    outputModalities: row.output_modalities,
    supportsFunctionCalling: row.supports_function_calling,
    supportsReasoning: row.supports_reasoning,
  };
}

function readCapabilityMetadata(value: unknown): ProviderModelCapabilityMetadata {
  const record = isRecord(value) ? value : {};
  return {
    manualCapabilities: isRecord(record.manualCapabilities)
      ? (record.manualCapabilities as ProviderModelCapabilityMetadata["manualCapabilities"])
      : undefined,
    registrySources: isRecord(record.registrySources)
      ? (record.registrySources as ProviderModelCapabilityMetadata["registrySources"])
      : undefined,
    registrySyncedAt:
      typeof record.registrySyncedAt === "string" ? record.registrySyncedAt : undefined,
    syncedCapabilities: isRecord(record.syncedCapabilities)
      ? (record.syncedCapabilities as ProviderModelCapabilityMetadata["syncedCapabilities"])
      : undefined,
  };
}

function stripCapabilityMetadata(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? { ...value } : {};
  delete record.conflicts;
  delete record.manualCapabilities;
  delete record.registrySources;
  delete record.registrySyncedAt;
  delete record.syncedCapabilities;
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

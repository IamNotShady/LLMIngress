export type ConsoleMutationFailure = {
  field?: string;
  message: string;
};

export type ConsoleErrorPayload = {
  code?: string;
  details?: Record<string, unknown>;
  error?: string;
};

const errorFieldByCode: Record<string, string> = {
  api_key_allowed_virtual_model_required: "allowedVirtualModelIds",
  api_key_name_required: "name",
  invalid_admin_password: "password",
  provider_api_key_label_too_long: "label",
  provider_api_key_priority_invalid: "priority",
  provider_api_key_required: "providerApiKey",
  provider_api_key_too_short: "providerApiKey",
  provider_base_url_invalid: "baseUrl",
  provider_display_name_required: "displayName",
  provider_key_invalid: "providerKey",
  provider_key_required: "providerKey",
  virtual_model_description_required: "description",
  virtual_model_name_conflict: "name",
  virtual_model_name_invalid: "name",
  virtual_model_name_required: "name",
};

const normalizedFieldNames: Record<string, string> = {
  "budget period": "budgetPeriod",
  "budget usd": "budgetUsd",
  concurrency: "concurrency",
  rpm: "rpm",
  "token limit": "tokenLimit",
  tpm: "tpm",
};

export function toConsoleMutationFailure(
  payload: ConsoleErrorPayload,
  fallbackMessage: string,
): ConsoleMutationFailure {
  const rawField = typeof payload.details?.field === "string" ? payload.details.field : undefined;
  const normalizedField = rawField
    ? (normalizedFieldNames[rawField.trim().toLowerCase()] ?? rawField)
    : undefined;
  return {
    ...(normalizedField || (payload.code ? errorFieldByCode[payload.code] : undefined)
      ? { field: normalizedField ?? errorFieldByCode[payload.code ?? ""] }
      : {}),
    message: payload.error ?? fallbackMessage,
  };
}

export const consoleVisibleProviderModelFilterSql = `
  (
    provider_models.output_modalities is null
    or not ('embedding' = any(provider_models.output_modalities))
    or 'text' = any(provider_models.output_modalities)
  )
`;

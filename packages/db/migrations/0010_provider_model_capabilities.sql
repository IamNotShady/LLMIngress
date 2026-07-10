alter table provider_models
  rename column supports_tools to supports_function_calling;

alter table provider_models
  alter column supports_function_calling drop default,
  alter column supports_function_calling drop not null;

alter table provider_models
  add column input_modalities text[],
  add column output_modalities text[],
  add column max_output_tokens integer,
  add column supports_reasoning boolean;

alter table provider_models
  add constraint provider_models_input_modalities_nonempty_check
    check (input_modalities is null or cardinality(input_modalities) > 0),
  add constraint provider_models_output_modalities_nonempty_check
    check (output_modalities is null or cardinality(output_modalities) > 0),
  add constraint provider_models_input_modalities_values_check
    check (
      input_modalities is null
      or input_modalities <@ array['text', 'image', 'audio', 'video', 'document']::text[]
    ),
  add constraint provider_models_output_modalities_values_check
    check (
      output_modalities is null
      or output_modalities <@ array['text', 'image', 'audio', 'video', 'embedding']::text[]
    ),
  add constraint provider_models_max_output_tokens_check
    check (max_output_tokens is null or max_output_tokens > 0);

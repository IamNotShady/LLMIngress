alter table providers
  drop constraint if exists providers_template_id_whitelisted;

alter table providers
  add constraint providers_template_id_whitelisted
  check (
    provider_template_id is null
    or provider_template_id in (
      'deepseek',
      'xai',
      'mistral',
      'qwen',
      'moonshot',
      'minimax',
      'groq',
      'fireworks',
      'zai',
      'ollama',
      'lmstudio',
      'llama_cpp'
    )
  );

insert into schema_version (id, version)
values (1, '0010')
on conflict (id) do update
set version = '0010',
    updated_at = now();

alter table providers
  drop constraint if exists providers_template_id_whitelisted;

update providers
set provider_key = 'google',
    provider_template_id = 'google',
    base_url = 'https://generativelanguage.googleapis.com/v1beta/openai',
    updated_at = now()
where provider_key = 'gemini'
  and provider_template_id = 'gemini'
  and regexp_replace(coalesce(base_url, ''), '/+$', '') in (
    'https://generativelanguage.googleapis.com/v1beta',
    'https://generativelanguage.googleapis.com/v1beta/openai'
  );

update providers
set base_url = regexp_replace(base_url, '/+$', '') || '/v1',
    updated_at = now()
where provider_key = 'ollama'
  and provider_template_id = 'ollama'
  and base_url is not null
  and regexp_replace(base_url, '/+$', '') !~ '/v1$';

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
      'llama_cpp',
      'openrouter',
      'google'
    )
  );

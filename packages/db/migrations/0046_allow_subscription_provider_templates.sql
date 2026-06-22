alter table providers
  drop constraint if exists providers_template_id_whitelisted;

alter table providers
  add constraint providers_template_id_whitelisted
  check (
    provider_template_id is null
    or provider_template_id in (
      'deepseek',
      'xai',
      'qwen',
      'moonshot',
      'minimax',
      'zai',
      'ollama',
      'lmstudio',
      'llama_cpp',
      'openrouter',
      'google',
      'openai_codex',
      'claude_code'
    )
  ) not valid;

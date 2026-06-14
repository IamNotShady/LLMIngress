alter table providers
  drop constraint if exists providers_template_id_whitelisted;

alter table providers
  add constraint providers_template_id_whitelisted
  check (
    provider_template_id is null
    or provider_template_id in ('deepseek', 'ollama')
  );

insert into schema_version (id, version)
values (1, '0008')
on conflict (id) do update
set version = '0008',
    updated_at = now();

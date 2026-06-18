alter table providers
  add column if not exists default_priority integer not null default 100;

alter table providers drop constraint if exists providers_default_priority_check;

alter table providers
  add constraint providers_default_priority_check check (default_priority >= 0);

alter table provider_api_keys
  add column if not exists label text;

alter table provider_api_keys
  add column if not exists enabled boolean not null default true;

alter table provider_api_keys
  add column if not exists priority integer not null default 100;

alter table provider_api_keys
  add column if not exists last_used_at timestamptz;

alter table provider_api_keys
  add column if not exists last_tested_at timestamptz;

alter table provider_api_keys
  add column if not exists last_test_status text not null default 'untested';

alter table provider_api_keys
  add column if not exists last_test_error_code text;

alter table provider_api_keys
  add column if not exists last_test_error_message text;

alter table provider_api_keys drop constraint if exists provider_api_keys_priority_check;

alter table provider_api_keys
  add constraint provider_api_keys_priority_check check (priority >= 0);

alter table provider_api_keys drop constraint if exists provider_api_keys_last_test_status_check;

alter table provider_api_keys
  add constraint provider_api_keys_last_test_status_check check (
    last_test_status in ('untested', 'healthy', 'failed')
  );

create index if not exists idx_provider_api_keys_provider_enabled_priority
  on provider_api_keys (provider_id, enabled, priority asc, created_at asc, id asc);

create index if not exists idx_provider_api_keys_last_used_at
  on provider_api_keys (last_used_at desc);

insert into schema_version (id, version)
values (1, '0026')
on conflict (id) do update
set version = '0026',
    updated_at = now();

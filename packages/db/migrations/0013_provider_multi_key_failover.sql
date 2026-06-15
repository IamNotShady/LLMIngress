alter table provider_api_keys drop constraint if exists provider_api_keys_provider_id_key;

create index if not exists idx_provider_api_keys_provider_created_at
  on provider_api_keys (provider_id, created_at asc, id asc);

alter table fallback_events
  add column if not exists provider_api_key_id uuid references provider_api_keys (id) on delete set null;

alter table fallback_events
  add column if not exists provider_api_key_prefix text;

insert into schema_version (id, version)
values (1, '0013')
on conflict (id) do update
set version = '0013',
    updated_at = now();

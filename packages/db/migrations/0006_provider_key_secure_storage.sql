create table if not exists provider_api_keys (
  id uuid primary key,
  provider_id uuid not null unique references providers (id) on delete cascade,
  key_prefix text not null check (length(key_prefix) > 0),
  encrypted_key jsonb not null check (jsonb_typeof(encrypted_key) = 'object'),
  key_id text not null check (length(key_id) > 0),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  updated_at timestamptz not null default now(),
  check (rotated_at is null or rotated_at >= created_at)
);

create index if not exists idx_provider_api_keys_provider_updated_at
  on provider_api_keys (provider_id, updated_at desc);

insert into schema_version (id, version)
values (1, '0006')
on conflict (id) do update
set version = '0006',
    updated_at = now();

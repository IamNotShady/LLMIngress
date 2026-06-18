alter table provider_models
  add column if not exists manual_input_usd_per_million_tokens numeric(20, 8)
    check (
      manual_input_usd_per_million_tokens is null
      or manual_input_usd_per_million_tokens >= 0
    ),
  add column if not exists manual_cached_input_usd_per_million_tokens numeric(20, 8)
    check (
      manual_cached_input_usd_per_million_tokens is null
      or manual_cached_input_usd_per_million_tokens >= 0
    ),
  add column if not exists manual_output_usd_per_million_tokens numeric(20, 8)
    check (
      manual_output_usd_per_million_tokens is null
      or manual_output_usd_per_million_tokens >= 0
    ),
  add column if not exists manual_price_updated_at timestamptz;

create table if not exists provider_models_price (
  id uuid primary key,
  provider_key text not null,
  model_id text not null,
  input_usd_per_million_tokens numeric(20, 8) not null check (
    input_usd_per_million_tokens >= 0
  ),
  cached_input_usd_per_million_tokens numeric(20, 8) check (
    cached_input_usd_per_million_tokens is null
    or cached_input_usd_per_million_tokens >= 0
  ),
  output_usd_per_million_tokens numeric(20, 8) not null check (
    output_usd_per_million_tokens >= 0
  ),
  source text not null check (source in ('models.dev', 'litellm')),
  source_url text not null,
  price_version text not null,
  synced_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key, model_id, source)
);

create index if not exists idx_provider_models_price_effective
  on provider_models_price (
    provider_key,
    model_id,
    source,
    synced_at desc,
    updated_at desc
  );

drop table if exists model_price_overrides;
drop table if exists price_registry_snapshots;

insert into schema_version (id, version)
values (1, '0024')
on conflict (id) do update
set version = '0024',
    updated_at = now();

alter table provider_models
  add column if not exists synced_input_usd_per_million_tokens numeric(20, 8)
    check (
      synced_input_usd_per_million_tokens is null
      or synced_input_usd_per_million_tokens >= 0
    ),
  add column if not exists synced_cached_input_usd_per_million_tokens numeric(20, 8)
    check (
      synced_cached_input_usd_per_million_tokens is null
      or synced_cached_input_usd_per_million_tokens >= 0
    ),
  add column if not exists synced_output_usd_per_million_tokens numeric(20, 8)
    check (
      synced_output_usd_per_million_tokens is null
      or synced_output_usd_per_million_tokens >= 0
    ),
  add column if not exists synced_price_source text
    check (synced_price_source is null or synced_price_source in ('models.dev', 'litellm')),
  add column if not exists synced_price_source_url text,
  add column if not exists synced_price_version text,
  add column if not exists synced_price_synced_at timestamptz,
  add column if not exists synced_price_metadata jsonb not null default '{}'::jsonb,
  add column if not exists synced_price_updated_at timestamptz;

drop table if exists provider_models_price;

insert into schema_version (id, version)
values (1, '0036')
on conflict (id) do update
set version = '0036',
    updated_at = now();

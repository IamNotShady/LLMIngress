create table if not exists price_registry_snapshots (
  id uuid primary key,
  job_id uuid references jobs (id) on delete set null,
  provider_key text not null,
  model_id text not null,
  input_usd_per_million_tokens numeric(20, 8) not null check (input_usd_per_million_tokens >= 0),
  cached_input_usd_per_million_tokens numeric(20, 8) check (
    cached_input_usd_per_million_tokens is null
    or cached_input_usd_per_million_tokens >= 0
  ),
  output_usd_per_million_tokens numeric(20, 8) not null check (
    output_usd_per_million_tokens >= 0
  ),
  source text not null,
  source_url text,
  price_version text not null,
  snapshot_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key, model_id, price_version)
);

create index if not exists idx_price_registry_snapshots_effective
  on price_registry_snapshots (provider_key, model_id, snapshot_at desc, created_at desc);

insert into schema_version (id, version)
values (1, '0014')
on conflict (id) do update
set version = '0014',
    updated_at = now();

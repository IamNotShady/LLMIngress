create table if not exists model_price_overrides (
  id uuid primary key,
  provider_key text not null,
  model_id text not null,
  input_usd_per_million_tokens numeric(20, 8) not null check (input_usd_per_million_tokens >= 0),
  output_usd_per_million_tokens numeric(20, 8) not null check (output_usd_per_million_tokens >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key, model_id)
);

insert into schema_version (id, version)
values (1, '0005')
on conflict (id) do update
set version = '0005',
    updated_at = now();

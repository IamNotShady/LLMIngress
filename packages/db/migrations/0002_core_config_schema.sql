create table if not exists providers (
  id uuid primary key,
  provider_type text not null check (provider_type in ('api_key', 'local')),
  provider_key text not null unique,
  display_name text not null,
  base_url text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists provider_models (
  id uuid primary key,
  provider_id uuid not null references providers (id) on delete restrict,
  model_id text not null,
  display_name text not null,
  context_window integer check (context_window is null or context_window > 0),
  supports_streaming boolean not null default false,
  supports_tools boolean not null default false,
  availability text not null default 'available' check (
    availability in ('available', 'unavailable', 'not_listed', 'deprecated')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, model_id)
);

create table if not exists agents (
  id uuid primary key,
  name text not null,
  agent_type text not null check (agent_type in ('coding', 'desktop', 'terminal', 'ide', 'other')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists virtual_models (
  id uuid primary key,
  name text not null unique,
  display_name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists route_policies (
  id uuid primary key,
  virtual_model_id uuid not null unique references virtual_models (id) on delete cascade,
  strategy text not null check (strategy in ('fixed', 'cost_first', 'balanced', 'quality_first')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists route_policy_candidates (
  id uuid primary key,
  route_policy_id uuid not null references route_policies (id) on delete cascade,
  provider_model_id uuid not null references provider_models (id) on delete restrict,
  candidate_order integer not null check (candidate_order > 0),
  is_fallback boolean not null default false,
  created_at timestamptz not null default now(),
  unique (route_policy_id, candidate_order)
);

create table if not exists agent_api_keys (
  id uuid primary key,
  agent_id uuid not null references agents (id) on delete cascade,
  key_prefix text not null unique,
  key_hash text not null unique,
  default_virtual_model_id uuid references virtual_models (id) on delete restrict,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_api_key_virtual_models (
  agent_api_key_id uuid not null references agent_api_keys (id) on delete cascade,
  virtual_model_id uuid not null references virtual_models (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (agent_api_key_id, virtual_model_id)
);

create table if not exists agent_limits (
  id uuid primary key,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete cascade,
  limit_type text not null check (limit_type in ('budget', 'rpm', 'tpm', 'token')),
  period text not null check (period in ('request', 'minute', 'hour', 'day', 'week', 'month')),
  limit_value numeric(20, 6) not null check (limit_value > 0),
  unit text not null check (unit in ('requests', 'tokens', 'usd')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_api_key_id, limit_type, period)
);

create table if not exists config_versions (
  id bigserial primary key,
  version integer not null unique check (version > 0),
  source text not null check (source in ('console', 'worker', 'system', 'migration')),
  description text,
  created_at timestamptz not null default now()
);

create table if not exists config_change_events (
  id uuid primary key,
  config_version_id bigint not null references config_versions (id) on delete cascade,
  source text not null check (source in ('console', 'worker', 'system', 'migration')),
  changed_table text not null,
  changed_record_id uuid,
  created_at timestamptz not null default now()
);

insert into schema_version (id, version)
values (1, '0002')
on conflict (id) do update
set version = '0002',
    updated_at = now();

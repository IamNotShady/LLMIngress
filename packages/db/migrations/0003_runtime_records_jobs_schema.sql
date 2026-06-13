create table if not exists rate_limit_windows (
  id uuid primary key,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict,
  limit_type text not null check (limit_type in ('rpm', 'tpm', 'concurrency')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  token_count integer not null default 0 check (token_count >= 0),
  active_count integer not null default 0 check (active_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_end > window_start),
  unique (agent_api_key_id, limit_type, window_start)
);

create table if not exists budget_periods (
  id uuid primary key,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict,
  period_type text not null check (period_type in ('hour', 'day', 'week', 'month')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  cost_used_usd numeric(20, 8) not null default 0 check (cost_used_usd >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  reserved_cost_usd numeric(20, 8) not null default 0 check (reserved_cost_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end > period_start),
  unique (agent_api_key_id, period_type, period_start)
);

create unique index if not exists uq_provider_models_provider_id_id
  on provider_models (provider_id, id);

create table if not exists request_activity (
  id uuid primary key,
  request_id text not null unique,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict,
  virtual_model_id uuid references virtual_models (id) on delete restrict,
  route_policy_id uuid references route_policies (id) on delete restrict,
  provider_id uuid references providers (id) on delete restrict,
  provider_model_id uuid references provider_models (id) on delete restrict,
  agent_api_key_prefix text not null,
  protocol text not null check (
    protocol in ('chat_completions', 'responses', 'messages', 'embeddings', 'models')
  ),
  model text,
  stream boolean not null default false,
  route_reason jsonb not null default '{}'::jsonb,
  fallback_attempts jsonb not null default '[]'::jsonb,
  status text not null check (status in ('started', 'succeeded', 'failed', 'canceled')),
  error_code text,
  error_message text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint request_activity_provider_model_requires_provider check (
    provider_model_id is null or provider_id is not null
  ),
  constraint request_activity_provider_model_provider_match foreign key (
    provider_id,
    provider_model_id
  ) references provider_models (provider_id, id) on delete restrict
);

create table if not exists request_usage (
  id uuid primary key,
  request_activity_id uuid not null unique references request_activity (id) on delete cascade,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict,
  virtual_model_id uuid references virtual_models (id) on delete restrict,
  provider_model_id uuid references provider_models (id) on delete restrict,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0),
  token_source text not null check (token_source in ('provider', 'estimated', 'unavailable')),
  created_at timestamptz not null default now()
);

create table if not exists request_costs (
  id uuid primary key,
  request_activity_id uuid not null unique references request_activity (id) on delete cascade,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict,
  provider_model_id uuid references provider_models (id) on delete restrict,
  input_cost_usd numeric(20, 8) check (input_cost_usd is null or input_cost_usd >= 0),
  output_cost_usd numeric(20, 8) check (output_cost_usd is null or output_cost_usd >= 0),
  total_cost_usd numeric(20, 8) check (total_cost_usd is null or total_cost_usd >= 0),
  cost_source text not null check (cost_source in ('provider', 'estimated', 'reconciled', 'unavailable')),
  price_source text,
  price_version text,
  reconciled_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists request_savings (
  id uuid primary key,
  request_activity_id uuid not null unique references request_activity (id) on delete cascade,
  baseline_provider_model_id uuid references provider_models (id) on delete restrict,
  actual_cost_usd numeric(20, 8) check (actual_cost_usd is null or actual_cost_usd >= 0),
  baseline_cost_usd numeric(20, 8) check (baseline_cost_usd is null or baseline_cost_usd >= 0),
  savings_usd numeric(20, 8),
  savings_percent numeric(12, 6),
  price_source text,
  price_version text,
  created_at timestamptz not null default now()
);

create table if not exists fallback_events (
  id uuid primary key,
  request_activity_id uuid not null references request_activity (id) on delete cascade,
  provider_model_id uuid references provider_models (id) on delete restrict,
  attempt_order integer not null check (attempt_order > 0),
  status text not null check (status in ('failed', 'succeeded', 'skipped')),
  error_code text,
  error_message text,
  failed_before_first_byte boolean not null default false,
  created_at timestamptz not null default now(),
  unique (request_activity_id, attempt_order)
);

create table if not exists budget_reservations (
  id uuid primary key,
  agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict,
  budget_period_id uuid references budget_periods (id) on delete cascade,
  request_activity_id uuid references request_activity (id) on delete set null,
  status text not null check (status in ('pending', 'finalized', 'released', 'expired')),
  reserved_input_tokens integer not null default 0 check (reserved_input_tokens >= 0),
  reserved_output_tokens integer not null default 0 check (reserved_output_tokens >= 0),
  reserved_cost_usd numeric(20, 8) not null default 0 check (reserved_cost_usd >= 0),
  actual_total_tokens integer check (actual_total_tokens is null or actual_total_tokens >= 0),
  actual_cost_usd numeric(20, 8) check (actual_cost_usd is null or actual_cost_usd >= 0),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key,
  job_type text not null check (
    job_type in (
      'model_refresh',
      'provider_connectivity_check',
      'price_sync',
      'billing_reconciliation',
      'retention_cleanup',
      'stale_reservation_cleanup',
      'webhook_export',
      'backup'
    )
  ),
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'canceled')),
  trigger text not null check (trigger in ('manual', 'scheduled', 'system')),
  priority integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  run_after timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((lease_owner is null) = (lease_expires_at is null))
);

create table if not exists job_attempts (
  id uuid primary key,
  job_id uuid not null references jobs (id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  worker_id text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  result jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, attempt_number)
);

create table if not exists provider_health_events (
  id uuid primary key,
  provider_id uuid not null references providers (id) on delete restrict,
  provider_model_id uuid references provider_models (id) on delete restrict,
  job_id uuid references jobs (id) on delete set null,
  trigger text not null check (trigger in ('request_path', 'worker_probe', 'manual')),
  status text not null check (status in ('healthy', 'degraded', 'unhealthy', 'failed')),
  error_code text,
  error_message text,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint provider_health_events_model_provider_match foreign key (
    provider_id,
    provider_model_id
  ) references provider_models (provider_id, id) on delete restrict
);

create table if not exists provider_health_summary (
  id uuid primary key,
  provider_id uuid not null references providers (id) on delete restrict,
  provider_model_id uuid references provider_models (id) on delete restrict,
  last_event_id uuid references provider_health_events (id) on delete set null,
  status text not null check (status in ('healthy', 'degraded', 'unhealthy', 'unknown')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint provider_health_summary_model_provider_match foreign key (
    provider_id,
    provider_model_id
  ) references provider_models (provider_id, id) on delete restrict
);

create unique index if not exists uq_provider_health_summary_provider
  on provider_health_summary (provider_id)
  where provider_model_id is null;

create unique index if not exists uq_provider_health_summary_provider_model
  on provider_health_summary (provider_id, provider_model_id)
  where provider_model_id is not null;

create table if not exists gateway_runtime_status (
  id uuid primary key,
  gateway_instance_id text not null unique,
  status text not null check (status in ('starting', 'ready', 'degraded', 'stopped')),
  applied_config_version integer references config_versions (version) on delete restrict,
  target_config_version integer references config_versions (version) on delete restrict,
  last_reload_status text check (
    last_reload_status is null or last_reload_status in ('pending', 'succeeded', 'failed')
  ),
  last_reload_error text,
  last_reload_at timestamptz,
  heartbeat_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists process_heartbeats (
  id uuid primary key,
  process_type text not null check (process_type in ('gateway', 'console', 'worker')),
  process_id text not null,
  status text not null check (status in ('starting', 'running', 'stale', 'stopped')),
  heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (process_type, process_id)
);

create table if not exists runtime_errors (
  id uuid primary key,
  process_type text not null check (process_type in ('gateway', 'console', 'worker')),
  process_id text,
  request_activity_id uuid references request_activity (id) on delete set null,
  severity text not null check (severity in ('info', 'warning', 'error', 'fatal')),
  error_code text not null,
  error_message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_rate_limit_windows_agent_window
  on rate_limit_windows (agent_api_key_id, limit_type, window_start desc);

create index if not exists idx_budget_periods_agent_period
  on budget_periods (agent_api_key_id, period_type, period_start desc);

create index if not exists idx_request_activity_agent_created_at
  on request_activity (agent_api_key_id, created_at desc);

create index if not exists idx_request_activity_virtual_model_created_at
  on request_activity (virtual_model_id, created_at desc);

create index if not exists idx_request_activity_provider_model_created_at
  on request_activity (provider_model_id, created_at desc);

create index if not exists idx_request_activity_status_created_at
  on request_activity (status, created_at desc);

create index if not exists idx_request_usage_agent_created_at
  on request_usage (agent_api_key_id, created_at desc);

create index if not exists idx_request_usage_provider_model_created_at
  on request_usage (provider_model_id, created_at desc);

create index if not exists idx_request_costs_agent_created_at
  on request_costs (agent_api_key_id, created_at desc);

create index if not exists idx_request_savings_baseline_model_created_at
  on request_savings (baseline_provider_model_id, created_at desc);

create index if not exists idx_fallback_events_request_attempt
  on fallback_events (request_activity_id, attempt_order);

create index if not exists idx_budget_reservations_pending_expires_at
  on budget_reservations (expires_at)
  where status = 'pending';

create index if not exists idx_budget_reservations_agent_status
  on budget_reservations (agent_api_key_id, status, created_at desc);

create index if not exists idx_jobs_pending_run_after
  on jobs (run_after, priority desc, created_at)
  where status = 'pending';

create index if not exists idx_jobs_running_lease_expires_at
  on jobs (lease_expires_at)
  where status = 'running';

create index if not exists idx_jobs_type_status
  on jobs (job_type, status, created_at desc);

create index if not exists idx_provider_health_events_provider_observed_at
  on provider_health_events (provider_id, observed_at desc);

create index if not exists idx_provider_health_events_model_observed_at
  on provider_health_events (provider_model_id, observed_at desc);

create index if not exists idx_provider_health_summary_provider_status
  on provider_health_summary (provider_id, status, updated_at desc);

create index if not exists idx_gateway_runtime_status_heartbeat_at
  on gateway_runtime_status (heartbeat_at desc);

create index if not exists idx_process_heartbeats_type_heartbeat_at
  on process_heartbeats (process_type, heartbeat_at desc);

create index if not exists idx_runtime_errors_process_created_at
  on runtime_errors (process_type, process_id, created_at desc);

create index if not exists idx_runtime_errors_severity_created_at
  on runtime_errors (severity, created_at desc);

insert into schema_version (id, version)
values (1, '0003')
on conflict (id) do update
set version = '0003',
    updated_at = now();

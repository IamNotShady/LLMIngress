create table if not exists billing_reconciliation_runs (
  id uuid primary key,
  job_id uuid references jobs (id) on delete set null,
  trigger text not null check (trigger in ('manual', 'scheduled', 'system')),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  scanned_request_count integer not null default 0 check (scanned_request_count >= 0),
  updated_request_count integer not null default 0 check (updated_request_count >= 0),
  skipped_request_count integer not null default 0 check (skipped_request_count >= 0),
  error_code text,
  error_message text,
  started_at timestamptz not null,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists billing_reconciliation_items (
  id uuid primary key,
  run_id uuid not null references billing_reconciliation_runs (id) on delete cascade,
  request_activity_id uuid not null references request_activity (id) on delete cascade,
  request_cost_id uuid references request_costs (id) on delete set null,
  request_savings_id uuid references request_savings (id) on delete set null,
  reconciliation_source text not null check (
    reconciliation_source in ('provider_actual', 'price_data')
  ),
  status text not null check (status in ('updated', 'skipped')),
  previous_cost_source text,
  new_cost_source text,
  previous_total_cost_usd numeric(20, 8),
  new_total_cost_usd numeric(20, 8),
  previous_price_source text,
  new_price_source text,
  previous_price_version text,
  new_price_version text,
  previous_savings_usd numeric(20, 8),
  new_savings_usd numeric(20, 8),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, request_activity_id)
);

create index if not exists idx_billing_reconciliation_runs_job
  on billing_reconciliation_runs (job_id);

create index if not exists idx_billing_reconciliation_items_request
  on billing_reconciliation_items (request_activity_id, created_at desc);

insert into schema_version (id, version)
values (1, '0015')
on conflict (id) do update
set version = '0015',
    updated_at = now();

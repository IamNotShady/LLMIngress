create table if not exists webhook_deliveries (
  id uuid primary key,
  job_id uuid references jobs (id) on delete set null,
  event_type text not null check (event_type in ('request', 'fallback', 'error')),
  request_activity_id uuid references request_activity (id) on delete cascade,
  fallback_event_id uuid references fallback_events (id) on delete cascade,
  webhook_url text not null,
  status text not null check (status in ('sent', 'failed')),
  request_payload jsonb not null default '{}'::jsonb,
  response_status integer check (response_status is null or response_status between 100 and 599),
  response_body text,
  error_code text,
  error_message text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint webhook_deliveries_event_reference check (
    (event_type = 'request' and request_activity_id is not null and fallback_event_id is null)
    or (event_type = 'fallback' and request_activity_id is not null and fallback_event_id is not null)
    or (event_type = 'error' and request_activity_id is not null and fallback_event_id is null)
  )
);

create index if not exists idx_webhook_deliveries_job_created_at
  on webhook_deliveries (job_id, created_at);

create index if not exists idx_webhook_deliveries_activity_created_at
  on webhook_deliveries (request_activity_id, created_at);

insert into schema_version (id, version)
values (1, '0019')
on conflict (id) do update
set version = '0019',
    updated_at = now();

alter table jobs drop constraint if exists jobs_job_type_check;

alter table jobs
  add constraint jobs_job_type_check check (
    job_type in (
      'model_refresh',
      'provider_connectivity_check',
      'price_sync',
      'billing_reconciliation',
      'retention_cleanup',
      'stale_reservation_cleanup',
      'jsonl_export',
      'cost_report_export',
      'notification_dispatch',
      'webhook_export',
      'backup'
    )
  );

create table if not exists notification_channels (
  id uuid primary key,
  channel_type text not null check (channel_type in ('email', 'webhook')),
  display_name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notification_channels_enabled_type
  on notification_channels (enabled, channel_type, display_name);

create table if not exists notification_events (
  id uuid primary key,
  channel_id uuid not null references notification_channels (id) on delete restrict,
  event_type text not null,
  subject text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null check (
    status in ('queued', 'sending', 'retrying', 'sent', 'failed', 'canceled')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notification_events_dispatch_due
  on notification_events (status, next_attempt_at, created_at);

create table if not exists notification_deliveries (
  id uuid primary key,
  notification_event_id uuid not null references notification_events (id) on delete cascade,
  channel_id uuid not null references notification_channels (id) on delete restrict,
  channel_type text not null check (channel_type in ('email', 'webhook')),
  attempt_number integer not null check (attempt_number > 0),
  status text not null check (status in ('sent', 'failed')),
  request_payload jsonb not null default '{}'::jsonb,
  response_status integer check (response_status is null or response_status between 100 and 599),
  response_body text,
  error_code text,
  error_message text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (notification_event_id, attempt_number)
);

create index if not exists idx_notification_deliveries_event_created_at
  on notification_deliveries (notification_event_id, created_at);

insert into schema_version (id, version)
values (1, '0018')
on conflict (id) do update
set version = '0018',
    updated_at = now();

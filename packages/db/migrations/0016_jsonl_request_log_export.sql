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
      'webhook_export',
      'backup'
    )
  );

create table if not exists export_tasks (
  id uuid primary key,
  job_id uuid unique references jobs (id) on delete set null,
  export_type text not null check (export_type in ('jsonl_request_logs')),
  status text not null check (status in ('succeeded', 'failed')),
  output_path text not null,
  line_count integer not null default 0 check (line_count >= 0),
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_export_tasks_type_created_at
  on export_tasks (export_type, created_at desc);

insert into schema_version (id, version)
values (1, '0016')
on conflict (id) do update
set version = '0016',
    updated_at = now();

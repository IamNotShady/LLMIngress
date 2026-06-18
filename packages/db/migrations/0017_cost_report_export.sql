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
      'webhook_export',
      'backup'
    )
  );

alter table export_tasks drop constraint if exists export_tasks_export_type_check;

alter table export_tasks
  add constraint export_tasks_export_type_check check (
    export_type in ('jsonl_request_logs', 'cost_report')
  );

insert into schema_version (id, version)
values (1, '0017')
on conflict (id) do update
set version = '0017',
    updated_at = now();

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
      'backup',
      'budget_threshold_alerts',
      'rate_limit_alerts',
      'provider_failure_alerts',
      'fallback_exhaustion_alerts'
    )
  );

insert into schema_version (id, version)
values (1, '0023')
on conflict (id) do update
set version = '0023',
    updated_at = now();

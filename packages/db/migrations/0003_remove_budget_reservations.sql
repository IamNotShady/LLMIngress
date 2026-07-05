delete from jobs
where job_type = 'stale_reservation_cleanup';

alter table jobs drop constraint jobs_job_type_check;

alter table jobs add constraint jobs_job_type_check check (
  job_type = any (array[
    'model_refresh',
    'provider_connectivity_check',
    'price_sync',
    'billing_reconciliation',
    'retention_cleanup',
    'jsonl_export',
    'cost_report_export',
    'notification_dispatch',
    'webhook_export',
    'backup',
    'budget_threshold_alerts',
    'rate_limit_alerts',
    'provider_failure_alerts',
    'fallback_exhaustion_alerts',
    'stale_concurrency_reconcile'
  ]::text[])
);

drop table if exists budget_reservations;

alter table budget_periods
  drop column if exists reserved_tokens,
  drop column if exists reserved_cost_usd;

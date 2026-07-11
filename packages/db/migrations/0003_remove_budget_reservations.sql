delete from jobs
where job_type not in ('model_refresh', 'provider_connectivity_check', 'price_sync');

alter table jobs drop constraint jobs_job_type_check;

alter table jobs add constraint jobs_job_type_check check (
  job_type = any (array[
    'model_refresh',
    'provider_connectivity_check',
    'price_sync'
  ]::text[])
);

drop table if exists budget_reservations;

alter table budget_periods
  drop column if exists reserved_tokens,
  drop column if exists reserved_cost_usd;

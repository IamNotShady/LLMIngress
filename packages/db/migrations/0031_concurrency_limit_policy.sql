alter table agent_limits
  drop constraint if exists agent_limits_limit_type_check;

alter table agent_limits
  add constraint agent_limits_limit_type_check
  check (limit_type in ('budget', 'concurrency', 'rpm', 'tpm', 'token'));

alter table agent_limits
  add column if not exists alert_threshold numeric(20, 6),
  add column if not exists enforcement_policy text not null default 'block',
  add column if not exists manual_bypass boolean not null default false;

alter table agent_limits
  drop constraint if exists agent_limits_alert_threshold_check,
  drop constraint if exists agent_limits_enforcement_policy_check,
  drop constraint if exists agent_limits_concurrency_period_unit_check;

alter table agent_limits
  add constraint agent_limits_alert_threshold_check
  check (alert_threshold is null or alert_threshold > 0),
  add constraint agent_limits_enforcement_policy_check
  check (enforcement_policy in ('block', 'warn_only')),
  add constraint agent_limits_concurrency_period_unit_check
  check (
    limit_type <> 'concurrency'
    or (period = 'request' and unit = 'requests')
  );

insert into schema_version (id, version)
values (1, '0031')
on conflict (id) do update
set version = '0031',
    updated_at = now();

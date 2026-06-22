alter table provider_health_events
  drop constraint if exists provider_health_events_status_check;

alter table provider_health_summary
  drop constraint if exists provider_health_summary_status_check;

update provider_health_events
set status = 'unhealthy'
where status in ('degraded', 'failed');

update provider_health_summary
set status = 'unhealthy'
where status = 'degraded';

alter table provider_health_events
  add constraint provider_health_events_status_check
  check (status in ('healthy', 'unhealthy', 'auth_failed', 'quota_limited', 'network_error'));

alter table provider_health_summary
  add constraint provider_health_summary_status_check
  check (status in ('unknown', 'healthy', 'unhealthy', 'auth_failed', 'quota_limited', 'network_error'));

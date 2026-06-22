alter table provider_api_keys
  drop constraint if exists provider_api_keys_last_test_status_check;

alter table provider_api_keys
  alter column last_test_status set default 'unknown';

update provider_api_keys
set last_test_status = 'unknown'
where last_test_status = 'untested';

update provider_api_keys
set last_test_status = 'unhealthy'
where last_test_status = 'failed';

alter table provider_api_keys
  add constraint provider_api_keys_last_test_status_check check (
    last_test_status in ('unknown', 'healthy', 'unhealthy', 'auth_failed', 'quota_limited', 'network_error')
  );

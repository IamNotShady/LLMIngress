alter table fallback_events
  add column if not exists retryable boolean,
  add column if not exists status_code integer;

alter table request_activity
  drop column if exists fallback_attempts;

alter table notification_events
add column if not exists delivery_owner text;

alter table notification_events
add column if not exists delivery_expires_at timestamp with time zone;

do $$
begin
  alter table notification_events
  add constraint notification_events_delivery_lease_check
  check ((delivery_owner is null) = (delivery_expires_at is null));
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_notification_events_sending_delivery_expires_at
on notification_events (delivery_expires_at, updated_at)
where status = 'sending';

create index if not exists idx_request_activity_started_at_id
  on request_activity (started_at desc, id desc);

create index if not exists idx_request_activity_virtual_model_started_at
  on request_activity (virtual_model_id, started_at desc, id desc);

create index if not exists idx_request_activity_route_policy_started_at
  on request_activity (route_policy_id, started_at desc, id desc);

insert into schema_version (id, version)
values (1, '0029')
on conflict (id) do update
set version = '0029',
    updated_at = now();

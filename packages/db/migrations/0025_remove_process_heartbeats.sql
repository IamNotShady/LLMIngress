drop index if exists idx_process_heartbeats_type_heartbeat_at;
drop table if exists process_heartbeats;

insert into schema_version (id, version)
values (1, '0025')
on conflict (id) do update
set version = '0025',
    updated_at = now();

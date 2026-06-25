truncate table agents cascade;

drop table if exists agent_api_key_virtual_models cascade;
drop table if exists agent_api_keys cascade;

insert into schema_version (id, version)
values (1, '0032')
on conflict (id) do update
set version = '0032',
    updated_at = now();

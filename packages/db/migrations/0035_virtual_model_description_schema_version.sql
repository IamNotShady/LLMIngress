insert into schema_version (id, version)
values (1, '0035')
on conflict (id) do update
set version = '0035',
    updated_at = now();

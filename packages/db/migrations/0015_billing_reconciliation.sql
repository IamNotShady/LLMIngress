insert into schema_version (id, version)
values (1, '0015')
on conflict (id) do update
set version = '0015',
    updated_at = now();

alter table providers
  drop constraint if exists providers_provider_key_key;

insert into schema_version (id, version)
values (1, '0033')
on conflict (id) do update
set version = '0033',
    updated_at = now();

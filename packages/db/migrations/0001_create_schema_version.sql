create table if not exists migration_history (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);

create table if not exists schema_version (
  id integer primary key check (id = 1),
  version text not null,
  updated_at timestamptz not null default now()
);

insert into schema_version (id, version)
values (1, '0001')
on conflict (id) do update
set version = excluded.version,
    updated_at = now();

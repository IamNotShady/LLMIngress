create table if not exists console_admins (
  id smallint primary key check (id = 1),
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists console_sessions (
  id uuid primary key,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_console_sessions_expires_at
  on console_sessions (expires_at);

insert into schema_version (id, version)
values (1, '0004')
on conflict (id) do update
set version = '0004',
    updated_at = now();

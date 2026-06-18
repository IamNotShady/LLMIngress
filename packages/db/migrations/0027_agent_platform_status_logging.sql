alter table agents
  add column if not exists integration_platform text not null default 'other';

alter table agents
  add column if not exists request_logging_enabled boolean not null default true;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agents_integration_platform_check'
  ) then
    alter table agents
      add constraint agents_integration_platform_check check (
        integration_platform in (
          'codex',
          'claude-code',
          'cursor',
          'opencode',
          'hermes',
          'openclaw',
          'github-copilot',
          'other'
        )
      );
  end if;
end $$;

alter table request_activity
  add column if not exists request_metadata jsonb not null default '{}'::jsonb;

insert into schema_version (id, version)
values (1, '0027')
on conflict (id) do update
set version = '0027',
    updated_at = now();

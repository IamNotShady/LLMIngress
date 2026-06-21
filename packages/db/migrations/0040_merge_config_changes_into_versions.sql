alter table config_versions
  add column if not exists changes jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'config_versions_changes_array'
  ) then
    alter table config_versions
      add constraint config_versions_changes_array check (jsonb_typeof(changes) = 'array');
  end if;
end $$;

update config_versions
set changes = coalesce(config_changes.changes, '[]'::jsonb)
from (
  select
    config_version_id,
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'id', id::text,
          'source', source,
          'table', changed_table,
          'recordId', changed_record_id::text,
          'createdAt', created_at
        )
      )
      order by created_at, id
    ) as changes
  from config_change_events
  group by config_version_id
) as config_changes
where config_versions.id = config_changes.config_version_id;

drop table if exists config_change_events;

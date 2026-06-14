alter table providers
  add column if not exists provider_template_id text;

do $$
begin
  alter table providers
    add constraint providers_template_id_whitelisted
    check (
      provider_template_id is null
      or provider_template_id in ('deepseek')
    );
exception
  when duplicate_object then null;
end $$;

insert into schema_version (id, version)
values (1, '0007')
on conflict (id) do update
set version = '0007',
    updated_at = now();

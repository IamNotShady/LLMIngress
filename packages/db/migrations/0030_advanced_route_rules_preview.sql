alter table route_policies
  add column if not exists rules jsonb not null default '{}'::jsonb;

alter table route_policies
  drop constraint if exists route_policies_rules_object_check;

alter table route_policies
  add constraint route_policies_rules_object_check
  check (jsonb_typeof(rules) = 'object');

alter table provider_models
  add column if not exists capability_metadata jsonb not null default '{}'::jsonb;

alter table provider_models
  drop constraint if exists provider_models_capability_metadata_object_check;

alter table provider_models
  add constraint provider_models_capability_metadata_object_check
  check (jsonb_typeof(capability_metadata) = 'object');

insert into schema_version (id, version)
values (1, '0030')
on conflict (id) do update
set version = '0030',
    updated_at = now();

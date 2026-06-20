alter table agents
  add column if not exists deleted_at timestamptz;

alter table providers
  add column if not exists deleted_at timestamptz;

alter table provider_models
  add column if not exists deleted_at timestamptz;

alter table virtual_models
  add column if not exists deleted_at timestamptz;

alter table route_policies
  add column if not exists deleted_at timestamptz;

alter table request_activity
  add column if not exists agent_name_snapshot text,
  add column if not exists virtual_model_name_snapshot text,
  add column if not exists route_policy_strategy_snapshot text,
  add column if not exists provider_key_snapshot text,
  add column if not exists provider_display_name_snapshot text,
  add column if not exists provider_model_name_snapshot text,
  add column if not exists provider_model_display_name_snapshot text;

alter table virtual_models
  drop constraint if exists virtual_models_name_key;

create unique index if not exists idx_virtual_models_name_active
  on virtual_models (name)
  where deleted_at is null;

alter table route_policies
  drop constraint if exists route_policies_virtual_model_id_key;

create unique index if not exists idx_route_policies_virtual_model_active
  on route_policies (virtual_model_id)
  where deleted_at is null;

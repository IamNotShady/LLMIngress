alter table request_activity
  add column if not exists provider_api_key_id uuid references provider_api_keys (id) on delete set null;

alter table request_activity
  add column if not exists provider_api_key_prefix text;

alter table request_activity
  add column if not exists response_metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_request_activity_status_started_at
  on request_activity (status, started_at desc, id desc);

create index if not exists idx_request_activity_protocol_started_at
  on request_activity (protocol, started_at desc, id desc);

create index if not exists idx_request_activity_provider_started_at
  on request_activity (provider_id, provider_model_id, started_at desc, id desc);

create index if not exists idx_request_activity_agent_key_started_at
  on request_activity (agent_api_key_id, started_at desc, id desc);

insert into schema_version (id, version)
values (1, '0028')
on conflict (id) do update
set version = '0028',
    updated_at = now();

alter table providers
  drop constraint if exists providers_provider_type_check;

alter table providers
  add constraint providers_provider_type_check check (
    provider_type in ('api_key', 'local', 'subscription')
  );

create table if not exists provider_oauth (
  id uuid primary key,
  provider_id uuid not null references providers(id) on delete cascade,
  label text check (label is null or char_length(label) <= 100),
  priority integer not null default 100 check (priority >= 0 and priority <= 100),
  enabled boolean not null default true,
  pending_state text,
  pending_code_verifier text,
  pending_code_challenge text,
  pending_expires_at timestamptz,
  encrypted_token jsonb check (encrypted_token is null or jsonb_typeof(encrypted_token) = 'object'),
  token_expires_at timestamptz,
  last_test_status text not null default 'unknown',
  last_tested_at timestamptz,
  last_test_error_code text,
  last_test_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (pending_expires_at is null or pending_state is not null),
  check (encrypted_token is not null or completed_at is null),
  check (last_test_status in ('unknown', 'healthy', 'unhealthy', 'auth_failed', 'quota_limited', 'network_error'))
);

create index if not exists provider_oauth_provider_enabled_priority_idx
  on provider_oauth (provider_id, enabled, priority asc, created_at asc, id asc);

create unique index if not exists provider_oauth_pending_state_key
  on provider_oauth (pending_state)
  where pending_state is not null;

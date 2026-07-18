-- Move route-policy value enforcement out of the database: the code layer
-- (routePolicyStrategies / isRoutePolicyStrategy) is the single source of truth.
alter table public.route_policies
  drop constraint if exists route_policies_strategy_check;

-- Rename the stored strategy identifier: random -> load_balance.
update public.route_policies
  set strategy = 'load_balance'
  where strategy = 'random';

-- Backfill historical activity so the console renders "Load Balance" for old rows.
update public.request_activity
  set route_policy_strategy_snapshot = 'load_balance'
  where route_policy_strategy_snapshot = 'random';

update public.request_activity
  set route_reason = jsonb_set(route_reason, '{strategy}', '"load_balance"'::jsonb)
  where route_reason ->> 'strategy' = 'random';

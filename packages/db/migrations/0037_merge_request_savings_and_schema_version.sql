alter table request_costs
  add column if not exists baseline_provider_model_id uuid references provider_models (id) on delete restrict,
  add column if not exists actual_cost_usd numeric(20, 8)
    check (actual_cost_usd is null or actual_cost_usd >= 0),
  add column if not exists baseline_cost_usd numeric(20, 8)
    check (baseline_cost_usd is null or baseline_cost_usd >= 0),
  add column if not exists savings_usd numeric(20, 8),
  add column if not exists savings_percent numeric(12, 6),
  add column if not exists savings_price_source text,
  add column if not exists savings_price_version text;

update request_costs
set baseline_provider_model_id = request_savings.baseline_provider_model_id,
    actual_cost_usd = request_savings.actual_cost_usd,
    baseline_cost_usd = request_savings.baseline_cost_usd,
    savings_usd = request_savings.savings_usd,
    savings_percent = request_savings.savings_percent,
    savings_price_source = request_savings.price_source,
    savings_price_version = request_savings.price_version
from request_savings
where request_savings.request_activity_id = request_costs.request_activity_id;

drop index if exists idx_request_savings_baseline_model_created_at;
drop table if exists request_savings;
drop table if exists schema_version;

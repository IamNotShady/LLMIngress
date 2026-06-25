alter table route_policies
  drop constraint if exists route_policies_strategy_check;

update route_policies
set strategy = 'random'
where strategy = 'balanced';

alter table route_policies
  add constraint route_policies_strategy_check
  check (strategy in ('fixed', 'cost_first', 'quality_first', 'random'));

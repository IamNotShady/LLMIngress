-- Collapse primary/fallback into one contiguous candidate_order pool, then drop the flag.
-- Phase 1: shift every candidate_order into a disjoint high range (stays > 0).
update route_policy_candidates
set candidate_order = candidate_order + 1000000;

-- Phase 2: renumber to a contiguous 1..N pool, primaries first then fallbacks.
with ordered as (
  select id,
         row_number() over (
           partition by route_policy_id
           order by is_fallback, candidate_order, id
         ) as new_order
  from route_policy_candidates
)
update route_policy_candidates rpc
set candidate_order = ordered.new_order
from ordered
where ordered.id = rpc.id;

alter table route_policy_candidates drop column is_fallback;

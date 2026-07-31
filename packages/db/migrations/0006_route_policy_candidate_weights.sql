--
-- Weighted route strategy: a candidate carries the share of primary traffic it
-- receives, as a two-decimal fraction of 1 (0.00-1.00). The column is a
-- nullable numeric(3,2): NULL means "this policy's strategy does not route by
-- weight", while 0.00 is a real configuration - a candidate that takes no
-- primary traffic and exists only as a fallback target. A NOT NULL default
-- would conflate those two states.
--
-- The cross-row invariant (the weights of one policy sum to exactly 1.00)
-- stays in the application layer: candidate writes are a single
-- delete-and-rewrite transaction holding the route_policies row lock, and a
-- sum rule spanning rows is not expressible as an ordinary constraint. The
-- per-row range is a schema fact and is checked here.
--

ALTER TABLE public.route_policy_candidates
    ADD COLUMN weight numeric(3,2);

ALTER TABLE public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_weight_range_check
        CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1));

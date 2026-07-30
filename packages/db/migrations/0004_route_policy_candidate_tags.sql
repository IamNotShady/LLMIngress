--
-- Tag route strategy: a candidate carries the tags a client may name through
-- the route tag request header. Tags live on the candidate row rather than in a
-- side table because one candidate holds many tags and the whole candidate set
-- is rewritten as one unit on every save.
--
-- The cross-row invariants (a tag is unique inside one policy, and exactly one
-- candidate carries 'default') stay in the application layer: candidate writes
-- are a single delete-and-rewrite transaction holding the route_policies row
-- lock, and a uniqueness rule spanning rows of a text[] column is not
-- expressible as an ordinary constraint.
--

ALTER TABLE public.route_policy_candidates
    ADD COLUMN tags text[] DEFAULT '{}'::text[] NOT NULL;

ALTER TABLE public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_tags_no_null_check
        CHECK (array_position(tags, NULL::text) IS NULL),
    ADD CONSTRAINT route_policy_candidates_tags_cardinality_check
        CHECK (cardinality(tags) <= 32);

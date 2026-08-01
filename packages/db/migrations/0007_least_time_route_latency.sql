--
-- Least-time routing: route_latency_stats holds one decayed latency average
-- (EWMA) per provider model and metric. 'ttfb' is the first-byte latency of a
-- streaming attempt (connect + headers + first chunk); 'total' is the full
-- duration of a non-streaming provider call. They stay separate rows because
-- mixing the two would let a stream-heavy candidate look ten times faster
-- than a JSON-heavy one on the same route.
--
-- The gateway keeps the live counters in memory and flushes dirty rows on an
-- interval and once at shutdown, so a restart reseeds the ordering instead of
-- starting cold. Rows are last-writer-wins: the deployment runs one gateway
-- instance, and a lost flush only costs recent decay, never correctness.
-- There is no foreign key, matching the schema-wide convention.
--
-- fallback_events.duration_ms and request_activity.ttfb_ms are observability
-- companions: how long each provider attempt ran, and the first-byte latency
-- of the attempt a streaming request was actually served from.
--

CREATE TABLE public.route_latency_stats (
    provider_model_id uuid NOT NULL,
    metric text NOT NULL,
    ewma_ms double precision NOT NULL,
    sample_count bigint DEFAULT 0 NOT NULL,
    last_sample_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_latency_stats_metric_check CHECK ((metric = ANY (ARRAY['ttfb'::text, 'total'::text]))),
    CONSTRAINT route_latency_stats_ewma_ms_check CHECK ((ewma_ms >= (0)::double precision)),
    CONSTRAINT route_latency_stats_sample_count_check CHECK ((sample_count >= 0))
);

ALTER TABLE ONLY public.route_latency_stats
    ADD CONSTRAINT route_latency_stats_pkey PRIMARY KEY (provider_model_id, metric);

ALTER TABLE public.fallback_events
    ADD COLUMN duration_ms integer;
ALTER TABLE public.fallback_events
    ADD CONSTRAINT fallback_events_duration_ms_check
        CHECK (((duration_ms IS NULL) OR (duration_ms >= 0)));

ALTER TABLE public.request_activity
    ADD COLUMN ttfb_ms integer;
ALTER TABLE public.request_activity
    ADD CONSTRAINT request_activity_ttfb_ms_check
        CHECK (((ttfb_ms IS NULL) OR (ttfb_ms >= 0)));

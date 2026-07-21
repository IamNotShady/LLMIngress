--
-- Provider quota observation: per-connection upstream balance and
-- usage-window utilization. See docs/PROVIDER_QUOTA.md.
--

ALTER TABLE public.provider_api_keys
    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL;

ALTER TABLE public.provider_oauth
    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL;

ALTER TABLE public.jobs
    DROP CONSTRAINT jobs_job_type_check;

ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_job_type_check CHECK ((job_type = ANY (ARRAY['model_refresh'::text, 'provider_connection_probe'::text, 'price_sync'::text, 'provider_quota_probe'::text])));

CREATE TABLE public.provider_quota_summary (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_connection_id uuid NOT NULL,
    entries jsonb DEFAULT '[]'::jsonb NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    next_refresh_at timestamp with time zone,
    error_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_quota_summary_entries_check CHECK ((jsonb_typeof(entries) = 'array'::text)),
    CONSTRAINT provider_quota_summary_error_code_check CHECK (((error_code IS NULL) OR (error_code = ANY (ARRAY['not_supported'::text, 'requires_separate_credential'::text, 'probe_failed'::text, 'unauthorized'::text]))))
);

ALTER TABLE ONLY public.provider_quota_summary
    ADD CONSTRAINT provider_quota_summary_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX uq_provider_quota_summary_connection ON public.provider_quota_summary USING btree (provider_id, provider_connection_id);

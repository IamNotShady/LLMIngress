--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_key_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key_limits (
    id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    limit_type text NOT NULL,
    period text NOT NULL,
    limit_value numeric(20,6) NOT NULL,
    unit text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    enforcement_policy text DEFAULT 'block'::text NOT NULL,
    manual_bypass boolean DEFAULT false NOT NULL,
    CONSTRAINT api_key_limits_concurrency_period_unit_check CHECK (((limit_type <> 'concurrency'::text) OR ((period = 'request'::text) AND (unit = 'requests'::text)))),
    CONSTRAINT api_key_limits_enforcement_policy_check CHECK ((enforcement_policy = ANY (ARRAY['block'::text, 'warn_only'::text]))),
    CONSTRAINT api_key_limits_limit_type_check CHECK ((limit_type = ANY (ARRAY['budget'::text, 'concurrency'::text, 'rpm'::text, 'tpm'::text, 'token'::text]))),
    CONSTRAINT api_key_limits_limit_value_check CHECK ((limit_value > (0)::numeric)),
    CONSTRAINT api_key_limits_period_check CHECK ((period = ANY (ARRAY['request'::text, 'minute'::text, 'hour'::text, 'day'::text, 'week'::text, 'month'::text]))),
    CONSTRAINT api_key_limits_unit_check CHECK ((unit = ANY (ARRAY['requests'::text, 'tokens'::text, 'usd'::text])))
);


--
-- Name: api_key_virtual_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key_virtual_models (
    api_key_id uuid NOT NULL,
    virtual_model_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid NOT NULL,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    default_virtual_model_id uuid,
    enabled boolean DEFAULT true NOT NULL,
    limits_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: budget_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_periods (
    id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    period_type text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    tokens_used bigint DEFAULT 0 NOT NULL,
    cost_used_usd numeric(20,8) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT budget_periods_check CHECK ((period_end > period_start)),
    CONSTRAINT budget_periods_cost_used_usd_check CHECK ((cost_used_usd >= (0)::numeric)),
    CONSTRAINT budget_periods_period_type_check CHECK ((period_type = ANY (ARRAY['hour'::text, 'day'::text, 'week'::text, 'month'::text]))),
    CONSTRAINT budget_periods_tokens_used_check CHECK ((tokens_used >= 0))
);


--
-- Name: config_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_versions (
    id bigint NOT NULL,
    version integer NOT NULL,
    source text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    changes jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT config_versions_changes_array CHECK ((jsonb_typeof(changes) = 'array'::text)),
    CONSTRAINT config_versions_source_check CHECK ((source = ANY (ARRAY['console'::text, 'worker'::text, 'system'::text, 'migration'::text]))),
    CONSTRAINT config_versions_version_check CHECK ((version > 0))
);


--
-- Name: config_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.config_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: config_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.config_versions_id_seq OWNED BY public.config_versions.id;


--
-- Name: console_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.console_admins (
    id smallint NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT console_admins_id_check CHECK ((id = 1))
);


--
-- Name: console_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.console_sessions (
    id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fallback_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fallback_events (
    id uuid NOT NULL,
    request_activity_id uuid NOT NULL,
    provider_model_id uuid,
    attempt_order integer NOT NULL,
    status text NOT NULL,
    error_code text,
    error_message text,
    failed_before_first_byte boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_api_key_id uuid,
    provider_api_key_prefix text,
    retryable boolean,
    status_code integer,
    CONSTRAINT fallback_events_attempt_order_check CHECK ((attempt_order > 0)),
    CONSTRAINT fallback_events_status_check CHECK ((status = ANY (ARRAY['failed'::text, 'succeeded'::text, 'skipped'::text])))
);


--
-- Name: job_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_attempts (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    worker_id text NOT NULL,
    status text NOT NULL,
    result jsonb,
    error_code text,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT job_attempts_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT job_attempts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    job_type text NOT NULL,
    status text NOT NULL,
    trigger text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    error_code text,
    error_message text,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT jobs_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT jobs_job_type_check CHECK ((job_type = ANY (ARRAY['model_refresh'::text, 'provider_connection_probe'::text, 'price_sync'::text, 'provider_quota_probe'::text]))),
    CONSTRAINT jobs_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT jobs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'scheduled'::text, 'system'::text])))
);


--
-- Name: provider_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_api_keys (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    key_prefix text NOT NULL,
    encrypted_key jsonb NOT NULL,
    key_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label text,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    quota_probe_enabled boolean DEFAULT true NOT NULL,
    last_used_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT provider_api_keys_check CHECK (((rotated_at IS NULL) OR (rotated_at >= created_at))),
    CONSTRAINT provider_api_keys_encrypted_key_check CHECK ((jsonb_typeof(encrypted_key) = 'object'::text)),
    CONSTRAINT provider_api_keys_key_id_check CHECK ((length(key_id) > 0)),
    CONSTRAINT provider_api_keys_key_prefix_check CHECK ((length(key_prefix) > 0)),
    CONSTRAINT provider_api_keys_priority_check CHECK ((priority >= 0))
);


--
-- Name: provider_health_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_health_events (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_connection_id uuid NOT NULL,
    job_id uuid,
    trigger text NOT NULL,
    status text NOT NULL,
    error_code text,
    error_message text,
    latency_ms integer,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT provider_health_events_latency_ms_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT provider_health_events_status_check CHECK ((status = ANY (ARRAY['healthy'::text, 'unhealthy'::text]))),
    CONSTRAINT provider_health_events_trigger_check CHECK ((trigger = ANY (ARRAY['worker_probe'::text, 'manual'::text])))
);


--
-- Name: provider_health_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_health_summary (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_connection_id uuid NOT NULL,
    last_event_id uuid,
    status text DEFAULT 'unhealthy'::text NOT NULL,
    consecutive_failures integer DEFAULT 1 NOT NULL,
    last_failure_at timestamp with time zone,
    reason_code text,
    reason_message text,
    next_probe_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_health_summary_consecutive_failures_check CHECK ((consecutive_failures > 0)),
    CONSTRAINT provider_health_summary_status_check CHECK ((status = 'unhealthy'::text))
);


--
-- Name: provider_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_models (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    model_id text NOT NULL,
    display_name text NOT NULL,
    context_window integer,
    supports_streaming boolean DEFAULT false NOT NULL,
    supports_function_calling boolean,
    availability text DEFAULT 'available'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    manual_input_usd_per_million_tokens numeric(20,8),
    manual_cached_input_usd_per_million_tokens numeric(20,8),
    manual_output_usd_per_million_tokens numeric(20,8),
    manual_price_updated_at timestamp with time zone,
    capability_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    synced_input_usd_per_million_tokens numeric(20,8),
    synced_cached_input_usd_per_million_tokens numeric(20,8),
    synced_output_usd_per_million_tokens numeric(20,8),
    synced_price_source text,
    synced_price_source_url text,
    synced_price_version text,
    synced_price_synced_at timestamp with time zone,
    synced_price_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    synced_price_updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    input_modalities text[],
    output_modalities text[],
    max_output_tokens integer,
    supports_reasoning boolean,
    CONSTRAINT provider_models_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'unavailable'::text, 'not_listed'::text, 'deprecated'::text]))),
    CONSTRAINT provider_models_capability_metadata_object_check CHECK ((jsonb_typeof(capability_metadata) = 'object'::text)),
    CONSTRAINT provider_models_context_window_check CHECK (((context_window IS NULL) OR (context_window > 0))),
    CONSTRAINT provider_models_input_modalities_nonempty_check CHECK (((input_modalities IS NULL) OR (cardinality(input_modalities) > 0))),
    CONSTRAINT provider_models_input_modalities_values_check CHECK (((input_modalities IS NULL) OR (input_modalities <@ ARRAY['text'::text, 'image'::text, 'audio'::text, 'video'::text, 'document'::text]))),
    CONSTRAINT provider_models_manual_cached_input_usd_per_million_token_check CHECK (((manual_cached_input_usd_per_million_tokens IS NULL) OR (manual_cached_input_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_manual_input_usd_per_million_tokens_check CHECK (((manual_input_usd_per_million_tokens IS NULL) OR (manual_input_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_manual_output_usd_per_million_tokens_check CHECK (((manual_output_usd_per_million_tokens IS NULL) OR (manual_output_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_max_output_tokens_check CHECK (((max_output_tokens IS NULL) OR (max_output_tokens > 0))),
    CONSTRAINT provider_models_output_modalities_nonempty_check CHECK (((output_modalities IS NULL) OR (cardinality(output_modalities) > 0))),
    CONSTRAINT provider_models_output_modalities_values_check CHECK (((output_modalities IS NULL) OR (output_modalities <@ ARRAY['text'::text, 'image'::text, 'audio'::text, 'video'::text, 'embedding'::text]))),
    CONSTRAINT provider_models_synced_cached_input_usd_per_million_token_check CHECK (((synced_cached_input_usd_per_million_tokens IS NULL) OR (synced_cached_input_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_synced_input_usd_per_million_tokens_check CHECK (((synced_input_usd_per_million_tokens IS NULL) OR (synced_input_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_synced_output_usd_per_million_tokens_check CHECK (((synced_output_usd_per_million_tokens IS NULL) OR (synced_output_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_synced_price_source_check CHECK (((synced_price_source IS NULL) OR (synced_price_source = ANY (ARRAY['models.dev'::text, 'litellm'::text]))))
);


--
-- Name: provider_oauth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_oauth (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    label text,
    priority integer DEFAULT 100 NOT NULL,
    quota_probe_enabled boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    pending_state text,
    pending_code_verifier text,
    pending_code_challenge text,
    pending_expires_at timestamp with time zone,
    encrypted_token jsonb,
    token_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT provider_oauth_check CHECK (((pending_expires_at IS NULL) OR (pending_state IS NOT NULL))),
    CONSTRAINT provider_oauth_check1 CHECK (((encrypted_token IS NOT NULL) OR (completed_at IS NULL))),
    CONSTRAINT provider_oauth_encrypted_token_check CHECK (((encrypted_token IS NULL) OR (jsonb_typeof(encrypted_token) = 'object'::text))),
    CONSTRAINT provider_oauth_label_check CHECK (((label IS NULL) OR (char_length(label) <= 100))),
    CONSTRAINT provider_oauth_priority_check CHECK (((priority >= 0) AND (priority <= 100)))
);


--
-- Name: provider_quota_summary; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.providers (
    id uuid NOT NULL,
    provider_type text NOT NULL,
    provider_key text NOT NULL,
    display_name text NOT NULL,
    base_url text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_template_id text,
    deleted_at timestamp with time zone,
    CONSTRAINT providers_provider_type_check CHECK ((provider_type = ANY (ARRAY['api_key'::text, 'local'::text, 'subscription'::text])))
);


--
-- Name: rate_limit_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_windows (
    id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    limit_type text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    token_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_limit_windows_active_count_check CHECK ((active_count >= 0)),
    CONSTRAINT rate_limit_windows_check CHECK ((window_end > window_start)),
    CONSTRAINT rate_limit_windows_limit_type_check CHECK ((limit_type = ANY (ARRAY['rpm'::text, 'tpm'::text, 'concurrency'::text]))),
    CONSTRAINT rate_limit_windows_request_count_check CHECK ((request_count >= 0)),
    CONSTRAINT rate_limit_windows_token_count_check CHECK ((token_count >= 0))
);


--
-- Name: request_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_activity (
    id uuid NOT NULL,
    request_id text NOT NULL,
    api_key_id uuid NOT NULL,
    virtual_model_id uuid,
    route_policy_id uuid,
    provider_id uuid,
    provider_model_id uuid,
    api_key_prefix text NOT NULL,
    protocol text NOT NULL,
    model text,
    stream boolean DEFAULT false NOT NULL,
    route_reason jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    error_code text,
    error_message text,
    http_status integer,
    latency_ms integer,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_api_key_id uuid,
    provider_api_key_prefix text,
    response_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    api_key_name_snapshot text,
    virtual_model_name_snapshot text,
    route_policy_strategy_snapshot text,
    provider_key_snapshot text,
    provider_display_name_snapshot text,
    provider_model_name_snapshot text,
    provider_model_display_name_snapshot text,
    CONSTRAINT request_activity_http_status_check CHECK (((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599)))),
    CONSTRAINT request_activity_latency_ms_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT request_activity_protocol_check CHECK ((protocol = ANY (ARRAY['chat_completions'::text, 'responses'::text, 'messages'::text, 'models'::text]))),
    CONSTRAINT request_activity_provider_model_requires_provider CHECK (((provider_model_id IS NULL) OR (provider_id IS NOT NULL))),
    CONSTRAINT request_activity_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))
);


--
-- Name: request_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_costs (
    id uuid NOT NULL,
    request_activity_id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    provider_model_id uuid,
    input_cost_usd numeric(20,8),
    output_cost_usd numeric(20,8),
    total_cost_usd numeric(20,8),
    cost_source text NOT NULL,
    price_source text,
    price_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_costs_cost_source_check CHECK ((cost_source = ANY (ARRAY['provider'::text, 'estimated'::text, 'reconciled'::text, 'unavailable'::text]))),
    CONSTRAINT request_costs_input_cost_usd_check CHECK (((input_cost_usd IS NULL) OR (input_cost_usd >= (0)::numeric))),
    CONSTRAINT request_costs_output_cost_usd_check CHECK (((output_cost_usd IS NULL) OR (output_cost_usd >= (0)::numeric))),
    CONSTRAINT request_costs_total_cost_usd_check CHECK (((total_cost_usd IS NULL) OR (total_cost_usd >= (0)::numeric)))
);


--
-- Name: request_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_usage (
    id uuid NOT NULL,
    request_activity_id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    virtual_model_id uuid,
    provider_model_id uuid,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    cached_input_tokens integer DEFAULT 0 NOT NULL,
    reasoning_tokens integer DEFAULT 0 NOT NULL,
    token_source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_usage_cached_input_tokens_check CHECK ((cached_input_tokens >= 0)),
    CONSTRAINT request_usage_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT request_usage_output_tokens_check CHECK ((output_tokens >= 0)),
    CONSTRAINT request_usage_reasoning_tokens_check CHECK ((reasoning_tokens >= 0)),
    CONSTRAINT request_usage_token_source_check CHECK ((token_source = ANY (ARRAY['provider'::text, 'estimated'::text, 'unavailable'::text]))),
    CONSTRAINT request_usage_total_tokens_check CHECK ((total_tokens >= 0))
);


--
-- Name: route_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_policies (
    id uuid NOT NULL,
    virtual_model_id uuid NOT NULL,
    strategy text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    endpoint_protocol text NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT route_policies_endpoint_protocol_check CHECK ((endpoint_protocol = ANY (ARRAY['chat_completions'::text, 'responses'::text, 'messages'::text])))
);


--
-- Name: route_policy_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_policy_candidates (
    id uuid NOT NULL,
    route_policy_id uuid NOT NULL,
    provider_model_id uuid NOT NULL,
    candidate_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_policy_candidates_candidate_order_check CHECK ((candidate_order > 0))
);


--
-- Name: virtual_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.virtual_models (
    id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: config_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_versions ALTER COLUMN id SET DEFAULT nextval('public.config_versions_id_seq'::regclass);


--
-- Name: api_key_limits api_key_limits_api_key_id_limit_type_period_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_limits
    ADD CONSTRAINT api_key_limits_api_key_id_limit_type_period_key UNIQUE (api_key_id, limit_type, period);


--
-- Name: api_key_limits api_key_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_limits
    ADD CONSTRAINT api_key_limits_pkey PRIMARY KEY (id);


--
-- Name: api_key_virtual_models api_key_virtual_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_virtual_models
    ADD CONSTRAINT api_key_virtual_models_pkey PRIMARY KEY (api_key_id, virtual_model_id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_key_prefix_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_prefix_key UNIQUE (key_prefix);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: budget_periods budget_periods_api_key_id_period_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_api_key_id_period_type_period_start_key UNIQUE (api_key_id, period_type, period_start);


--
-- Name: budget_periods budget_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_pkey PRIMARY KEY (id);


--
-- Name: config_versions config_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_versions
    ADD CONSTRAINT config_versions_pkey PRIMARY KEY (id);


--
-- Name: config_versions config_versions_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_versions
    ADD CONSTRAINT config_versions_version_key UNIQUE (version);


--
-- Name: console_admins console_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.console_admins
    ADD CONSTRAINT console_admins_pkey PRIMARY KEY (id);


--
-- Name: console_sessions console_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.console_sessions
    ADD CONSTRAINT console_sessions_pkey PRIMARY KEY (id);


--
-- Name: console_sessions console_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.console_sessions
    ADD CONSTRAINT console_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: fallback_events fallback_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fallback_events
    ADD CONSTRAINT fallback_events_pkey PRIMARY KEY (id);


--
-- Name: fallback_events fallback_events_request_activity_id_attempt_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fallback_events
    ADD CONSTRAINT fallback_events_request_activity_id_attempt_order_key UNIQUE (request_activity_id, attempt_order);


--
-- Name: job_attempts job_attempts_job_id_attempt_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_job_id_attempt_number_key UNIQUE (job_id, attempt_number);


--
-- Name: job_attempts job_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: provider_api_keys provider_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_api_keys
    ADD CONSTRAINT provider_api_keys_pkey PRIMARY KEY (id);


--
-- Name: provider_health_events provider_health_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_events
    ADD CONSTRAINT provider_health_events_pkey PRIMARY KEY (id);


--
-- Name: provider_health_summary provider_health_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_summary
    ADD CONSTRAINT provider_health_summary_pkey PRIMARY KEY (id);


--
-- Name: provider_models provider_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_models
    ADD CONSTRAINT provider_models_pkey PRIMARY KEY (id);


--
-- Name: provider_models provider_models_provider_id_model_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_models
    ADD CONSTRAINT provider_models_provider_id_model_id_key UNIQUE (provider_id, model_id);


--
-- Name: provider_oauth provider_oauth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_oauth
    ADD CONSTRAINT provider_oauth_pkey PRIMARY KEY (id);


--
-- Name: provider_quota_summary provider_quota_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_quota_summary
    ADD CONSTRAINT provider_quota_summary_pkey PRIMARY KEY (id);


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_windows rate_limit_windows_api_key_id_limit_type_window_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_api_key_id_limit_type_window_start_key UNIQUE (api_key_id, limit_type, window_start);


--
-- Name: rate_limit_windows rate_limit_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_pkey PRIMARY KEY (id);


--
-- Name: request_activity request_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_pkey PRIMARY KEY (id);


--
-- Name: request_activity request_activity_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_request_id_key UNIQUE (request_id);


--
-- Name: request_costs request_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_costs
    ADD CONSTRAINT request_costs_pkey PRIMARY KEY (id);


--
-- Name: request_costs request_costs_request_activity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_costs
    ADD CONSTRAINT request_costs_request_activity_id_key UNIQUE (request_activity_id);


--
-- Name: request_usage request_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_usage
    ADD CONSTRAINT request_usage_pkey PRIMARY KEY (id);


--
-- Name: request_usage request_usage_request_activity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_usage
    ADD CONSTRAINT request_usage_request_activity_id_key UNIQUE (request_activity_id);


--
-- Name: route_policies route_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policies
    ADD CONSTRAINT route_policies_pkey PRIMARY KEY (id);


--
-- Name: route_policy_candidates route_policy_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_pkey PRIMARY KEY (id);


--
-- Name: route_policy_candidates route_policy_candidates_route_policy_id_candidate_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_route_policy_id_candidate_order_key UNIQUE (route_policy_id, candidate_order);


--
-- Name: route_policy_candidates route_policy_candidates_route_policy_id_provider_model_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_route_policy_id_provider_model_id_key UNIQUE (route_policy_id, provider_model_id);


--
-- Name: virtual_models virtual_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.virtual_models
    ADD CONSTRAINT virtual_models_pkey PRIMARY KEY (id);


--
-- Name: idx_budget_periods_api_key_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_periods_api_key_period ON public.budget_periods USING btree (api_key_id, period_type, period_start DESC);


--
-- Name: idx_console_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_console_sessions_expires_at ON public.console_sessions USING btree (expires_at);


--
-- Name: idx_fallback_events_request_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fallback_events_request_attempt ON public.fallback_events USING btree (request_activity_id, attempt_order);


--
-- Name: idx_jobs_pending_run_after; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_pending_run_after ON public.jobs USING btree (run_after, priority DESC, created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_jobs_running_lease_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_running_lease_expires_at ON public.jobs USING btree (lease_expires_at) WHERE (status = 'running'::text);


--
-- Name: idx_jobs_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_type_status ON public.jobs USING btree (job_type, status, created_at DESC);


--
-- Name: idx_provider_api_keys_last_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_api_keys_last_used_at ON public.provider_api_keys USING btree (last_used_at DESC);


--
-- Name: idx_provider_api_keys_provider_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_api_keys_provider_created_at ON public.provider_api_keys USING btree (provider_id, created_at, id);


--
-- Name: idx_provider_api_keys_provider_enabled_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_api_keys_provider_enabled_priority ON public.provider_api_keys USING btree (provider_id, enabled, priority, created_at, id);


--
-- Name: idx_provider_api_keys_provider_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_api_keys_provider_updated_at ON public.provider_api_keys USING btree (provider_id, updated_at DESC);


--
-- Name: idx_provider_health_events_connection_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_health_events_connection_observed_at ON public.provider_health_events USING btree (provider_connection_id, observed_at DESC);


--
-- Name: uq_provider_health_events_job; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_health_events_job ON public.provider_health_events USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: idx_provider_health_events_provider_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_health_events_provider_observed_at ON public.provider_health_events USING btree (provider_id, observed_at DESC);


--
-- Name: idx_provider_health_summary_provider_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_health_summary_provider_status ON public.provider_health_summary USING btree (provider_id, status, updated_at DESC);


--
-- Name: idx_rate_limit_windows_api_key_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limit_windows_api_key_window ON public.rate_limit_windows USING btree (api_key_id, limit_type, window_start DESC);


--
-- Name: idx_request_activity_api_key_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_api_key_created_at ON public.request_activity USING btree (api_key_id, created_at DESC);


--
-- Name: idx_request_activity_api_key_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_api_key_started_at ON public.request_activity USING btree (api_key_id, started_at DESC, id DESC);


--
-- Name: idx_request_activity_protocol_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_protocol_started_at ON public.request_activity USING btree (protocol, started_at DESC, id DESC);


--
-- Name: idx_request_activity_provider_model_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_provider_model_created_at ON public.request_activity USING btree (provider_model_id, created_at DESC);


--
-- Name: idx_request_activity_provider_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_provider_started_at ON public.request_activity USING btree (provider_id, provider_model_id, started_at DESC, id DESC);


--
-- Name: idx_request_activity_route_policy_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_route_policy_started_at ON public.request_activity USING btree (route_policy_id, started_at DESC, id DESC);


--
-- Name: idx_request_activity_started_at_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_started_at_id ON public.request_activity USING btree (started_at DESC, id DESC);


--
-- Name: idx_request_activity_status_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_status_created_at ON public.request_activity USING btree (status, created_at DESC);


--
-- Name: idx_request_activity_status_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_status_started_at ON public.request_activity USING btree (status, started_at DESC, id DESC);


--
-- Name: idx_request_activity_virtual_model_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_virtual_model_created_at ON public.request_activity USING btree (virtual_model_id, created_at DESC);


--
-- Name: idx_request_activity_virtual_model_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_virtual_model_started_at ON public.request_activity USING btree (virtual_model_id, started_at DESC, id DESC);


--
-- Name: idx_request_costs_api_key_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_costs_api_key_created_at ON public.request_costs USING btree (api_key_id, created_at DESC);


--
-- Name: idx_request_usage_api_key_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_usage_api_key_created_at ON public.request_usage USING btree (api_key_id, created_at DESC);


--
-- Name: idx_request_usage_provider_model_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_usage_provider_model_created_at ON public.request_usage USING btree (provider_model_id, created_at DESC);


--
-- Name: idx_route_policies_virtual_model_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_route_policies_virtual_model_active ON public.route_policies USING btree (virtual_model_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_route_policy_candidates_provider_model_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_policy_candidates_provider_model_id ON public.route_policy_candidates USING btree (provider_model_id);


--
-- Name: idx_virtual_models_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_virtual_models_name_active ON public.virtual_models USING btree (name) WHERE (deleted_at IS NULL);


--
-- Name: provider_oauth_pending_state_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_oauth_pending_state_key ON public.provider_oauth USING btree (pending_state) WHERE (pending_state IS NOT NULL);


--
-- Name: provider_oauth_provider_enabled_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_oauth_provider_enabled_priority_idx ON public.provider_oauth USING btree (provider_id, enabled, priority, created_at, id);


--
-- Name: uq_provider_health_summary_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_health_summary_connection ON public.provider_health_summary USING btree (provider_id, provider_connection_id);


--
-- Name: uq_provider_models_provider_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_models_provider_id_id ON public.provider_models USING btree (provider_id, id);


--
-- Name: uq_provider_quota_summary_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_quota_summary_connection ON public.provider_quota_summary USING btree (provider_id, provider_connection_id);


--
-- PostgreSQL database dump complete
--

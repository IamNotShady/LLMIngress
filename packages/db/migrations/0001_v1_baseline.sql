--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

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
-- Name: agent_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_limits (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    limit_type text NOT NULL,
    period text NOT NULL,
    limit_value numeric(20,6) NOT NULL,
    unit text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    alert_threshold numeric(20,6),
    enforcement_policy text DEFAULT 'block'::text NOT NULL,
    manual_bypass boolean DEFAULT false NOT NULL,
    CONSTRAINT agent_limits_alert_threshold_check CHECK (((alert_threshold IS NULL) OR (alert_threshold > (0)::numeric))),
    CONSTRAINT agent_limits_concurrency_period_unit_check CHECK (((limit_type <> 'concurrency'::text) OR ((period = 'request'::text) AND (unit = 'requests'::text)))),
    CONSTRAINT agent_limits_enforcement_policy_check CHECK ((enforcement_policy = ANY (ARRAY['block'::text, 'warn_only'::text]))),
    CONSTRAINT agent_limits_limit_type_check CHECK ((limit_type = ANY (ARRAY['budget'::text, 'concurrency'::text, 'rpm'::text, 'tpm'::text, 'token'::text]))),
    CONSTRAINT agent_limits_limit_value_check CHECK ((limit_value > (0)::numeric)),
    CONSTRAINT agent_limits_period_check CHECK ((period = ANY (ARRAY['request'::text, 'minute'::text, 'hour'::text, 'day'::text, 'week'::text, 'month'::text]))),
    CONSTRAINT agent_limits_unit_check CHECK ((unit = ANY (ARRAY['requests'::text, 'tokens'::text, 'usd'::text])))
);


--
-- Name: agent_virtual_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_virtual_models (
    agent_id uuid NOT NULL,
    virtual_model_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid NOT NULL,
    name text NOT NULL,
    key_prefix text,
    key_hash text,
    default_virtual_model_id uuid,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    integration_platform text DEFAULT 'other'::text NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT agents_integration_platform_check CHECK ((integration_platform = ANY (ARRAY['codex'::text, 'claude-code'::text, 'cursor'::text, 'opencode'::text, 'hermes'::text, 'openclaw'::text, 'github-copilot'::text, 'other'::text])))
);


--
-- Name: budget_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_periods (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    period_type text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    tokens_used bigint DEFAULT 0 NOT NULL,
    cost_used_usd numeric(20,8) DEFAULT 0 NOT NULL,
    reserved_tokens bigint DEFAULT 0 NOT NULL,
    reserved_cost_usd numeric(20,8) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT budget_periods_check CHECK ((period_end > period_start)),
    CONSTRAINT budget_periods_cost_used_usd_check CHECK ((cost_used_usd >= (0)::numeric)),
    CONSTRAINT budget_periods_period_type_check CHECK ((period_type = ANY (ARRAY['hour'::text, 'day'::text, 'week'::text, 'month'::text]))),
    CONSTRAINT budget_periods_reserved_cost_usd_check CHECK ((reserved_cost_usd >= (0)::numeric)),
    CONSTRAINT budget_periods_reserved_tokens_check CHECK ((reserved_tokens >= 0)),
    CONSTRAINT budget_periods_tokens_used_check CHECK ((tokens_used >= 0))
);


--
-- Name: budget_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_reservations (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    budget_period_id uuid,
    request_activity_id uuid,
    status text NOT NULL,
    reserved_input_tokens integer DEFAULT 0 NOT NULL,
    reserved_output_tokens integer DEFAULT 0 NOT NULL,
    reserved_cost_usd numeric(20,8) DEFAULT 0 NOT NULL,
    actual_total_tokens integer,
    actual_cost_usd numeric(20,8),
    expires_at timestamp with time zone NOT NULL,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT budget_reservations_actual_cost_usd_check CHECK (((actual_cost_usd IS NULL) OR (actual_cost_usd >= (0)::numeric))),
    CONSTRAINT budget_reservations_actual_total_tokens_check CHECK (((actual_total_tokens IS NULL) OR (actual_total_tokens >= 0))),
    CONSTRAINT budget_reservations_reserved_cost_usd_check CHECK ((reserved_cost_usd >= (0)::numeric)),
    CONSTRAINT budget_reservations_reserved_input_tokens_check CHECK ((reserved_input_tokens >= 0)),
    CONSTRAINT budget_reservations_reserved_output_tokens_check CHECK ((reserved_output_tokens >= 0)),
    CONSTRAINT budget_reservations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'finalized'::text, 'released'::text, 'expired'::text])))
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
    CONSTRAINT fallback_events_attempt_order_check CHECK ((attempt_order > 0)),
    CONSTRAINT fallback_events_status_check CHECK ((status = ANY (ARRAY['failed'::text, 'succeeded'::text, 'skipped'::text])))
);


--
-- Name: gateway_runtime_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gateway_runtime_status (
    id uuid NOT NULL,
    gateway_instance_id text NOT NULL,
    status text NOT NULL,
    applied_config_version integer,
    target_config_version integer,
    last_reload_status text,
    last_reload_error text,
    last_reload_at timestamp with time zone,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gateway_runtime_status_last_reload_status_check CHECK (((last_reload_status IS NULL) OR (last_reload_status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))),
    CONSTRAINT gateway_runtime_status_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'ready'::text, 'degraded'::text, 'stopped'::text])))
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
    CONSTRAINT jobs_job_type_check CHECK ((job_type = ANY (ARRAY['model_refresh'::text, 'provider_connectivity_check'::text, 'price_sync'::text, 'billing_reconciliation'::text, 'retention_cleanup'::text, 'stale_reservation_cleanup'::text, 'jsonl_export'::text, 'cost_report_export'::text, 'notification_dispatch'::text, 'webhook_export'::text, 'backup'::text, 'budget_threshold_alerts'::text, 'rate_limit_alerts'::text, 'provider_failure_alerts'::text, 'fallback_exhaustion_alerts'::text]))),
    CONSTRAINT jobs_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT jobs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'scheduled'::text, 'system'::text])))
);


--
-- Name: notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_channels (
    id uuid NOT NULL,
    channel_type text NOT NULL,
    display_name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_channels_channel_type_check CHECK ((channel_type = ANY (ARRAY['email'::text, 'webhook'::text])))
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id uuid NOT NULL,
    notification_event_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    channel_type text NOT NULL,
    attempt_number integer NOT NULL,
    status text NOT NULL,
    request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_status integer,
    response_body text,
    error_code text,
    error_message text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_deliveries_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT notification_deliveries_channel_type_check CHECK ((channel_type = ANY (ARRAY['email'::text, 'webhook'::text]))),
    CONSTRAINT notification_deliveries_response_status_check CHECK (((response_status IS NULL) OR ((response_status >= 100) AND (response_status <= 599)))),
    CONSTRAINT notification_deliveries_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text])))
);


--
-- Name: notification_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_events (
    id uuid NOT NULL,
    channel_id uuid NOT NULL,
    event_type text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT notification_events_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT notification_events_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'retrying'::text, 'sent'::text, 'failed'::text, 'canceled'::text])))
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
    last_used_at timestamp with time zone,
    last_tested_at timestamp with time zone,
    last_test_status text DEFAULT 'unknown'::text NOT NULL,
    last_test_error_code text,
    last_test_error_message text,
    CONSTRAINT provider_api_keys_check CHECK (((rotated_at IS NULL) OR (rotated_at >= created_at))),
    CONSTRAINT provider_api_keys_encrypted_key_check CHECK ((jsonb_typeof(encrypted_key) = 'object'::text)),
    CONSTRAINT provider_api_keys_key_id_check CHECK ((length(key_id) > 0)),
    CONSTRAINT provider_api_keys_key_prefix_check CHECK ((length(key_prefix) > 0)),
    CONSTRAINT provider_api_keys_last_test_status_check CHECK ((last_test_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'unhealthy'::text, 'auth_failed'::text, 'quota_limited'::text, 'network_error'::text]))),
    CONSTRAINT provider_api_keys_priority_check CHECK ((priority >= 0))
);


--
-- Name: provider_health_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_health_events (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_model_id uuid,
    job_id uuid,
    trigger text NOT NULL,
    status text NOT NULL,
    error_code text,
    error_message text,
    latency_ms integer,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT provider_health_events_latency_ms_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT provider_health_events_status_check CHECK ((status = ANY (ARRAY['healthy'::text, 'unhealthy'::text, 'auth_failed'::text, 'quota_limited'::text, 'network_error'::text]))),
    CONSTRAINT provider_health_events_trigger_check CHECK ((trigger = ANY (ARRAY['request_path'::text, 'worker_probe'::text, 'manual'::text])))
);


--
-- Name: provider_health_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_health_summary (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_model_id uuid,
    last_event_id uuid,
    status text NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_health_summary_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT provider_health_summary_status_check CHECK ((status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'unhealthy'::text, 'auth_failed'::text, 'quota_limited'::text, 'network_error'::text])))
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
    supports_tools boolean DEFAULT false NOT NULL,
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
    CONSTRAINT provider_models_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'unavailable'::text, 'not_listed'::text, 'deprecated'::text]))),
    CONSTRAINT provider_models_capability_metadata_object_check CHECK ((jsonb_typeof(capability_metadata) = 'object'::text)),
    CONSTRAINT provider_models_context_window_check CHECK (((context_window IS NULL) OR (context_window > 0))),
    CONSTRAINT provider_models_manual_cached_input_usd_per_million_token_check CHECK (((manual_cached_input_usd_per_million_tokens IS NULL) OR (manual_cached_input_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_manual_input_usd_per_million_tokens_check CHECK (((manual_input_usd_per_million_tokens IS NULL) OR (manual_input_usd_per_million_tokens >= (0)::numeric))),
    CONSTRAINT provider_models_manual_output_usd_per_million_tokens_check CHECK (((manual_output_usd_per_million_tokens IS NULL) OR (manual_output_usd_per_million_tokens >= (0)::numeric))),
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
    enabled boolean DEFAULT true NOT NULL,
    pending_state text,
    pending_code_verifier text,
    pending_code_challenge text,
    pending_expires_at timestamp with time zone,
    encrypted_token jsonb,
    token_expires_at timestamp with time zone,
    last_test_status text DEFAULT 'unknown'::text NOT NULL,
    last_tested_at timestamp with time zone,
    last_test_error_code text,
    last_test_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT provider_oauth_check CHECK (((pending_expires_at IS NULL) OR (pending_state IS NOT NULL))),
    CONSTRAINT provider_oauth_check1 CHECK (((encrypted_token IS NOT NULL) OR (completed_at IS NULL))),
    CONSTRAINT provider_oauth_encrypted_token_check CHECK (((encrypted_token IS NULL) OR (jsonb_typeof(encrypted_token) = 'object'::text))),
    CONSTRAINT provider_oauth_label_check CHECK (((label IS NULL) OR (char_length(label) <= 100))),
    CONSTRAINT provider_oauth_last_test_status_check CHECK ((last_test_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'unhealthy'::text, 'auth_failed'::text, 'quota_limited'::text, 'network_error'::text]))),
    CONSTRAINT provider_oauth_priority_check CHECK (((priority >= 0) AND (priority <= 100)))
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
    agent_id uuid NOT NULL,
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
    agent_id uuid NOT NULL,
    virtual_model_id uuid,
    route_policy_id uuid,
    provider_id uuid,
    provider_model_id uuid,
    agent_key_prefix text NOT NULL,
    protocol text NOT NULL,
    model text,
    stream boolean DEFAULT false NOT NULL,
    route_reason jsonb DEFAULT '{}'::jsonb NOT NULL,
    fallback_attempts jsonb DEFAULT '[]'::jsonb NOT NULL,
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
    agent_name_snapshot text,
    virtual_model_name_snapshot text,
    route_policy_strategy_snapshot text,
    provider_key_snapshot text,
    provider_display_name_snapshot text,
    provider_model_name_snapshot text,
    provider_model_display_name_snapshot text,
    CONSTRAINT request_activity_http_status_check CHECK (((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599)))),
    CONSTRAINT request_activity_latency_ms_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT request_activity_protocol_check CHECK ((protocol = ANY (ARRAY['chat_completions'::text, 'responses'::text, 'messages'::text, 'embeddings'::text, 'models'::text]))),
    CONSTRAINT request_activity_provider_model_requires_provider CHECK (((provider_model_id IS NULL) OR (provider_id IS NOT NULL))),
    CONSTRAINT request_activity_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))
);


--
-- Name: request_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_costs (
    id uuid NOT NULL,
    request_activity_id uuid NOT NULL,
    agent_id uuid NOT NULL,
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
    agent_id uuid NOT NULL,
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
    CONSTRAINT route_policies_endpoint_protocol_check CHECK ((endpoint_protocol = ANY (ARRAY['chat_completions'::text, 'responses'::text, 'messages'::text, 'embeddings'::text]))),
    CONSTRAINT route_policies_strategy_check CHECK ((strategy = ANY (ARRAY['fixed'::text, 'cost_first'::text, 'random'::text])))
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
-- Name: runtime_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runtime_errors (
    id uuid NOT NULL,
    process_type text NOT NULL,
    process_id text,
    request_activity_id uuid,
    severity text NOT NULL,
    error_code text NOT NULL,
    error_message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_errors_process_type_check CHECK ((process_type = ANY (ARRAY['gateway'::text, 'console'::text, 'worker'::text]))),
    CONSTRAINT runtime_errors_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text, 'fatal'::text])))
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
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid NOT NULL,
    job_id uuid,
    event_type text NOT NULL,
    request_activity_id uuid,
    fallback_event_id uuid,
    webhook_url text NOT NULL,
    status text NOT NULL,
    request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_status integer,
    response_body text,
    error_code text,
    error_message text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_deliveries_event_reference CHECK ((((event_type = 'request'::text) AND (request_activity_id IS NOT NULL) AND (fallback_event_id IS NULL)) OR ((event_type = 'fallback'::text) AND (request_activity_id IS NOT NULL) AND (fallback_event_id IS NOT NULL)) OR ((event_type = 'error'::text) AND (request_activity_id IS NOT NULL) AND (fallback_event_id IS NULL)))),
    CONSTRAINT webhook_deliveries_event_type_check CHECK ((event_type = ANY (ARRAY['request'::text, 'fallback'::text, 'error'::text]))),
    CONSTRAINT webhook_deliveries_response_status_check CHECK (((response_status IS NULL) OR ((response_status >= 100) AND (response_status <= 599)))),
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text])))
);


--
-- Name: config_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_versions ALTER COLUMN id SET DEFAULT nextval('public.config_versions_id_seq'::regclass);


--
-- Name: agent_limits agent_limits_agent_id_limit_type_period_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_limits
    ADD CONSTRAINT agent_limits_agent_id_limit_type_period_key UNIQUE (agent_id, limit_type, period);


--
-- Name: agent_limits agent_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_limits
    ADD CONSTRAINT agent_limits_pkey PRIMARY KEY (id);


--
-- Name: agent_virtual_models agent_virtual_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_virtual_models
    ADD CONSTRAINT agent_virtual_models_pkey PRIMARY KEY (agent_id, virtual_model_id);


--
-- Name: agents agents_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_key_hash_key UNIQUE (key_hash);


--
-- Name: agents agents_key_prefix_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_key_prefix_key UNIQUE (key_prefix);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: budget_periods budget_periods_agent_id_period_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_agent_id_period_type_period_start_key UNIQUE (agent_id, period_type, period_start);


--
-- Name: budget_periods budget_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_pkey PRIMARY KEY (id);


--
-- Name: budget_reservations budget_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_pkey PRIMARY KEY (id);


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
-- Name: gateway_runtime_status gateway_runtime_status_gateway_instance_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_runtime_status
    ADD CONSTRAINT gateway_runtime_status_gateway_instance_id_key UNIQUE (gateway_instance_id);


--
-- Name: gateway_runtime_status gateway_runtime_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_runtime_status
    ADD CONSTRAINT gateway_runtime_status_pkey PRIMARY KEY (id);


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
-- Name: notification_channels notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_notification_event_id_attempt_numbe_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_event_id_attempt_numbe_key UNIQUE (notification_event_id, attempt_number);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_events notification_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_pkey PRIMARY KEY (id);


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
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);


--
-- Name: providers providers_template_id_whitelisted; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.providers
    ADD CONSTRAINT providers_template_id_whitelisted CHECK (((provider_template_id IS NULL) OR (provider_template_id = ANY (ARRAY['deepseek'::text, 'xai'::text, 'qwen'::text, 'moonshot'::text, 'minimax'::text, 'zai'::text, 'ollama'::text, 'lmstudio'::text, 'llama_cpp'::text, 'openrouter'::text, 'google'::text, 'openai_codex'::text, 'claude_code'::text])))) NOT VALID;


--
-- Name: rate_limit_windows rate_limit_windows_agent_id_limit_type_window_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_agent_id_limit_type_window_start_key UNIQUE (agent_id, limit_type, window_start);


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
-- Name: runtime_errors runtime_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runtime_errors
    ADD CONSTRAINT runtime_errors_pkey PRIMARY KEY (id);


--
-- Name: virtual_models virtual_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.virtual_models
    ADD CONSTRAINT virtual_models_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: idx_budget_periods_agent_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_periods_agent_period ON public.budget_periods USING btree (agent_id, period_type, period_start DESC);


--
-- Name: idx_budget_reservations_agent_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_reservations_agent_status ON public.budget_reservations USING btree (agent_id, status, created_at DESC);


--
-- Name: idx_budget_reservations_pending_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_reservations_pending_expires_at ON public.budget_reservations USING btree (expires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_console_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_console_sessions_expires_at ON public.console_sessions USING btree (expires_at);


--
-- Name: idx_fallback_events_request_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fallback_events_request_attempt ON public.fallback_events USING btree (request_activity_id, attempt_order);


--
-- Name: idx_gateway_runtime_status_heartbeat_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gateway_runtime_status_heartbeat_at ON public.gateway_runtime_status USING btree (heartbeat_at DESC);


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
-- Name: idx_notification_channels_enabled_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_enabled_type ON public.notification_channels USING btree (enabled, channel_type, display_name);


--
-- Name: idx_notification_deliveries_event_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_deliveries_event_created_at ON public.notification_deliveries USING btree (notification_event_id, created_at);


--
-- Name: idx_notification_events_dispatch_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_events_dispatch_due ON public.notification_events USING btree (status, next_attempt_at, created_at);


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
-- Name: idx_provider_health_events_model_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_health_events_model_observed_at ON public.provider_health_events USING btree (provider_model_id, observed_at DESC);


--
-- Name: idx_provider_health_events_provider_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_health_events_provider_observed_at ON public.provider_health_events USING btree (provider_id, observed_at DESC);


--
-- Name: idx_provider_health_summary_provider_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_health_summary_provider_status ON public.provider_health_summary USING btree (provider_id, status, updated_at DESC);


--
-- Name: idx_rate_limit_windows_agent_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limit_windows_agent_window ON public.rate_limit_windows USING btree (agent_id, limit_type, window_start DESC);


--
-- Name: idx_request_activity_agent_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_agent_created_at ON public.request_activity USING btree (agent_id, created_at DESC);


--
-- Name: idx_request_activity_agent_key_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_activity_agent_key_started_at ON public.request_activity USING btree (agent_id, started_at DESC, id DESC);


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
-- Name: idx_request_costs_agent_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_costs_agent_created_at ON public.request_costs USING btree (agent_id, created_at DESC);


--
-- Name: idx_request_usage_agent_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_usage_agent_created_at ON public.request_usage USING btree (agent_id, created_at DESC);


--
-- Name: idx_request_usage_provider_model_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_request_usage_provider_model_created_at ON public.request_usage USING btree (provider_model_id, created_at DESC);


--
-- Name: idx_route_policies_virtual_model_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_route_policies_virtual_model_active ON public.route_policies USING btree (virtual_model_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_runtime_errors_process_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runtime_errors_process_created_at ON public.runtime_errors USING btree (process_type, process_id, created_at DESC);


--
-- Name: idx_runtime_errors_severity_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runtime_errors_severity_created_at ON public.runtime_errors USING btree (severity, created_at DESC);


--
-- Name: idx_virtual_models_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_virtual_models_name_active ON public.virtual_models USING btree (name) WHERE (deleted_at IS NULL);


--
-- Name: idx_webhook_deliveries_activity_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_activity_created_at ON public.webhook_deliveries USING btree (request_activity_id, created_at);


--
-- Name: idx_webhook_deliveries_job_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_job_created_at ON public.webhook_deliveries USING btree (job_id, created_at);


--
-- Name: provider_oauth_pending_state_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_oauth_pending_state_key ON public.provider_oauth USING btree (pending_state) WHERE (pending_state IS NOT NULL);


--
-- Name: provider_oauth_provider_enabled_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_oauth_provider_enabled_priority_idx ON public.provider_oauth USING btree (provider_id, enabled, priority, created_at, id);


--
-- Name: uq_provider_health_summary_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_health_summary_provider ON public.provider_health_summary USING btree (provider_id) WHERE (provider_model_id IS NULL);


--
-- Name: uq_provider_health_summary_provider_model; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_health_summary_provider_model ON public.provider_health_summary USING btree (provider_id, provider_model_id) WHERE (provider_model_id IS NOT NULL);


--
-- Name: uq_provider_models_provider_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_provider_models_provider_id_id ON public.provider_models USING btree (provider_id, id);


--
-- Name: agent_limits agent_limits_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_limits
    ADD CONSTRAINT agent_limits_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_virtual_models agent_virtual_models_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_virtual_models
    ADD CONSTRAINT agent_virtual_models_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_virtual_models agent_virtual_models_virtual_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_virtual_models
    ADD CONSTRAINT agent_virtual_models_virtual_model_id_fkey FOREIGN KEY (virtual_model_id) REFERENCES public.virtual_models(id) ON DELETE RESTRICT;


--
-- Name: agents agents_default_virtual_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_default_virtual_model_id_fkey FOREIGN KEY (default_virtual_model_id) REFERENCES public.virtual_models(id) ON DELETE RESTRICT;


--
-- Name: budget_periods budget_periods_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: budget_reservations budget_reservations_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: budget_reservations budget_reservations_budget_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_budget_period_id_fkey FOREIGN KEY (budget_period_id) REFERENCES public.budget_periods(id) ON DELETE CASCADE;


--
-- Name: budget_reservations budget_reservations_request_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_request_activity_id_fkey FOREIGN KEY (request_activity_id) REFERENCES public.request_activity(id) ON DELETE SET NULL;


--
-- Name: fallback_events fallback_events_provider_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fallback_events
    ADD CONSTRAINT fallback_events_provider_api_key_id_fkey FOREIGN KEY (provider_api_key_id) REFERENCES public.provider_api_keys(id) ON DELETE SET NULL;


--
-- Name: fallback_events fallback_events_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fallback_events
    ADD CONSTRAINT fallback_events_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: fallback_events fallback_events_request_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fallback_events
    ADD CONSTRAINT fallback_events_request_activity_id_fkey FOREIGN KEY (request_activity_id) REFERENCES public.request_activity(id) ON DELETE CASCADE;


--
-- Name: gateway_runtime_status gateway_runtime_status_applied_config_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_runtime_status
    ADD CONSTRAINT gateway_runtime_status_applied_config_version_fkey FOREIGN KEY (applied_config_version) REFERENCES public.config_versions(version) ON DELETE RESTRICT;


--
-- Name: gateway_runtime_status gateway_runtime_status_target_config_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_runtime_status
    ADD CONSTRAINT gateway_runtime_status_target_config_version_fkey FOREIGN KEY (target_config_version) REFERENCES public.config_versions(version) ON DELETE RESTRICT;


--
-- Name: job_attempts job_attempts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.notification_channels(id) ON DELETE RESTRICT;


--
-- Name: notification_deliveries notification_deliveries_notification_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_event_id_fkey FOREIGN KEY (notification_event_id) REFERENCES public.notification_events(id) ON DELETE CASCADE;


--
-- Name: notification_events notification_events_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.notification_channels(id) ON DELETE RESTRICT;


--
-- Name: provider_api_keys provider_api_keys_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_api_keys
    ADD CONSTRAINT provider_api_keys_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: provider_health_events provider_health_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_events
    ADD CONSTRAINT provider_health_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: provider_health_events provider_health_events_model_provider_match; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_events
    ADD CONSTRAINT provider_health_events_model_provider_match FOREIGN KEY (provider_id, provider_model_id) REFERENCES public.provider_models(provider_id, id) ON DELETE RESTRICT;


--
-- Name: provider_health_events provider_health_events_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_events
    ADD CONSTRAINT provider_health_events_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT;


--
-- Name: provider_health_events provider_health_events_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_events
    ADD CONSTRAINT provider_health_events_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: provider_health_summary provider_health_summary_last_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_summary
    ADD CONSTRAINT provider_health_summary_last_event_id_fkey FOREIGN KEY (last_event_id) REFERENCES public.provider_health_events(id) ON DELETE SET NULL;


--
-- Name: provider_health_summary provider_health_summary_model_provider_match; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_summary
    ADD CONSTRAINT provider_health_summary_model_provider_match FOREIGN KEY (provider_id, provider_model_id) REFERENCES public.provider_models(provider_id, id) ON DELETE RESTRICT;


--
-- Name: provider_health_summary provider_health_summary_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_summary
    ADD CONSTRAINT provider_health_summary_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT;


--
-- Name: provider_health_summary provider_health_summary_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_summary
    ADD CONSTRAINT provider_health_summary_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: provider_models provider_models_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_models
    ADD CONSTRAINT provider_models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT;


--
-- Name: provider_oauth provider_oauth_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_oauth
    ADD CONSTRAINT provider_oauth_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: rate_limit_windows rate_limit_windows_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: request_activity request_activity_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: request_activity request_activity_provider_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_provider_api_key_id_fkey FOREIGN KEY (provider_api_key_id) REFERENCES public.provider_api_keys(id) ON DELETE SET NULL;


--
-- Name: request_activity request_activity_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT;


--
-- Name: request_activity request_activity_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: request_activity request_activity_provider_model_provider_match; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_provider_model_provider_match FOREIGN KEY (provider_id, provider_model_id) REFERENCES public.provider_models(provider_id, id) ON DELETE RESTRICT;


--
-- Name: request_activity request_activity_route_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_route_policy_id_fkey FOREIGN KEY (route_policy_id) REFERENCES public.route_policies(id) ON DELETE RESTRICT;


--
-- Name: request_activity request_activity_virtual_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_activity
    ADD CONSTRAINT request_activity_virtual_model_id_fkey FOREIGN KEY (virtual_model_id) REFERENCES public.virtual_models(id) ON DELETE RESTRICT;


--
-- Name: request_costs request_costs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_costs
    ADD CONSTRAINT request_costs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: request_costs request_costs_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_costs
    ADD CONSTRAINT request_costs_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: request_costs request_costs_request_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_costs
    ADD CONSTRAINT request_costs_request_activity_id_fkey FOREIGN KEY (request_activity_id) REFERENCES public.request_activity(id) ON DELETE CASCADE;


--
-- Name: request_usage request_usage_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_usage
    ADD CONSTRAINT request_usage_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: request_usage request_usage_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_usage
    ADD CONSTRAINT request_usage_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: request_usage request_usage_request_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_usage
    ADD CONSTRAINT request_usage_request_activity_id_fkey FOREIGN KEY (request_activity_id) REFERENCES public.request_activity(id) ON DELETE CASCADE;


--
-- Name: request_usage request_usage_virtual_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_usage
    ADD CONSTRAINT request_usage_virtual_model_id_fkey FOREIGN KEY (virtual_model_id) REFERENCES public.virtual_models(id) ON DELETE RESTRICT;


--
-- Name: route_policies route_policies_virtual_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policies
    ADD CONSTRAINT route_policies_virtual_model_id_fkey FOREIGN KEY (virtual_model_id) REFERENCES public.virtual_models(id) ON DELETE RESTRICT;


--
-- Name: route_policy_candidates route_policy_candidates_provider_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE RESTRICT;


--
-- Name: route_policy_candidates route_policy_candidates_route_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_policy_candidates
    ADD CONSTRAINT route_policy_candidates_route_policy_id_fkey FOREIGN KEY (route_policy_id) REFERENCES public.route_policies(id) ON DELETE CASCADE;


--
-- Name: runtime_errors runtime_errors_request_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runtime_errors
    ADD CONSTRAINT runtime_errors_request_activity_id_fkey FOREIGN KEY (request_activity_id) REFERENCES public.request_activity(id) ON DELETE SET NULL;


--
-- Name: webhook_deliveries webhook_deliveries_fallback_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_fallback_event_id_fkey FOREIGN KEY (fallback_event_id) REFERENCES public.fallback_events(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: webhook_deliveries webhook_deliveries_request_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_request_activity_id_fkey FOREIGN KEY (request_activity_id) REFERENCES public.request_activity(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

--
-- Request logging mode: api_keys.request_logging_mode ('default' | 'full')
-- controls whether the gateway captures request/response bodies. Captured
-- bodies live in request_activity.payload (jsonb, null when not captured),
-- capped at 1 MB per side with explicit truncation flags, and age out with
-- the activity row itself.
--

ALTER TABLE public.api_keys
    ADD COLUMN request_logging_mode text DEFAULT 'default' NOT NULL;
ALTER TABLE public.api_keys
    ADD CONSTRAINT api_keys_request_logging_mode_check
        CHECK (request_logging_mode = ANY (ARRAY['default'::text, 'full'::text]));

ALTER TABLE public.request_activity
    ADD COLUMN payload jsonb;

--
-- Provider OAuth device-code flow: the user-code + polling variant needs to
-- persist the user code, the verification URI, and the poll interval alongside
-- the existing PKCE columns, plus a flow_type discriminator so device pending
-- rows are never mistaken for authorization-code rows. See the local Batch 2
-- device-code plan.
--

ALTER TABLE public.provider_oauth
    ADD COLUMN pending_user_code text,
    ADD COLUMN pending_verification_uri text,
    ADD COLUMN pending_interval_seconds integer,
    ADD COLUMN flow_type text DEFAULT 'authorization_code' NOT NULL;

ALTER TABLE public.provider_oauth
    ADD CONSTRAINT provider_oauth_flow_type_check CHECK ((flow_type = ANY (ARRAY['authorization_code'::text, 'device_code'::text])));

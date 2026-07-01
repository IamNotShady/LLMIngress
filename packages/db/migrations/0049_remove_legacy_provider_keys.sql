with legacy_providers as (
  select id
  from providers
  where lower(provider_key) in ('fireworks', 'groq', 'mistral')
)
update provider_models
set deleted_at = coalesce(deleted_at, now()),
    availability = 'deprecated',
    updated_at = now()
where provider_id in (select id from legacy_providers);

update providers
set enabled = false,
    deleted_at = coalesce(deleted_at, now()),
    updated_at = now()
where lower(provider_key) in ('fireworks', 'groq', 'mistral');

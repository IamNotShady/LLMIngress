alter table agents drop constraint if exists agents_integration_platform_check;

alter table providers drop constraint if exists providers_template_id_whitelisted;

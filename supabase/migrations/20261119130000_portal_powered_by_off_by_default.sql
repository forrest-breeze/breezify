-- Turn the "Powered by Breeze" portal credit off by default.
--
-- The credit used to default to on, and every saved portal layout carries that
-- default as an explicit `footer.showPoweredBy: true`. The app now treats the
-- credit as opt-in, so flip the stored value on existing layouts (drafts,
-- published versions and history) to match. Portals that want the credit can
-- turn it back on under Branding & theme in the portal builder.
--
-- updated_at is left alone: this is a default change, not a portal edit.

update public.workspace_experiences
set spec = jsonb_set(spec, '{footer,showPoweredBy}', 'false'::jsonb)
where spec -> 'footer' -> 'showPoweredBy' = 'true'::jsonb;

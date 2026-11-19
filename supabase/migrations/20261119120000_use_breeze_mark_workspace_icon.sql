-- Use the gradient Breeze mark as the seeded workspace logo.
--
-- 20261113130000 seeded '/breeze-icon.png' (white mark on a blue square). That
-- file is not square and carries its own padding and rounded corners, so it
-- rendered badly inside the app's rounded icon frame. Point seeded workspaces at
-- '/breeze-mark.png' instead: the gradient mark the rest of the app already uses.
--
-- Only rows still on the seeded icon are touched, so uploaded logos are kept.

update public.workspaces
set icon_url = '/breeze-mark.png',
    updated_at = now()
where icon_url = '/breeze-icon.png';

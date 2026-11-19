-- Folder visibility is now one of two choices: Public or Members.
--
-- Public is `visibility = 'workspace'` (the only value the public portal
-- serves). Members is `visibility = 'role'` with the lowest role, which every
-- workspace member holds or outranks, so the existing row-level policies
-- (`role_rank(member) >= role_rank(required_role)`) admit all members and
-- nobody outside the workspace.
--
-- Folders that were limited to a higher role (owners, admins, editors or
-- viewers) become Members folders. This WIDENS who can read them: every member
-- of the workspace, instead of only that role and above. They stay off the
-- public portal.

update public.folders
   set required_role = 'agent-only'
 where visibility = 'role'
   and required_role is distinct from 'agent-only';

-- A role left on a public folder never restricted anything; clear it so a
-- folder reads the same everywhere.
update public.folders
   set required_role = null
 where visibility = 'workspace'
   and required_role is not null;

comment on column public.folders.visibility is
  'Who can see the folder: ''workspace'' = Public (served by the published portal), ''role'' = Members (workspace members only).';
comment on column public.folders.required_role is
  'Always ''agent-only'' (every member) when visibility = ''role'', otherwise null. Higher roles are no longer assigned.';

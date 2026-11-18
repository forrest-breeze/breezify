-- Member deactivation and role-enforced writes.
--
-- 1. Adds a 'deactivated' membership status. Breezify auto-joins every Breeze
--    sign-in to the Breeze workspace (lib/breeze-workspace.ts), so deleting a
--    membership row could never remove anyone: they were re-added as an editor
--    on their next page load. A deactivated row stays put, blocks the auto-join,
--    and (via the helpers below) ends database access immediately.
--
-- 2. Membership helpers now count only active rows. Previously any row,
--    whatever its status, granted access.
--
-- 3. Document and folder writes require editor or above. Viewers and
--    agent-only members could previously create, edit and delete them.
--
-- 4. Drops "Authenticated users can read documents" (USING true), which let any
--    signed-in user read every document regardless of membership or
--    role-restricted folders.

-- 1. Status --------------------------------------------------------------------

alter table public.workspace_members
  drop constraint workspace_members_status_check;

alter table public.workspace_members
  add constraint workspace_members_status_check
  check (status = any (array['active'::text, 'invited'::text, 'deactivated'::text]));

-- 2. Helpers -------------------------------------------------------------------

create or replace function public.get_user_workspace_ids() returns setof uuid
    language sql security definer
    set search_path to ''
    as $$
  select workspace_id from public.workspace_members
  where user_id = (select auth.uid())
    and status = 'active';
$$;

create or replace function public.is_workspace_admin(ws_id uuid) returns boolean
    language sql security definer
    set search_path to ''
    as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws_id
      and user_id = (select auth.uid())
      and status = 'active'
      and role in ('admin', 'owner')
  );
$$;

-- Editor or above, active. Gates document and folder writes.
create or replace function public.can_edit_workspace(ws_id uuid) returns boolean
    language sql stable security definer
    set search_path to ''
    as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws_id
      and user_id = (select auth.uid())
      and status = 'active'
      and public.role_rank(role) >= public.role_rank('editor')
  );
$$;

revoke all on function public.can_edit_workspace(uuid) from public;
grant execute on function public.can_edit_workspace(uuid) to authenticated, service_role;

create or replace function public.can_access_folder(f_id uuid) returns boolean
    language sql stable security definer
    set search_path to 'public'
    as $$
  select exists (
    select 1
    from public.folders f
    where f.id = f_id
      and (
        ((select auth.role()) = 'service_role' and f.visibility = 'workspace')
        or (
          f.workspace_id in (select public.get_user_workspace_ids())
          and (
            f.visibility = 'workspace'
            or (
              f.visibility = 'role'
              and exists (
                select 1
                from public.workspace_members wm
                where wm.workspace_id = f.workspace_id
                  and wm.user_id = (select auth.uid())
                  and wm.status = 'active'
                  and public.role_rank(wm.role) >= public.role_rank(f.required_role)
              )
            )
          )
        )
      )
  );
$$;

-- 3/4. Documents ---------------------------------------------------------------

drop policy "Authenticated users can read documents" on public.documents;

drop policy "Members can insert accessible documents" on public.documents;
create policy "Editors can insert accessible documents" on public.documents
  for insert
  with check (
    public.can_edit_workspace(workspace_id)
    and (folder_id is null or public.can_access_folder(folder_id))
  );

drop policy "Members can update accessible documents" on public.documents;
create policy "Editors can update accessible documents" on public.documents
  for update
  using (
    public.can_edit_workspace(workspace_id)
    and (folder_id is null or public.can_access_folder(folder_id))
  )
  with check (
    public.can_edit_workspace(workspace_id)
    and (folder_id is null or public.can_access_folder(folder_id))
  );

-- 3. Folders -------------------------------------------------------------------
-- Same visibility rule as before; only the membership test changes from
-- "any member" to "active editor or above".

drop policy "Members can insert accessible folders" on public.folders;
create policy "Editors can insert accessible folders" on public.folders
  for insert
  with check (
    public.can_edit_workspace(workspace_id)
    and (
      visibility = 'workspace'
      or (
        visibility = 'role'
        and exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = folders.workspace_id
            and wm.user_id = (select auth.uid())
            and wm.status = 'active'
            and public.role_rank(wm.role) >= public.role_rank(folders.required_role)
        )
      )
    )
  );

drop policy "Members can update accessible folders" on public.folders;
create policy "Editors can update accessible folders" on public.folders
  for update
  using (
    public.can_edit_workspace(workspace_id)
    and (
      visibility = 'workspace'
      or (
        visibility = 'role'
        and exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = folders.workspace_id
            and wm.user_id = (select auth.uid())
            and wm.status = 'active'
            and public.role_rank(wm.role) >= public.role_rank(folders.required_role)
        )
      )
    )
  );

drop policy "Members can delete accessible folders" on public.folders;
create policy "Editors can delete accessible folders" on public.folders
  for delete
  using (
    public.can_edit_workspace(workspace_id)
    and (
      visibility = 'workspace'
      or (
        visibility = 'role'
        and exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = folders.workspace_id
            and wm.user_id = (select auth.uid())
            and wm.status = 'active'
            and public.role_rank(wm.role) >= public.role_rank(folders.required_role)
        )
      )
    )
  );

-- Folder reads keep their policy text; they pick up the active-only rule
-- through get_user_workspace_ids(). Tighten the role-folder subquery too.
drop policy "Members can read accessible folders" on public.folders;
create policy "Members can read accessible folders" on public.folders
  for select
  using (
    workspace_id in (select public.get_user_workspace_ids())
    and (
      visibility = 'workspace'
      or (
        visibility = 'role'
        and exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = folders.workspace_id
            and wm.user_id = (select auth.uid())
            and wm.status = 'active'
            and public.role_rank(wm.role) >= public.role_rank(folders.required_role)
        )
      )
    )
  );

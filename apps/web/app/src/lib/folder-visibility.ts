import type { FolderVisibility, WorkspaceMemberRole } from "@/lib/types"

/**
 * Who can see a folder.
 *
 * There are two choices:
 *
 *   • Public — everyone, including visitors of the published portal.
 *   • Members — every member of the workspace, and nobody outside it.
 *
 * They are stored in the columns the older role-based model used: Public is
 * `visibility = 'workspace'`, the only value the portal serves, and Members is
 * `visibility = 'role'` with the lowest role (`agent-only`), which every member
 * holds or outranks. No other role is assigned any more; folderScopeFor is how
 * every write gets its columns, so a request naming a higher role still stores
 * a Members folder.
 *
 * Visibility is inherited: a folder under a Members folder is not public
 * either, whatever its own setting says.
 */
export interface FolderScope {
  visibility: FolderVisibility
  required_role: WorkspaceMemberRole | null
}

export const PUBLIC_FOLDER_SCOPE: FolderScope = {
  visibility: "workspace",
  required_role: null,
}

export const MEMBERS_FOLDER_SCOPE: FolderScope = {
  visibility: "role",
  required_role: "agent-only",
}

export function isPublicFolderScope(scope: { visibility: string | null }): boolean {
  return scope.visibility === PUBLIC_FOLDER_SCOPE.visibility
}

/** The columns to store for a requested visibility: Public, or else Members. */
export function folderScopeFor(visibility: string | null | undefined): FolderScope {
  return visibility === PUBLIC_FOLDER_SCOPE.visibility ? PUBLIC_FOLDER_SCOPE : MEMBERS_FOLDER_SCOPE
}

/**
 * Folders the public cannot see: those that are not Public themselves, and
 * every folder beneath one.
 */
export function nonPublicFolderIds(
  folders: ReadonlyArray<{
    id: string
    parent_folder_id: string | null
    visibility: string | null
  }>,
): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parent_folder_id === null) continue
    const siblings = childrenOf.get(folder.parent_folder_id) ?? []
    siblings.push(folder.id)
    childrenOf.set(folder.parent_folder_id, siblings)
  }
  const hidden = new Set<string>()
  const queue = folders.filter((folder) => !isPublicFolderScope(folder)).map((folder) => folder.id)
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (hidden.has(id)) continue
    hidden.add(id)
    for (const child of childrenOf.get(id) ?? []) queue.push(child)
  }
  return hidden
}

export type FolderScopeKey = "public" | "members"

export interface FolderScopeChoice {
  key: FolderScopeKey
  label: string
  hint: string
  scope: FolderScope
}

export function folderScopeKey(scope: { visibility: string | null }): FolderScopeKey {
  return isPublicFolderScope(scope) ? "public" : "members"
}

export const FOLDER_SCOPE_CHOICES: ReadonlyArray<FolderScopeChoice> = [
  {
    key: "public",
    label: "Public",
    hint: "Anyone can see this folder on the published portal.",
    scope: PUBLIC_FOLDER_SCOPE,
  },
  {
    key: "members",
    label: "Members",
    hint: "Only members of this workspace can see this folder.",
    scope: MEMBERS_FOLDER_SCOPE,
  },
]

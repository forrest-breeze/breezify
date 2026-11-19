/**
 * Folder visibility follows the repository.
 *
 * The docs site built from the repository publishes a directory only when the
 * `_order.yaml` beside it lists it; a directory the file leaves out is not on
 * the site at all, whatever its pages say. In Breezify that is a Members
 * folder: every workspace member can open it, the public portal cannot.
 *
 *   repository -> Breezify   After each sync, a mirrored folder whose listing
 *                            changed takes the matching visibility: left out
 *                            becomes Members, listed again becomes Public.
 *   Breezify -> repository   A publish leaves a folder that is not public out
 *                            of the order file, and lists a folder that was
 *                            made Public again (readmeFolderListing).
 *
 * The listing last seen in the repository is kept on the folder
 * (`readme_unlisted`), so a change made in Breezify and not published yet is
 * not undone by the next sync: only a change in the repository moves it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  MEMBERS_FOLDER_SCOPE,
  PUBLIC_FOLDER_SCOPE,
  isPublicFolderScope,
  type FolderScope,
} from '@/lib/folder-visibility'

import { README_FOLDER_KIND, README_ORDER_FILE } from './readme-layout'

/** `folders.source_metadata` key: whether the repository last left the directory unlisted. */
export const README_FOLDER_UNLISTED_KEY = 'readme_unlisted'

export interface ReadmeVisibilityFolder {
  id: string
  visibility: string | null
  required_role: string | null
  source_metadata: Record<string, unknown> | null
}

/** `_order.yaml` entries keyed by the order file's repository path. */
export type ReadmeOrderEntries = Readonly<Record<string, readonly string[]>>

function linkedPath(folder: ReadmeVisibilityFolder, repoId: number): string | null {
  const metadata = folder.source_metadata
  if (!metadata || metadata.kind !== README_FOLDER_KIND) return null
  if (Number(metadata.repo_id) !== repoId || typeof metadata.path !== 'string') return null
  return metadata.path
}

/**
 * Whether the order file beside a mirrored directory leaves it out. Null when
 * the folder is not a mirrored directory of this repository.
 *
 * A directory with no order file beside it, or an empty one, is listed: only a
 * file that names its siblings can leave a directory out.
 */
export function isUnlistedInRepository(
  folder: ReadmeVisibilityFolder,
  repoId: number,
  orderEntries: ReadmeOrderEntries,
): boolean | null {
  const path = linkedPath(folder, repoId)
  if (path === null) return null
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return false
  const entries = orderEntries[`${path.slice(0, slash)}/${README_ORDER_FILE}`]
  if (!entries || entries.length === 0) return false
  return !entries.includes(path.slice(slash + 1))
}

export interface ReadmeFolderVisibilityChange {
  id: string
  /** The listing now seen in the repository, to record on the folder. */
  unlisted: boolean
  /** The visibility to set, or null to leave the folder's visibility alone. */
  scope: FolderScope | null
}

/**
 * What a sync changes: one entry per mirrored folder whose listing in the
 * repository differs from the one recorded on it.
 */
export function planReadmeFolderVisibility(
  folders: ReadonlyArray<ReadmeVisibilityFolder>,
  repoId: number,
  orderEntries: ReadmeOrderEntries,
): ReadmeFolderVisibilityChange[] {
  const changes: ReadmeFolderVisibilityChange[] = []
  for (const folder of folders) {
    const unlisted = isUnlistedInRepository(folder, repoId, orderEntries)
    if (unlisted === null) continue
    const recorded = folder.source_metadata?.[README_FOLDER_UNLISTED_KEY]
    if (recorded === unlisted) continue
    let scope: FolderScope | null = null
    if (unlisted && isPublicFolderScope(folder)) {
      scope = MEMBERS_FOLDER_SCOPE
    } else if (!unlisted && recorded === true && !isPublicFolderScope(folder)) {
      // Only a folder the repository was seen to leave out goes back. A listing
      // seen for the first time never opens a folder someone made Members.
      scope = PUBLIC_FOLDER_SCOPE
    }
    changes.push({ id: folder.id, unlisted, scope })
  }
  return changes
}

/**
 * How a publish lists a folder in its parent's `_order.yaml`:
 *
 *   'omit'    the folder is not public (and its parent is, so the parent's
 *             order file is where that is expressed);
 *   'append'  the repository left it out and it has been made Public since, so
 *             it joins the end of the order;
 *   null      its place in the order is unchanged.
 */
export function readmeFolderListing(folder: {
  restricted: boolean
  parentRestricted: boolean
  sortOrder: number | null
  metadata: Record<string, unknown> | null
}): 'omit' | 'append' | null {
  if (folder.restricted) return folder.parentRestricted ? null : 'omit'
  if (folder.sortOrder === null && folder.metadata?.[README_FOLDER_UNLISTED_KEY] === true) {
    return 'append'
  }
  return null
}

function readOrderEntries(syncState: unknown): Record<string, readonly string[]> {
  const files =
    typeof syncState === 'object' && syncState !== null
      ? (syncState as Record<string, unknown>).order_files
      : null
  const result: Record<string, readonly string[]> = {}
  if (typeof files !== 'object' || files === null) return result
  for (const [path, value] of Object.entries(files as Record<string, unknown>)) {
    const entries = (value as { entries?: unknown } | null)?.entries
    if (!Array.isArray(entries)) continue
    result[path] = entries.filter((entry): entry is string => typeof entry === 'string')
  }
  return result
}

/**
 * Bring folder visibility in line with the repository's order files, as the
 * sync just recorded them. Returns how many folders changed visibility.
 */
export async function reconcileReadmeFolderVisibility(
  admin: SupabaseClient,
  input: { workspaceId: string; sourceId: string; repoId: number },
): Promise<number> {
  const [source, folderRows] = await Promise.all([
    admin
      .from('github_hosted_docs_sources')
      .select('sync_state')
      .eq('id', input.sourceId)
      .eq('workspace_id', input.workspaceId)
      .maybeSingle(),
    admin
      .from('folders')
      .select('id, visibility, required_role, source_metadata')
      .eq('workspace_id', input.workspaceId)
      .eq('kind', 'user'),
  ])
  if (source.error) throw new Error(`readme folder visibility source: ${source.error.message}`)
  if (folderRows.error) throw new Error(`readme folder visibility list: ${folderRows.error.message}`)

  const folders = (folderRows.data ?? []) as ReadmeVisibilityFolder[]
  const changes = planReadmeFolderVisibility(
    folders,
    input.repoId,
    readOrderEntries((source.data as { sync_state?: unknown } | null)?.sync_state),
  )
  const metadataById = new Map(folders.map((folder) => [folder.id, folder.source_metadata]))
  for (const change of changes) {
    const { error } = await admin
      .from('folders')
      .update({
        source_metadata: {
          ...(metadataById.get(change.id) ?? {}),
          [README_FOLDER_UNLISTED_KEY]: change.unlisted,
        },
        ...(change.scope ?? {}),
      })
      .eq('id', change.id)
      .eq('workspace_id', input.workspaceId)
    if (error) throw new Error(`readme folder visibility update: ${error.message}`)
  }
  return changes.filter((change) => change.scope !== null).length
}

/**
 * Pages a GitHub docs repository marks `hidden: true`.
 *
 * The repository sync copies a page's `hidden` frontmatter into
 * `documents.source_metadata.readme_hidden`, and a directory's landing page
 * (`index.md`) frontmatter into `folders.source_metadata.index_frontmatter`.
 * A hidden page is published nowhere on the repository's own site, so the
 * portal must not serve it either: not in navigation, not in search, and not
 * by direct link.
 *
 * A whole directory the repository keeps off its site is a different matter:
 * that is the folder's visibility, which the sync sets from the repository
 * (lib/github/readme/readme-folder-visibility.ts) and members can change.
 *
 * `documents.status` is no substitute for this. Documents written in Breezify
 * are created as Draft and are served regardless, so status cannot tell a
 * hidden repository page from an ordinary one.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export const REPOSITORY_HIDDEN_KEY = "readme_hidden"

/**
 * PostgREST select fragment that returns the flag on its own, for listings that
 * have no other use for the whole metadata object.
 */
export const REPOSITORY_HIDDEN_SELECT = `${REPOSITORY_HIDDEN_KEY}:source_metadata->${REPOSITORY_HIDDEN_KEY}`

function isHiddenValue(value: unknown): boolean {
  return value === true || value === "true"
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Whether a document row is a hidden repository page. Accepts a row that
 * selected `source_metadata`, the `REPOSITORY_HIDDEN_SELECT` alias, or both.
 */
export function isRepositoryHiddenDocument(row: {
  source_metadata?: unknown
  readme_hidden?: unknown
}): boolean {
  if (isHiddenValue(row.readme_hidden)) return true
  return isHiddenValue(asRecord(row.source_metadata)?.[REPOSITORY_HIDDEN_KEY])
}

/** Whether a folder's repository landing page (`index.md`) is hidden. */
export function isRepositoryHiddenFolderIndex(sourceMetadata: unknown): boolean {
  const frontmatter = asRecord(asRecord(sourceMetadata)?.index_frontmatter)
  return isHiddenValue(frontmatter?.hidden)
}

/**
 * Which folders with a hidden landing page have nothing public left under
 * them. Pure half of repositoryHiddenFolderIds.
 *
 * A candidate goes when it holds no visible document and every child folder has
 * gone the same way. A child that is not a candidate always keeps its parent,
 * even when it is empty — only the repository's `hidden` flag removes a folder.
 */
export function foldersHiddenByRepository(
  folders: ReadonlyArray<{ id: string; parent_folder_id: string | null }>,
  hiddenIndexFolderIds: ReadonlySet<string>,
  foldersWithVisibleDocs: ReadonlySet<string>,
): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parent_folder_id === null) continue
    const siblings = childrenOf.get(folder.parent_folder_id) ?? []
    siblings.push(folder.id)
    childrenOf.set(folder.parent_folder_id, siblings)
  }
  const hidden = new Set<string>()
  // Leaves first: a parent only goes once its last child has.
  for (let changed = true; changed; ) {
    changed = false
    for (const id of hiddenIndexFolderIds) {
      if (hidden.has(id) || foldersWithVisibleDocs.has(id)) continue
      if ((childrenOf.get(id) ?? []).every((child) => hidden.has(child))) {
        hidden.add(id)
        changed = true
      }
    }
  }
  return hidden
}

/**
 * Folders the repository hides entirely: the landing page (`index.md`) is
 * `hidden: true` and so is every page beneath it. The repository's own site
 * shows no trace of such a directory.
 *
 * `folders` is the set of folders the public can otherwise see; a folder
 * outside it never counts as a child that keeps its parent visible. Throws on a
 * query error so the portal fails closed rather than showing a hidden folder.
 */
export async function repositoryHiddenFolderIds(
  client: SupabaseClient,
  workspaceId: string,
  folders: ReadonlyArray<{ id: string; parent_folder_id: string | null }>,
): Promise<Set<string>> {
  const { data: indexRows, error: indexError } = await client
    .from("folders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source_metadata->index_frontmatter->>hidden", "true")
  if (indexError) {
    throw new Error(`repository-hidden folders query failed: ${indexError.message}`)
  }
  const listed = new Set(folders.map((folder) => folder.id))
  const candidates = new Set(
    ((indexRows ?? []) as Array<{ id: string }>)
      .map((row) => row.id)
      .filter((id) => listed.has(id)),
  )
  if (candidates.size === 0) return candidates

  const { data: docRows, error: docError } = await client
    .from("documents")
    .select(`folder_id, ${REPOSITORY_HIDDEN_SELECT}`)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .in("document_type", ["source", "page"])
    .in("folder_id", Array.from(candidates))
  if (docError) {
    throw new Error(`repository-hidden folder documents query failed: ${docError.message}`)
  }
  const withVisibleDocs = new Set<string>()
  for (const row of (docRows ?? []) as Array<{ folder_id: string; readme_hidden?: unknown }>) {
    if (!isRepositoryHiddenDocument(row)) withVisibleDocs.add(row.folder_id)
  }
  return foldersHiddenByRepository(folders, candidates, withVisibleDocs)
}

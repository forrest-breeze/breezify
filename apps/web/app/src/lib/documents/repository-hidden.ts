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
 * A folder with nothing public left in it (every page hidden) is left out too,
 * so it does not render as an empty section; see repositoryHiddenFolderIds.
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

/** What a folder has of its own, as far as the public is concerned. */
export interface FolderPublicContent {
  /** Its landing page (`index.md`) is `hidden: true`. */
  hiddenIndex: ReadonlySet<string>
  /** It has a landing page with content, and that page is not hidden. */
  withLanding: ReadonlySet<string>
  /** It holds at least one page that is not hidden. */
  withVisibleDocs: ReadonlySet<string>
  /** It holds at least one hidden page. */
  withHiddenDocs: ReadonlySet<string>
}

/**
 * Which folders have nothing public left in or under them, so that they would
 * render as an empty section. Pure half of repositoryHiddenFolderIds.
 *
 * A folder goes when it holds no visible page, every child folder has gone the
 * same way, and what remains is only what the repository hides: a hidden
 * landing page, or no landing page and nothing but hidden pages or hidden
 * child folders.
 *
 * A folder that is merely empty stays: nothing in it was hidden, so it is a
 * section someone has not filled yet, not one the repository keeps off its site.
 */
export function foldersHiddenByRepository(
  folders: ReadonlyArray<{ id: string; parent_folder_id: string | null }>,
  content: FolderPublicContent,
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
    for (const { id } of folders) {
      if (hidden.has(id) || content.withVisibleDocs.has(id)) continue
      const children = childrenOf.get(id) ?? []
      if (!children.every((child) => hidden.has(child))) continue
      const onlyHiddenContent =
        !content.withLanding.has(id) && (content.withHiddenDocs.has(id) || children.length > 0)
      if (content.hiddenIndex.has(id) || onlyHiddenContent) {
        hidden.add(id)
        changed = true
      }
    }
  }
  return hidden
}

const PAGE_SIZE = 1000
/** Pages of document rows read before giving up and showing the folders. */
const MAX_PAGES = 20

/**
 * Folders the public should not see because nothing in them is public: every
 * page beneath is `hidden: true` in the repository, and so is the landing page
 * (`index.md`) if there is one. The repository's own site shows no trace of
 * such a directory.
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
  const listed = new Map(folders.map((folder) => [folder.id, folder]))

  const { data: indexRows, error: indexError } = await client
    .from("folders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source_metadata->index_frontmatter->>hidden", "true")
  if (indexError) {
    throw new Error(`repository-hidden folders query failed: ${indexError.message}`)
  }
  const hiddenIndex = new Set(
    ((indexRows ?? []) as Array<{ id: string }>).map((row) => row.id).filter((id) => listed.has(id)),
  )

  const { data: hiddenDocRows, error: hiddenDocError } = await client
    .from("documents")
    .select("folder_id")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .in("document_type", ["source", "page"])
    .eq(`source_metadata->>${REPOSITORY_HIDDEN_KEY}`, "true")
    .not("folder_id", "is", null)
  if (hiddenDocError) {
    throw new Error(`repository-hidden documents query failed: ${hiddenDocError.message}`)
  }
  const withHiddenDocs = new Set(
    ((hiddenDocRows ?? []) as Array<{ folder_id: string }>)
      .map((row) => row.folder_id)
      .filter((id) => listed.has(id)),
  )
  if (hiddenIndex.size === 0 && withHiddenDocs.size === 0) return new Set()

  // Only a folder with something hidden in it, or above one, can go.
  const candidates = new Set<string>()
  for (const start of [...hiddenIndex, ...withHiddenDocs]) {
    for (
      let id: string | null = start;
      id !== null && listed.has(id) && !candidates.has(id);
      id = listed.get(id)!.parent_folder_id
    ) {
      candidates.add(id)
    }
  }
  const candidateIds = Array.from(candidates)

  const withVisibleDocs = new Set<string>()
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      // More documents than this reads: show the folders rather than hide one
      // that may hold a visible page.
      return new Set()
    }
    const { data: docRows, error: docError } = await client
      .from("documents")
      .select(`id, folder_id, ${REPOSITORY_HIDDEN_SELECT}`)
      .eq("workspace_id", workspaceId)
      .is("deleted_at", null)
      .in("document_type", ["source", "page"])
      .in("folder_id", candidateIds)
      .order("id")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (docError) {
      throw new Error(`repository-hidden folder documents query failed: ${docError.message}`)
    }
    const rows = (docRows ?? []) as Array<{ folder_id: string; readme_hidden?: unknown }>
    for (const row of rows) {
      if (!isRepositoryHiddenDocument(row)) withVisibleDocs.add(row.folder_id)
    }
    if (rows.length < PAGE_SIZE) break
  }

  const { data: landingRows, error: landingError } = await client
    .from("folders")
    .select("id, content")
    .eq("workspace_id", workspaceId)
    .in("id", candidateIds)
  if (landingError) {
    throw new Error(`repository-hidden folder landing query failed: ${landingError.message}`)
  }
  const withLanding = new Set(
    ((landingRows ?? []) as Array<{ id: string; content: string | null }>)
      .filter((row) => !hiddenIndex.has(row.id) && Boolean(row.content?.trim()))
      .map((row) => row.id),
  )

  return foldersHiddenByRepository(folders, {
    hiddenIndex,
    withLanding,
    withVisibleDocs,
    withHiddenDocs,
  })
}

import type { PortalPageOutline } from "@/lib/portal/page-outline"
import type { PortalPagePresentation } from "@/lib/portal/schema"
import {
  createScopeTreeView,
  type ScopeTreeContext,
  type ScopeTreeView,
} from "@/lib/portal/scope-tree"
import type { PortalScopeEntry } from "@/lib/public-kb"

// ---------------------------------------------------------------------------
// Editor tree grouped by portal page.
//
// The editor lists every workspace document. When the portal has pages (an API
// reference, a changelog, ...), the tree's top level is one root per page, so
// each page reads as a root folder: Home ("Documents") and each page in the
// portal's navigation order, then "Not in portal" for content no page shows.
// Only the workspace's root portal counts, the one the portal builder edits.
//
// The grouping is display only. Folders keep their real parents (the GitHub
// sync maps each top-level folder to a docs/<Category> directory), so moving
// one between roots is an ordinary move to the root's folder.
//
// Rules:
//  - A page with its own scope claims its content before Home does, so the API
//    reference folder sits under "API Reference" even when Home covers the
//    whole workspace. A page that follows Home (scope null) gets no root.
//  - A folder the portal never shows as a row is not a row here either: a
//    promoted project root, and the folders of an API reference page (the
//    reference shows their groups, not them). Their children sit at the top of
//    the root, as on the published page.
//  - A folder goes to the first page (or Home) that shows all of it, so a
//    folder a page includes moves there even from inside a Home folder. A
//    folder no page shows in full stays with its parent. A document stays with
//    its folder unless a page picks it by itself.
// ---------------------------------------------------------------------------

export type EditorPageRootKind = "home" | "page" | "unplaced"

export interface EditorPageRoot {
  key: string
  kind: EditorPageRootKind
  title: string
  /** The page's presentation; null for Home and "Not in portal". */
  presentation: PortalPagePresentation | null
  /**
   * Where a document created in or dropped on the root goes: a folder id, null
   * for the workspace root, undefined when no single folder makes it show on
   * this page.
   */
  docTargetFolderId: string | null | undefined
  /** The same for a folder. */
  folderTargetFolderId: string | null | undefined
  /**
   * The page names folders or documents in its scope and none of them exists
   * any more: its content was deleted.
   */
  contentDeleted: boolean
}

export interface EditorPageRootTree<F, D> {
  roots: EditorPageRoot[]
  /** Child folders by parent: a folder id, or a root key for the top level. */
  foldersByParent: Map<string, F[]>
  /** Documents by parent, keyed the same way. */
  docsByParent: Map<string, D[]>
  /** The root each placed folder and document is under. */
  rootKeyByItemId: Map<string, string>
  /** Folders not shown as rows; their content is placed in their stead. */
  hiddenFolderIds: Set<string>
}

interface TreeFolder {
  id: string
  parent_folder_id: string | null
}

interface TreeDoc {
  id: string
  folder_id: string | null
}

export const HOME_ROOT_KEY = "page-root:home"
export const UNPLACED_ROOT_KEY = "page-root:unplaced"

interface Group {
  root: EditorPageRoot
  scope: PortalScopeEntry[] | null
  view: ScopeTreeView | null
}

function folderEntryOf(
  entry: PortalScopeEntry,
): { id: string; promote: boolean; rootOnly: boolean; explicitDocs: boolean } | null {
  if (typeof entry === "string") {
    return { id: entry, promote: false, rootOnly: false, explicitDocs: false }
  }
  if (typeof entry === "object" && entry !== null && "id" in entry) {
    return {
      id: entry.id,
      promote: entry.promote === true,
      rootOnly: entry.rootOnly === true || entry.explicitDocs === true,
      explicitDocs: entry.explicitDocs === true,
    }
  }
  return null
}

/**
 * Folders whose parent chain loops back on itself. The database rejects a move
 * that would close a loop, but it checks each move against committed rows, so
 * two concurrent moves could still make one, and the scope-tree helpers would
 * never finish walking it.
 */
function cyclicFolderIds(folders: readonly TreeFolder[]): Set<string> {
  const parentById = new Map(folders.map((folder) => [folder.id, folder.parent_folder_id]))
  const cyclic = new Set<string>()
  for (const folder of folders) {
    const seen = new Set<string>()
    let current: string | null = folder.id
    while (current && parentById.has(current)) {
      if (seen.has(current)) {
        cyclic.add(folder.id)
        break
      }
      seen.add(current)
      current = parentById.get(current) ?? null
    }
  }
  return cyclic
}

/**
 * Group the editor tree by the root portal's pages. Returns null when no page
 * has content of its own, so the tree keeps its plain folder layout.
 *
 * `folders` and `docs` are the rows to place, in display order (`docs` may be
 * narrowed by a search). `scopeContext` is every portal-eligible folder and
 * document, which page scopes are resolved against.
 */
export function buildEditorPageRoots<F extends TreeFolder, D extends TreeDoc>(input: {
  portal: PortalPageOutline
  folders: readonly F[]
  docs: readonly D[]
  scopeContext: Pick<ScopeTreeContext, "folders" | "docs">
}): EditorPageRootTree<F, D> | null {
  const { portal, folders, docs, scopeContext } = input
  if (!portal.pages.some((page) => page.scope !== null)) return null

  const cyclic = cyclicFolderIds(scopeContext.folders)
  const ctxFolders = scopeContext.folders.filter((folder) => !cyclic.has(folder.id))
  const ctx: ScopeTreeContext = { folders: ctxFolders, docs: scopeContext.docs, rootId: null }
  const eligibleFolderIds = new Set(ctxFolders.map((folder) => folder.id))
  const eligibleDocIds = new Set(scopeContext.docs.map((doc) => doc.id))
  const hiddenFolderIds = new Set<string>()

  // What still exists, to tell a page whose content was deleted from one that
  // is merely empty. Folders: every user folder; documents: every document.
  const existingFolderIds = new Set(folders.map((folder) => folder.id))
  const existingDocIds = new Set([
    ...scopeContext.docs.map((doc) => doc.id),
    ...docs.map((doc) => doc.id),
  ])
  const targetsDeleted = (scope: PortalScopeEntry[] | null): boolean => {
    const named = (scope ?? []).flatMap((entry) => {
      if (typeof entry === "object" && entry !== null && "doc" in entry) {
        return [existingDocIds.has(entry.doc)]
      }
      const folder = folderEntryOf(entry)
      return folder ? [existingFolderIds.has(folder.id)] : []
    })
    return named.length > 0 && named.every((exists) => !exists)
  }

  const makeGroup = (
    root: Omit<
      EditorPageRoot,
      "docTargetFolderId" | "folderTargetFolderId" | "contentDeleted"
    >,
    scope: PortalScopeEntry[] | null,
    hideScopeFolders: boolean,
  ): Group => {
    const transparent: NonNullable<ReturnType<typeof folderEntryOf>>[] = []
    for (const entry of scope ?? []) {
      const folder = folderEntryOf(entry)
      if (!folder || !eligibleFolderIds.has(folder.id)) continue
      if (folder.promote || hideScopeFolders) {
        hiddenFolderIds.add(folder.id)
        transparent.push(folder)
      }
    }
    const only = transparent.length === 1 ? transparent[0] : null
    return {
      root: {
        ...root,
        docTargetFolderId:
          scope === null ? null : only && !only.explicitDocs ? only.id : undefined,
        folderTargetFolderId:
          scope === null ? null : only && !only.rootOnly ? only.id : undefined,
        contentDeleted: targetsDeleted(scope),
      },
      scope,
      view: createScopeTreeView(scope, ctx),
    }
  }

  const home = makeGroup(
    { key: HOME_ROOT_KEY, kind: "home", title: "Documents", presentation: null },
    portal.scope,
    false,
  )
  const pageGroups: Group[] = []
  for (const page of portal.pages) {
    // A page that follows Home has nothing of its own to show.
    if (page.scope === null) continue
    pageGroups.push(
      makeGroup(
        {
          key: `page-root:page:${page.id}`,
          kind: "page",
          title: page.title,
          presentation: page.presentation,
        },
        page.scope,
        page.presentation === "api_reference",
      ),
    )
  }
  const unplaced: Group = {
    root: {
      key: UNPLACED_ROOT_KEY,
      kind: "unplaced",
      title: "Not in portal",
      presentation: null,
      docTargetFolderId: undefined,
      folderTargetFolderId: undefined,
      contentDeleted: false,
    },
    scope: [],
    view: null,
  }
  const claimOrder = [...pageGroups, home]

  // A document a scope picks by itself goes to the first group that picks it.
  const docClaims = new Map<string, Group>()
  for (const group of claimOrder) {
    for (const entry of group.scope ?? []) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "doc" in entry &&
        eligibleDocIds.has(entry.doc) &&
        !docClaims.has(entry.doc)
      ) {
        docClaims.set(entry.doc, group)
      }
    }
  }

  const parentById = new Map(folders.map((folder) => [folder.id, folder.parent_folder_id]))
  const knownParent = (id: string | null | undefined): string | null =>
    id && parentById.has(id) ? id : null
  // The nearest ancestor (or the folder itself) that is shown as a row.
  const shownAncestor = (id: string | null): string | null => {
    let current = knownParent(id)
    const seen = new Set<string>()
    while (current && hiddenFolderIds.has(current) && !seen.has(current)) {
      seen.add(current)
      current = knownParent(parentById.get(current))
    }
    return current && !hiddenFolderIds.has(current) ? current : null
  }

  const folderGroups = new Map<string, Group>()
  const groupOfFolder = (id: string, visiting = new Set<string>()): Group => {
    const known = folderGroups.get(id)
    if (known) return known
    if (visiting.has(id)) return unplaced
    visiting.add(id)
    const eligible = eligibleFolderIds.has(id)
    // The first group that shows the whole folder. A "partial" folder is only
    // a path to content picked below it, so it does not pull the folder over.
    let group = eligible
      ? claimOrder.find((candidate) => candidate.view?.folderState(id) === "full")
      : undefined
    if (!group) {
      const parent = shownAncestor(parentById.get(id) ?? null)
      if (parent) {
        group = groupOfFolder(parent, visiting)
      } else if (eligible) {
        group = claimOrder.find(
          (candidate) => candidate.view?.folderState(id) === "partial",
        )
      }
    }
    const resolved = group ?? unplaced
    folderGroups.set(id, resolved)
    return resolved
  }

  const groupOfDoc = (doc: D): Group => {
    const claimed = docClaims.get(doc.id)
    if (claimed) return claimed
    const parent = shownAncestor(doc.folder_id)
    if (parent) return groupOfFolder(parent)
    if (!eligibleDocIds.has(doc.id)) return unplaced
    return claimOrder.find((candidate) => candidate.view?.docChecked(doc.id)) ?? unplaced
  }

  const foldersByParent = new Map<string, F[]>()
  const docsByParent = new Map<string, D[]>()
  const rootKeyByItemId = new Map<string, string>()
  const push = <T>(map: Map<string, T[]>, key: string, item: T): void => {
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }

  for (const folder of folders) {
    if (hiddenFolderIds.has(folder.id)) continue
    const group = groupOfFolder(folder.id)
    const parent = shownAncestor(folder.parent_folder_id)
    const key = parent && groupOfFolder(parent) === group ? parent : group.root.key
    push(foldersByParent, key, folder)
    rootKeyByItemId.set(folder.id, group.root.key)
  }
  for (const doc of docs) {
    const group = groupOfDoc(doc)
    const parent = shownAncestor(doc.folder_id)
    const key = parent && groupOfFolder(parent) === group ? parent : group.root.key
    push(docsByParent, key, doc)
    rootKeyByItemId.set(doc.id, group.root.key)
  }

  // Home takes its slot in the portal's navigation order. Pages that follow
  // Home have no root, so count only the pages with one before Home's slot.
  const roots = pageGroups.map((group) => group.root)
  const homeSlot = portal.pages
    .slice(0, portal.homePosition)
    .filter((page) => page.scope !== null).length
  roots.splice(homeSlot, 0, home.root)
  if (foldersByParent.has(UNPLACED_ROOT_KEY) || docsByParent.has(UNPLACED_ROOT_KEY)) {
    roots.push(unplaced.root)
  }

  return { roots, foldersByParent, docsByParent, rootKeyByItemId, hiddenFolderIds }
}

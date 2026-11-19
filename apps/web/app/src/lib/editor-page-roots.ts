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
// each page reads as a root folder: Home ("Documents"), then each page, then
// "Not in portal" for content no page shows.
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
//  - A Home that covers the whole workspace claims last, after every page and
//    every other portal's Home.
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

export const UNPLACED_ROOT_KEY = "page-root:unplaced"

export function isEditorPageRootKey(key: string): boolean {
  return key.startsWith("page-root:")
}

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
 * Group the editor tree by portal page. Returns null when no portal has a page
 * with content of its own, so the tree keeps its plain folder layout.
 *
 * `folders` and `docs` are the rows to place, in display order (`docs` may be
 * narrowed by a search). `scopeContext` is every portal-eligible folder and
 * document, which page scopes are resolved against.
 */
export function buildEditorPageRoots<F extends TreeFolder, D extends TreeDoc>(input: {
  projects: readonly PortalPageOutline[]
  folders: readonly F[]
  docs: readonly D[]
  scopeContext: Pick<ScopeTreeContext, "folders" | "docs">
}): EditorPageRootTree<F, D> | null {
  const { projects, folders, docs, scopeContext } = input
  const hasOwnPages = projects.some((project) =>
    project.pages.some((page) => page.scope !== null),
  )
  if (!hasOwnPages) return null

  const ctx: ScopeTreeContext = { ...scopeContext, rootId: null }
  const eligibleFolderIds = new Set(scopeContext.folders.map((folder) => folder.id))
  const eligibleDocIds = new Set(scopeContext.docs.map((doc) => doc.id))
  const multipleProjects = projects.length > 1

  // Roots in display order; claim order puts each project's own pages ahead of
  // every Home.
  const displayGroups: Group[] = []
  const pageGroups: Group[] = []
  const homeGroups: Group[] = []
  const hiddenFolderIds = new Set<string>()

  const makeGroup = (
    root: Omit<EditorPageRoot, "docTargetFolderId" | "folderTargetFolderId">,
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
      },
      scope,
      view: createScopeTreeView(scope, ctx),
    }
  }

  for (const project of projects) {
    const prefix = multipleProjects && !project.isDefault ? project.displayName : null
    const home = makeGroup(
      {
        key: `page-root:${project.slug}:home`,
        kind: "home",
        title: prefix ?? "Documents",
        presentation: null,
      },
      project.scope,
      false,
    )
    homeGroups.push(home)

    const projectGroups: Group[] = []
    for (const page of project.pages) {
      if (page.scope === null) continue
      const group = makeGroup(
        {
          key: `page-root:${project.slug}:page:${page.id}`,
          kind: "page",
          title: prefix ? `${prefix} · ${page.title}` : page.title,
          presentation: page.presentation,
        },
        page.scope,
        page.presentation === "api_reference",
      )
      projectGroups.push(group)
      pageGroups.push(group)
    }

    // Home takes its slot in the project's navigation order. Pages that follow
    // Home were skipped, so count only the pages placed before its slot.
    const homeSlot = project.pages
      .slice(0, project.homePosition)
      .filter((page) => page.scope !== null).length
    projectGroups.splice(homeSlot, 0, home)
    displayGroups.push(...projectGroups)
  }

  const unplaced: Group = {
    root: {
      key: UNPLACED_ROOT_KEY,
      kind: "unplaced",
      title: "Not in portal",
      presentation: null,
      docTargetFolderId: undefined,
      folderTargetFolderId: undefined,
    },
    scope: [],
    view: null,
  }
  // Pages first, then Homes that name their content, then Homes that cover the
  // whole workspace: those are the catch-all and claim only what is left.
  const claimOrder = [
    ...pageGroups,
    ...homeGroups.filter((group) => group.scope !== null),
    ...homeGroups.filter((group) => group.scope === null),
  ]

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

  const roots = displayGroups.map((group) => group.root)
  if (
    foldersByParent.has(UNPLACED_ROOT_KEY) ||
    docsByParent.has(UNPLACED_ROOT_KEY)
  ) {
    roots.push(unplaced.root)
  }

  return { roots, foldersByParent, docsByParent, rootKeyByItemId, hiddenFolderIds }
}

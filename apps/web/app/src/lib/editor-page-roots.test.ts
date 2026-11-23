import { describe, expect, it } from "vitest"
import { buildEditorPageRoots, HOME_ROOT_KEY, UNPLACED_ROOT_KEY } from "./editor-page-roots"
import type { PortalPageOutline, PortalPageOutlinePage } from "./portal/page-outline"

interface F {
  id: string
  parent_folder_id: string | null
}
interface D {
  id: string
  folder_id: string | null
}

const f = (id: string, parent: string | null = null): F => ({ id, parent_folder_id: parent })
const d = (id: string, folder: string | null = null): D => ({ id, folder_id: folder })

function portal(overrides: Partial<PortalPageOutline> = {}): PortalPageOutline {
  return {
    slug: "docs",
    displayName: "Docs",
    scope: null,
    homePosition: 0,
    pages: [],
    ...overrides,
  }
}

function page(overrides: Partial<PortalPageOutlinePage> = {}): PortalPageOutlinePage {
  return {
    id: "p1",
    title: "API Reference",
    slug: "api-reference",
    scope: ["api"],
    presentation: "api_reference",
    ...overrides,
  }
}

function build(
  outline: PortalPageOutline,
  folders: F[],
  docs: D[],
  eligible: { folders?: F[]; docs?: D[] } = {},
) {
  return buildEditorPageRoots({
    portal: outline,
    folders,
    docs,
    scopeContext: { folders: eligible.folders ?? folders, docs: eligible.docs ?? docs },
  })
}

const ids = (items: Array<{ id: string }> | undefined) => (items ?? []).map((i) => i.id)

describe("buildEditorPageRoots", () => {
  it("leaves the tree alone when no page has content of its own", () => {
    expect(build(portal(), [f("a")], [])).toBeNull()
    expect(build(portal({ pages: [page({ scope: null })] }), [f("a")], [])).toBeNull()
  })

  it("gives a page its folder ahead of a Home that covers everything", () => {
    const tree = build(
      portal({ pages: [page()] }),
      [f("guides"), f("api"), f("payments", "api")],
      [d("loose"), d("charge", "payments")],
    )!

    expect(tree.roots.map((r) => r.title)).toEqual(["Documents", "API Reference"])
    const api = tree.roots[1]
    expect(ids(tree.foldersByParent.get(HOME_ROOT_KEY))).toEqual(["guides"])
    expect(ids(tree.docsByParent.get(HOME_ROOT_KEY))).toEqual(["loose"])
    // The reference shows the folder's groups, not the folder.
    expect(tree.hiddenFolderIds.has("api")).toBe(true)
    expect(ids(tree.foldersByParent.get(api.key))).toEqual(["payments"])
    expect(ids(tree.docsByParent.get("payments"))).toEqual(["charge"])
    expect(tree.rootKeyByItemId.get("charge")).toBe(api.key)
  })

  it("surfaces a promoted project root's sections at the top of Home", () => {
    const tree = build(
      portal({
        scope: [{ id: "root", promote: true, rootOnly: true }, "guide"],
        pages: [page()],
      }),
      [f("root"), f("guide", "root"), f("draft-section", "root"), f("api")],
      [d("intro", "root")],
    )!

    const home = tree.roots[0]
    expect(ids(tree.foldersByParent.get(HOME_ROOT_KEY))).toEqual(["guide"])
    expect(ids(tree.docsByParent.get(HOME_ROOT_KEY))).toEqual(["intro"])
    // A section Home does not list is not on the portal.
    expect(ids(tree.foldersByParent.get(UNPLACED_ROOT_KEY))).toEqual(["draft-section"])
    expect(tree.roots.at(-1)?.title).toBe("Not in portal")
    // Docs go into the root folder; folders would not show, so none go there.
    expect(home.docTargetFolderId).toBe("root")
    expect(home.folderTargetFolderId).toBeUndefined()
  })

  it("moves a nested folder a page includes to that page, leaving its parent", () => {
    const tree = build(
      portal({
        pages: [page({ title: "Changelog", scope: ["notes"], presentation: "changelog" })],
      }),
      [f("guides"), f("notes", "guides"), f("tutorials", "guides"), f("deep", "notes")],
      [d("n1", "notes")],
    )!

    const changelog = tree.roots[1]
    expect(ids(tree.foldersByParent.get(HOME_ROOT_KEY))).toEqual(["guides"])
    expect(ids(tree.foldersByParent.get("guides"))).toEqual(["tutorials"])
    // A landing or changelog page keeps its folder as a row.
    expect(ids(tree.foldersByParent.get(changelog.key))).toEqual(["notes"])
    expect(ids(tree.foldersByParent.get("notes"))).toEqual(["deep"])
    expect(changelog.docTargetFolderId).toBeUndefined()
  })

  it("keeps a page's path folder with Home when the page only reaches through it", () => {
    const tree = build(
      portal({
        pages: [
          page({
            title: "Guides",
            presentation: "landing",
            scope: [{ id: "guides", rootOnly: true }, "notes"],
          }),
        ],
      }),
      [f("guides"), f("notes", "guides"), f("tutorials", "guides")],
      [],
    )!

    expect(ids(tree.foldersByParent.get(HOME_ROOT_KEY))).toEqual(["guides"])
    expect(ids(tree.foldersByParent.get("guides"))).toEqual(["tutorials"])
    expect(ids(tree.foldersByParent.get(tree.roots[1].key))).toEqual(["notes"])
  })

  it("moves a document a page picks by itself to that page", () => {
    const tree = build(
      portal({
        pages: [page({ title: "Start", presentation: "landing", scope: [{ doc: "d2" }] })],
      }),
      [f("guides")],
      [d("d1", "guides"), d("d2", "guides")],
    )!

    const [home, start] = tree.roots
    expect(ids(tree.docsByParent.get("guides"))).toEqual(["d1"])
    expect(ids(tree.docsByParent.get(start.key))).toEqual(["d2"])
    expect(tree.rootKeyByItemId.get("d2")).toBe(start.key)
    expect(home.docTargetFolderId).toBeNull()
  })

  it("puts content the portal cannot show under Not in portal", () => {
    const tree = build(
      portal({ scope: ["guides"], pages: [page()] }),
      [f("guides"), f("api"), f("internal"), f("restricted")],
      [d("loose"), d("secret", "restricted")],
      { folders: [f("guides"), f("api"), f("internal")], docs: [d("loose")] },
    )!

    expect(ids(tree.foldersByParent.get(UNPLACED_ROOT_KEY))).toEqual([
      "internal",
      "restricted",
    ])
    // Home lists folders only, so loose docs are not on it.
    expect(ids(tree.docsByParent.get(UNPLACED_ROOT_KEY))).toEqual(["loose"])
    // Inside a placed folder a document stays with its folder.
    expect(ids(tree.docsByParent.get("restricted"))).toEqual(["secret"])
  })

  it("omits Not in portal when everything is on a page", () => {
    const tree = build(portal({ pages: [page()] }), [f("api"), f("guides")], [])!
    expect(tree.roots.some((root) => root.key === UNPLACED_ROOT_KEY)).toBe(false)
  })

  it("orders roots by the portal's navigation", () => {
    const tree = build(
      portal({
        homePosition: 1,
        pages: [
          page({ id: "a", title: "API Reference" }),
          page({ id: "b", title: "Mirror", scope: null }),
          page({ id: "c", title: "Changelog", scope: ["log"], presentation: "changelog" }),
        ],
      }),
      [f("api"), f("log")],
      [],
    )!

    expect(tree.roots.map((root) => root.title)).toEqual([
      "API Reference",
      "Documents",
      "Changelog",
    ])
  })

  it("targets the reference folder when an API page has exactly one", () => {
    const tree = build(portal({ pages: [page()] }), [f("api")], [])!
    const api = tree.roots[1]
    expect(api.docTargetFolderId).toBe("api")
    expect(api.folderTargetFolderId).toBe("api")
    expect(tree.roots[0].folderTargetFolderId).toBeNull()
  })

  it("marks a page whose folder was deleted, and not one that is just empty", () => {
    const deleted = build(portal({ pages: [page({ scope: ["gone"] })] }), [f("guides")], [])!
    expect(deleted.roots[1]).toMatchObject({ title: "API Reference", contentDeleted: true })
    expect(deleted.roots[0].contentDeleted).toBe(false)

    const empty = build(portal({ pages: [page()] }), [f("api"), f("guides")], [])!
    expect(empty.roots[1].contentDeleted).toBe(false)
  })

  it("finishes on a folder loop in the data", () => {
    const tree = build(
      portal({ pages: [page()] }),
      [f("a", "b"), f("b", "a"), f("api")],
      [d("x", "a")],
    )
    expect(tree).not.toBeNull()
    expect(tree!.rootKeyByItemId.get("x")).toBe(UNPLACED_ROOT_KEY)
  })
})

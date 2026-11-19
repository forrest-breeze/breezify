import { describe, expect, it } from "vitest"
import { buildEditorPageRoots, UNPLACED_ROOT_KEY } from "./editor-page-roots"
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

function project(overrides: Partial<PortalPageOutline> = {}): PortalPageOutline {
  return {
    slug: "docs",
    displayName: "Docs",
    isDefault: true,
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
  projects: PortalPageOutline[],
  folders: F[],
  docs: D[],
  eligible: { folders?: F[]; docs?: D[] } = {},
) {
  return buildEditorPageRoots({
    projects,
    folders,
    docs,
    scopeContext: { folders: eligible.folders ?? folders, docs: eligible.docs ?? docs },
  })
}

const ids = (items: Array<{ id: string }> | undefined) => (items ?? []).map((i) => i.id)

describe("buildEditorPageRoots", () => {
  it("leaves the tree alone when no page has content of its own", () => {
    expect(build([project()], [f("a")], [])).toBeNull()
    expect(
      build([project({ pages: [page({ scope: null })] })], [f("a")], []),
    ).toBeNull()
  })

  it("gives a page its folder ahead of a Home that covers everything", () => {
    const tree = build(
      [project({ pages: [page()] })],
      [f("guides"), f("api"), f("payments", "api")],
      [d("loose"), d("charge", "payments")],
    )!

    expect(tree.roots.map((r) => r.title)).toEqual(["Documents", "API Reference"])
    const [home, api] = tree.roots
    expect(ids(tree.foldersByParent.get(home.key))).toEqual(["guides"])
    expect(ids(tree.docsByParent.get(home.key))).toEqual(["loose"])
    // The reference shows the folder's groups, not the folder.
    expect(tree.hiddenFolderIds.has("api")).toBe(true)
    expect(ids(tree.foldersByParent.get(api.key))).toEqual(["payments"])
    expect(ids(tree.docsByParent.get("payments"))).toEqual(["charge"])
    expect(tree.rootKeyByItemId.get("charge")).toBe(api.key)
  })

  it("surfaces a promoted project root's sections at the top of Home", () => {
    const tree = build(
      [
        project({
          scope: [{ id: "root", promote: true, rootOnly: true }, "guide"],
          pages: [page()],
        }),
      ],
      [f("root"), f("guide", "root"), f("draft-section", "root"), f("api")],
      [d("intro", "root")],
    )!

    const home = tree.roots[0]
    expect(ids(tree.foldersByParent.get(home.key))).toEqual(["guide"])
    expect(ids(tree.docsByParent.get(home.key))).toEqual(["intro"])
    // A section Home does not list is not on the portal.
    expect(ids(tree.foldersByParent.get(UNPLACED_ROOT_KEY))).toEqual(["draft-section"])
    expect(tree.roots.at(-1)?.title).toBe("Not in portal")
    // Docs go into the root folder; folders would not show, so none go there.
    expect(home.docTargetFolderId).toBe("root")
    expect(home.folderTargetFolderId).toBeUndefined()
  })

  it("moves a nested folder a page names directly to that page", () => {
    const tree = build(
      [
        project({
          pages: [page({ title: "Changelog", scope: ["notes"], presentation: "changelog" })],
        }),
      ],
      [f("guides"), f("notes", "guides"), f("deep", "notes")],
      [d("n1", "notes")],
    )!

    const [home, changelog] = tree.roots
    expect(ids(tree.foldersByParent.get(home.key))).toEqual(["guides"])
    expect(tree.foldersByParent.get("guides")).toBeUndefined()
    // A landing or changelog page keeps its folder as a row.
    expect(ids(tree.foldersByParent.get(changelog.key))).toEqual(["notes"])
    expect(ids(tree.foldersByParent.get("notes"))).toEqual(["deep"])
    expect(changelog.docTargetFolderId).toBeUndefined()
  })

  it("moves a document a page picks by itself to that page", () => {
    const tree = build(
      [project({ pages: [page({ title: "Start", presentation: "landing", scope: [{ doc: "d2" }] })] })],
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
      [project({ scope: ["guides"], pages: [page()] })],
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
    const tree = build([project({ pages: [page()] })], [f("api"), f("guides")], [])!
    expect(tree.roots.some((root) => root.key === UNPLACED_ROOT_KEY)).toBe(false)
  })

  it("orders roots by the portal's navigation and labels other portals", () => {
    const tree = build(
      [
        project({
          homePosition: 1,
          pages: [
            page({ id: "a", title: "API Reference" }),
            page({ id: "b", title: "Mirror", scope: null }),
            page({ id: "c", title: "Changelog", scope: ["log"], presentation: "changelog" }),
          ],
        }),
        project({
          slug: "help",
          displayName: "Help Center",
          isDefault: false,
          scope: [{ id: "help-root", promote: true }],
          pages: [page({ id: "faq", title: "FAQ", scope: ["faq"], presentation: "landing" })],
        }),
      ],
      [f("api"), f("log"), f("help-root"), f("faq"), f("article", "help-root")],
      [],
    )!

    expect(tree.roots.map((root) => root.title)).toEqual([
      "API Reference",
      "Documents",
      "Changelog",
      "Help Center",
      "Help Center · FAQ",
    ])
    const helpHome = tree.roots[3]
    expect(ids(tree.foldersByParent.get(helpHome.key))).toEqual(["article"])
    expect(helpHome.docTargetFolderId).toBe("help-root")
    expect(helpHome.folderTargetFolderId).toBe("help-root")
  })

  it("targets the reference folder when an API page has exactly one", () => {
    const tree = build([project({ pages: [page()] })], [f("api")], [])!
    const api = tree.roots[1]
    expect(api.docTargetFolderId).toBe("api")
    expect(api.folderTargetFolderId).toBe("api")
    expect(tree.roots[0].folderTargetFolderId).toBeNull()
  })

  it("survives a folder cycle in the data", () => {
    const tree = build(
      [project({ pages: [page()] })],
      [f("a", "b"), f("b", "a"), f("api")],
      [],
    )
    expect(tree).not.toBeNull()
  })
})

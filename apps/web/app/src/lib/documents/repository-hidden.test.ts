import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"

import {
  foldersHiddenByRepository,
  repositoryHiddenFolderIds,
  isRepositoryHiddenDocument,
  isRepositoryHiddenFolderIndex,
} from "@/lib/documents/repository-hidden"

describe("isRepositoryHiddenDocument", () => {
  it("reads the flag from the metadata object or the select alias", () => {
    expect(isRepositoryHiddenDocument({ source_metadata: { readme_hidden: true } })).toBe(true)
    expect(isRepositoryHiddenDocument({ readme_hidden: true })).toBe(true)
    expect(isRepositoryHiddenDocument({ readme_hidden: "true" })).toBe(true)
  })

  it("treats a missing, false or malformed flag as not hidden", () => {
    expect(isRepositoryHiddenDocument({})).toBe(false)
    expect(isRepositoryHiddenDocument({ source_metadata: null, readme_hidden: null })).toBe(false)
    expect(isRepositoryHiddenDocument({ source_metadata: { readme_hidden: false } })).toBe(false)
    expect(isRepositoryHiddenDocument({ source_metadata: "readme_hidden" })).toBe(false)
  })
})

describe("isRepositoryHiddenFolderIndex", () => {
  it("reads the landing page's hidden frontmatter", () => {
    expect(isRepositoryHiddenFolderIndex({ index_frontmatter: { hidden: true } })).toBe(true)
    expect(isRepositoryHiddenFolderIndex({ index_frontmatter: { hidden: false } })).toBe(false)
    expect(isRepositoryHiddenFolderIndex({ index_frontmatter: null })).toBe(false)
    expect(isRepositoryHiddenFolderIndex(null)).toBe(false)
  })
})

describe("foldersHiddenByRepository", () => {
  const folders = [
    { id: "guide", parent_folder_id: null },
    { id: "payouts", parent_folder_id: "guide" },
    { id: "tax", parent_folder_id: "guide" },
    { id: "archive", parent_folder_id: null },
    { id: "archive-old", parent_folder_id: "archive" },
    { id: "empty", parent_folder_id: null },
  ]
  const hiddenFolders = (content: {
    hiddenIndex?: string[]
    withLanding?: string[]
    withVisibleDocs?: string[]
    withHiddenDocs?: string[]
  }): string[] =>
    Array.from(
      foldersHiddenByRepository(folders, {
        hiddenIndex: new Set(content.hiddenIndex),
        withLanding: new Set(content.withLanding),
        withVisibleDocs: new Set(content.withVisibleDocs),
        withHiddenDocs: new Set(content.withHiddenDocs),
      }),
    ).sort()

  it("hides a folder with a hidden landing page and no visible pages", () => {
    expect(hiddenFolders({ hiddenIndex: ["payouts"] })).toEqual(["payouts"])
  })

  it("keeps a folder with a hidden landing page that still has visible pages", () => {
    expect(hiddenFolders({ hiddenIndex: ["tax"], withVisibleDocs: ["tax"] })).toEqual([])
  })

  it("hides a folder whose pages are all hidden, landing page or not", () => {
    // A plain category: no landing page, every page `hidden: true`.
    expect(hiddenFolders({ withHiddenDocs: ["payouts"] })).toEqual(["payouts"])
    // One visible page is enough to keep it.
    expect(hiddenFolders({ withHiddenDocs: ["payouts"], withVisibleDocs: ["payouts"] })).toEqual([])
  })

  it("keeps a folder whose own landing page is public", () => {
    expect(hiddenFolders({ withHiddenDocs: ["payouts"], withLanding: ["payouts"] })).toEqual([])
  })

  it("hides a parent only once every child folder is hidden too", () => {
    expect(hiddenFolders({ hiddenIndex: ["archive", "archive-old"] })).toEqual([
      "archive",
      "archive-old",
    ])
    // A parent with nothing of its own goes with its last child.
    expect(hiddenFolders({ withHiddenDocs: ["archive-old"] })).toEqual(["archive", "archive-old"])
    // `tax` is empty, not hidden, so it stays and keeps `guide`.
    expect(hiddenFolders({ withHiddenDocs: ["payouts"] })).toEqual(["payouts"])
    // And a parent with a visible page of its own stays whatever is beneath it.
    expect(hiddenFolders({ withHiddenDocs: ["archive-old"], withVisibleDocs: ["archive"] })).toEqual([
      "archive-old",
    ])
  })

  it("never hides a folder that is merely empty", () => {
    expect(hiddenFolders({})).toEqual([])
    // Not even with a hidden landing page on a sibling.
    expect(hiddenFolders({ hiddenIndex: ["payouts"] })).not.toContain("empty")
    expect(hiddenFolders({ hiddenIndex: ["payouts"] })).not.toContain("tax")
  })
})

describe("repositoryHiddenFolderIds", () => {
  interface FolderRow {
    id: string
    parent_folder_id: string | null
    content?: string | null
    indexHidden?: boolean
  }
  interface DocRow {
    id: string
    folder_id: string | null
    hidden?: boolean
  }

  /** The few PostgREST calls the lookup makes, answered from rows in memory. */
  function fakeClient(folders: FolderRow[], documents: DocRow[]): SupabaseClient {
    const from = (table: string) => {
      const state = { hiddenOnly: false, ids: null as string[] | null, range: null as [number, number] | null }
      const query = {
        select: () => query,
        is: () => query,
        not: () => query,
        order: () => query,
        eq: (column: string) => {
          if (column.includes("hidden")) state.hiddenOnly = true
          return query
        },
        in: (column: string, values: string[]) => {
          if (column === "folder_id" || column === "id") state.ids = values
          return query
        },
        range: (start: number, end: number) => {
          state.range = [start, end]
          return query
        },
        then: (resolve: (value: { data: unknown[]; error: null }) => void) => {
          let data: unknown[]
          if (table === "folders") {
            data = folders
              .filter((folder) => (state.hiddenOnly ? folder.indexHidden === true : true))
              .filter((folder) => (state.ids ? state.ids.includes(folder.id) : true))
              .map((folder) => ({ id: folder.id, content: folder.content ?? null }))
          } else {
            data = documents
              .filter((doc) => (state.hiddenOnly ? doc.hidden === true : true))
              .filter((doc) => (state.ids ? doc.folder_id !== null && state.ids.includes(doc.folder_id) : true))
              .map((doc) => ({ id: doc.id, folder_id: doc.folder_id, readme_hidden: doc.hidden ?? null }))
            if (state.range) data = data.slice(state.range[0], state.range[1] + 1)
          }
          resolve({ data, error: null })
        },
      }
      return query
    }
    return { from } as unknown as SupabaseClient
  }

  // A docs repository as ReadMe lays it out: categories with pages, some of
  // them kept off the site with `hidden: true`.
  const folders: FolderRow[] = [
    { id: "guide", parent_folder_id: null },
    { id: "payouts", parent_folder_id: "guide", indexHidden: true },
    { id: "onboarding", parent_folder_id: null },
    { id: "markets", parent_folder_id: null, content: "  " },
    { id: "intro", parent_folder_id: null, content: "Welcome." },
    { id: "internal", parent_folder_id: null },
    { id: "internal-notes", parent_folder_id: "internal" },
    { id: "empty", parent_folder_id: null },
  ]
  const documents: DocRow[] = [
    { id: "d1", folder_id: "guide" },
    { id: "d2", folder_id: "guide", hidden: true },
    { id: "d3", folder_id: "payouts", hidden: true },
    { id: "d4", folder_id: "onboarding", hidden: true },
    { id: "d5", folder_id: "onboarding", hidden: true },
    { id: "d6", folder_id: "markets", hidden: true },
    { id: "d7", folder_id: "intro", hidden: true },
    { id: "d8", folder_id: "internal-notes", hidden: true },
    { id: "d9", folder_id: null, hidden: true },
  ]

  it("hides every folder with nothing public in or under it", async () => {
    const hidden = await repositoryHiddenFolderIds(fakeClient(folders, documents), "ws-1", folders)
    expect(Array.from(hidden).sort()).toEqual([
      // Only hidden pages below it, in a child folder.
      "internal",
      "internal-notes",
      // No landing page worth the name, one hidden page.
      "markets",
      // Every page hidden.
      "onboarding",
      // Hidden landing page, hidden page.
      "payouts",
    ])
    // `guide` has a visible page, `intro` a public landing page, and `empty`
    // was never hidden by anyone.
  })

  it("asks for nothing more when the repository hides nothing", async () => {
    const visible = documents.map((doc) => ({ ...doc, hidden: false }))
    const plain = folders.map((folder) => ({ ...folder, indexHidden: false }))
    expect((await repositoryHiddenFolderIds(fakeClient(plain, visible), "ws-1", plain)).size).toBe(0)
  })

  it("only considers the folders the public can otherwise see", async () => {
    const listed = folders.filter((folder) => folder.id !== "onboarding")
    const hidden = await repositoryHiddenFolderIds(fakeClient(folders, documents), "ws-1", listed)
    expect(hidden.has("onboarding")).toBe(false)
  })
})

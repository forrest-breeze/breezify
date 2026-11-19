import { describe, expect, it } from "vitest"

import {
  foldersHiddenByRepository,
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

  it("hides a folder with a hidden landing page and no visible pages", () => {
    const hidden = foldersHiddenByRepository(folders, new Set(["payouts"]), new Set())
    expect(Array.from(hidden)).toEqual(["payouts"])
  })

  it("keeps a folder with a hidden landing page that still has visible pages", () => {
    const hidden = foldersHiddenByRepository(folders, new Set(["tax"]), new Set(["tax"]))
    expect(hidden.size).toBe(0)
  })

  it("hides a parent only once every child folder is hidden too", () => {
    expect(
      Array.from(
        foldersHiddenByRepository(folders, new Set(["archive", "archive-old"]), new Set()),
      ).sort(),
    ).toEqual(["archive", "archive-old"])
    // `archive-old` has no hidden landing page, so it stays and keeps its parent.
    expect(foldersHiddenByRepository(folders, new Set(["archive"]), new Set()).size).toBe(0)
  })

  it("never hides a folder that is merely empty", () => {
    expect(foldersHiddenByRepository(folders, new Set(), new Set()).size).toBe(0)
  })
})

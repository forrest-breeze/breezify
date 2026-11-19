import { describe, expect, it } from "vitest"

import {
  FOLDER_SCOPE_CHOICES,
  MEMBERS_FOLDER_SCOPE,
  PUBLIC_FOLDER_SCOPE,
  folderScopeFor,
  folderScopeKey,
  isPublicFolderScope,
  nonPublicFolderIds,
} from "@/lib/folder-visibility"

describe("folder scopes", () => {
  it("has exactly two choices, Public and Members", () => {
    expect(FOLDER_SCOPE_CHOICES.map((choice) => choice.label)).toEqual(["Public", "Members"])
    expect(folderScopeKey(PUBLIC_FOLDER_SCOPE)).toBe("public")
    expect(folderScopeKey(MEMBERS_FOLDER_SCOPE)).toBe("members")
  })

  it("stores any visibility that is not Public as Members", () => {
    expect(folderScopeFor("workspace")).toEqual(PUBLIC_FOLDER_SCOPE)
    expect(folderScopeFor("role")).toEqual(MEMBERS_FOLDER_SCOPE)
    expect(folderScopeFor(null)).toEqual(MEMBERS_FOLDER_SCOPE)
    expect(isPublicFolderScope(MEMBERS_FOLDER_SCOPE)).toBe(false)
  })
})

describe("nonPublicFolderIds", () => {
  const folders = [
    { id: "guide", parent_folder_id: null, visibility: "workspace" },
    { id: "tax", parent_folder_id: "guide", visibility: "workspace" },
    { id: "offramp", parent_folder_id: "guide", visibility: "role" },
    // Public by its own setting, but inside a Members folder.
    { id: "offramp-flows", parent_folder_id: "offramp", visibility: "workspace" },
    { id: "offramp-flows-eu", parent_folder_id: "offramp-flows", visibility: "workspace" },
  ]

  it("includes every folder beneath one that is not public", () => {
    expect(Array.from(nonPublicFolderIds(folders)).sort()).toEqual([
      "offramp",
      "offramp-flows",
      "offramp-flows-eu",
    ])
  })

  it("is empty when every folder is public", () => {
    expect(nonPublicFolderIds(folders.filter((folder) => !folder.id.startsWith("offramp"))).size).toBe(0)
  })
})

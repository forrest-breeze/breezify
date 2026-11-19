import { beforeEach, describe, expect, it, vi } from "vitest"

// getRootPortalPageOutline: the editor tree groups by the pages of ONE portal,
// the one the builder edits. Projects left from before a workspace had one
// portal must not show up as roots.

const hoisted = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: hoisted.createAdminClient,
}))

vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
  revalidateTag: vi.fn(),
}))

vi.mock("@/lib/workspace-settings", () => ({
  getKbBranding: () => ({ name: "Acme", tagline: "", logoUrl: "", accentColor: "#000" }),
  getKbPrimaryProject: () => null,
  getKbFooter: () => null,
  getKbHeader: () => null,
  getPortalChromeScope: () => "workspace",
}))

import { getRootPortalPageOutline } from "./experiences-write"

const WORKSPACE_ID = "d44b116a-99ce-4cbf-ab04-d395266d6a62"
const WORKSPACE_SLUG = "acme"
const API_FOLDER = "00000000-0000-4000-8000-0000000000a1"
const OLD_FOLDER = "00000000-0000-4000-8000-0000000000b1"

interface Row {
  id: string
  slug: string
  scope: unknown
  status: string
  version: number
  name: string | null
  spec: unknown
  updated_at: string
}

function apiPage(id: string, scope: string[]) {
  return { id, title: "API Reference", slug: "api-reference", scope, presentation: "api_reference" }
}

function mockAdmin(rows: Row[]): void {
  const workspaceBuilder = {
    select: vi.fn(() => workspaceBuilder),
    eq: vi.fn(() => workspaceBuilder),
    maybeSingle: vi.fn(async () => ({
      data: { slug: WORKSPACE_SLUG, name: "Acme" },
      error: null,
    })),
  }
  hoisted.createAdminClient.mockImplementation(() => ({
    from: vi.fn((table: string) => {
      if (table === "workspaces") return workspaceBuilder
      let slug: string | null = null
      const expBuilder = {
        select: vi.fn(() => expBuilder),
        eq: vi.fn((column: string, value: string) => {
          if (column === "slug") slug = value
          return expBuilder
        }),
        // listPortalProjects: every row.
        order: vi.fn(async () => ({ data: rows, error: null })),
        // The layout lookup: the root project's draft and published rows.
        in: vi.fn(async (_column: string, statuses: string[]) => ({
          data: rows.filter((row) => row.slug === slug && statuses.includes(row.status)),
          error: null,
        })),
      }
      return expBuilder
    }),
  }))
}

describe("getRootPortalPageOutline", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("returns only the root portal, not a project left from before", async () => {
    mockAdmin([
      {
        id: "root-published",
        slug: WORKSPACE_SLUG,
        scope: null,
        status: "published",
        version: 3,
        name: null,
        spec: { pages: [apiPage("p-old", [OLD_FOLDER])] },
        updated_at: "2026-11-01",
      },
      {
        id: "root-draft",
        slug: WORKSPACE_SLUG,
        scope: null,
        status: "draft",
        version: 4,
        name: null,
        spec: { pages: [apiPage("p-api", [API_FOLDER])], homePosition: 0 },
        updated_at: "2026-11-02",
      },
      {
        id: "leftover",
        slug: "breeze",
        scope: null,
        status: "published",
        version: 1,
        name: "Breeze",
        spec: { pages: [] },
        updated_at: "2026-11-03",
      },
    ])

    const outline = await getRootPortalPageOutline(WORKSPACE_ID)

    expect(outline?.slug).toBe(WORKSPACE_SLUG)
    // The draft is what the builder is editing, so it wins over published.
    expect(outline?.pages.map((page) => page.id)).toEqual(["p-api"])
    expect(outline?.pages[0]?.scope).toEqual([API_FOLDER])
  })

  it("uses the first project when none has the workspace slug", async () => {
    mockAdmin([
      {
        id: "docs",
        slug: "docs",
        scope: null,
        status: "published",
        version: 1,
        name: "Docs",
        spec: { pages: [apiPage("p-api", [API_FOLDER])] },
        updated_at: "2026-11-01",
      },
    ])

    const outline = await getRootPortalPageOutline(WORKSPACE_ID)

    expect(outline?.slug).toBe("docs")
    expect(outline?.pages).toHaveLength(1)
  })
})

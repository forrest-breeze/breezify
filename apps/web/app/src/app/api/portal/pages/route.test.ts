import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockRequireRouteUser, mockGetActiveWorkspace, mockListPortalPageOutlines } =
  vi.hoisted(() => ({
    mockRequireRouteUser: vi.fn(),
    mockGetActiveWorkspace: vi.fn(),
    mockListPortalPageOutlines: vi.fn(),
  }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}))

vi.mock("@/lib/auth/route-auth", () => ({
  requireRouteUser: mockRequireRouteUser,
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: mockGetActiveWorkspace,
}))

vi.mock("@/lib/portal/experiences-write", () => ({
  listPortalPageOutlines: mockListPortalPageOutlines,
}))

import { GET } from "./route"

describe("GET /api/portal/pages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireRouteUser.mockResolvedValue({ user: { id: "user-1" }, response: null })
    mockListPortalPageOutlines.mockResolvedValue([
      {
        slug: "docs",
        displayName: "Docs",
        isDefault: true,
        scope: null,
        homePosition: 0,
        pages: [],
      },
    ])
  })

  it("serves any workspace member, not only admins", async () => {
    mockGetActiveWorkspace.mockResolvedValue({
      id: "member-1",
      workspace_id: "ws-1",
      role: "editor",
    })

    const res = await GET()

    expect(res.status).toBe(200)
    expect(mockListPortalPageOutlines).toHaveBeenCalledWith("ws-1")
    const body = (await res.json()) as { projects: Array<{ slug: string }> }
    expect(body.projects.map((p) => p.slug)).toEqual(["docs"])
  })

  it("requires a signed-in user", async () => {
    const unauthorized = new Response(null, { status: 401 })
    mockRequireRouteUser.mockResolvedValue({ user: null, response: unauthorized })

    const res = await GET()

    expect(res.status).toBe(401)
    expect(mockListPortalPageOutlines).not.toHaveBeenCalled()
  })

  it("requires an active workspace", async () => {
    mockGetActiveWorkspace.mockResolvedValue(null)

    const res = await GET()

    expect(res.status).toBe(400)
    expect(mockListPortalPageOutlines).not.toHaveBeenCalled()
  })

  it("reports a failed lookup without details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockGetActiveWorkspace.mockResolvedValue({
      id: "member-1",
      workspace_id: "ws-1",
      role: "viewer",
    })
    mockListPortalPageOutlines.mockRejectedValue(new Error("db down"))

    const res = await GET()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to load portal pages" })
  })
})

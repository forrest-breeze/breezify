/**
 * /api/team POST/PUT/DELETE — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
  countActiveMembers: vi.fn(),
}))

vi.mock("@/lib/db/subscription", () => ({
  getWorkspaceSubscription: vi.fn(),
}))

vi.mock("@/lib/billing/catalog", () => ({
  getBillingPlan: vi.fn(),
  isBillingPlanId: vi.fn(() => true),
}))

vi.mock("@/lib/email", () => ({
  sendInviteEmail: vi.fn(),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST, PUT, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makeRequest(method: "POST" | "PUT", body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/team", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/team?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/team"
  return new NextRequest(url, { method: "DELETE" })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role: "admin",
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

describe("POST /api/team — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(
      makeRequest("POST", { email: "test@example.com" }),
    )
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", "{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 for missing email", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", {}))
    expect(res.status).toBe(400)
  })

  it("returns 400 for malformed email", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", { email: "not-an-email" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for unknown role", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest("POST", { email: "test@example.com", role: "wizard" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-boolean resend", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest("POST", {
        email: "test@example.com",
        resend: "yes" as unknown as boolean,
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe("PUT /api/team — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for missing member_id", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { role: "editor" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-uuid member_id", async () => {
    mockAuthed()
    const res = await PUT(
      makeRequest("PUT", { member_id: "not-a-uuid", role: "editor" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for unknown role", async () => {
    mockAuthed()
    const res = await PUT(
      makeRequest("PUT", { member_id: VALID_UUID, role: "wizard" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for missing role", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { member_id: VALID_UUID }))
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/team — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 when id is missing", async () => {
    mockAuthed()
    const res = await DELETE(makeDeleteRequest())
    expect(res.status).toBe(400)
  })

  it("returns 400 when id is not a uuid", async () => {
    mockAuthed()
    const res = await DELETE(makeDeleteRequest("not-a-uuid"))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Permissions and deactivation
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/supabase/admin"
import { PATCH } from "./route"

type MemberRow = { id: string; workspace_id: string; user_id: string | null; role: string; status: string }

/** Tiny stand-in for the admin client's workspace_members queries. */
function fakeMembers(rows: MemberRow[]) {
  const calls: Array<{ op: string; payload?: unknown }> = []
  const from = () => {
    const filters: Array<(r: MemberRow) => boolean> = []
    let op = "select"
    let payload: Partial<MemberRow> = {}
    const matching = () => rows.filter((r) => filters.every((f) => f(r)))
    const run = () => {
      if (op === "update") {
        calls.push({ op, payload })
        for (const r of matching()) Object.assign(r, payload)
        return { data: matching()[0] ?? null, error: null }
      }
      if (op === "delete") {
        calls.push({ op })
        const doomed = new Set(matching())
        rows.splice(0, rows.length, ...rows.filter((r) => !doomed.has(r)))
        return { data: null, error: null }
      }
      return { data: matching()[0] ?? null, error: null }
    }
    const b = {
      select: () => b,
      update: (p: Partial<MemberRow>) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (col: keyof MemberRow, val: unknown) => (filters.push((r) => r[col] === val), b),
      single: async () => run(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return b
  }
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createAdminClient>)
  return { rows, calls }
}

function mockRole(role: string): void {
  mockAuthed()
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role,
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

const TARGET = "660e8400-e29b-41d4-a716-446655440001"

describe("/api/team — admin-only member management", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ["POST", () => POST(makeRequest("POST", { email: "x@breeze.com", role: "viewer" }))],
    ["PUT", () => PUT(makeRequest("PUT", { member_id: TARGET, role: "viewer" }))],
    ["DELETE", () => DELETE(makeDeleteRequest(TARGET))],
    [
      "PATCH",
      () =>
        PATCH(
          new NextRequest("https://app.example.dev/api/team", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ member_id: TARGET, status: "active" }),
          }),
        ),
    ],
  ])("%s returns 403 for an editor", async (_method, call) => {
    mockRole("editor")
    const res = await call()
    expect(res.status).toBe(403)
  })

  it("DELETE deactivates a joined member instead of deleting the row", async () => {
    mockRole("admin")
    const { rows } = fakeMembers([
      { id: TARGET, workspace_id: "ws-1", user_id: "user-2", role: "editor", status: "active" },
    ])
    const res = await DELETE(makeDeleteRequest(TARGET))
    expect(res.status).toBe(200)
    expect(rows).toEqual([expect.objectContaining({ id: TARGET, status: "deactivated" })])
  })

  it("DELETE removes a pending invite outright", async () => {
    mockRole("admin")
    const { rows } = fakeMembers([
      { id: TARGET, workspace_id: "ws-1", user_id: null, role: "viewer", status: "invited" },
    ])
    const res = await DELETE(makeDeleteRequest(TARGET))
    expect(res.status).toBe(200)
    expect(rows).toEqual([])
  })

  it("PATCH reactivates a deactivated member", async () => {
    mockRole("admin")
    const { rows } = fakeMembers([
      { id: TARGET, workspace_id: "ws-1", user_id: "user-2", role: "editor", status: "deactivated" },
    ])
    const res = await PATCH(
      new NextRequest("https://app.example.dev/api/team", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ member_id: TARGET, status: "active" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(rows[0]!.status).toBe("active")
  })

  it("PATCH refuses to deactivate a higher-ranked member", async () => {
    mockRole("admin")
    fakeMembers([
      { id: TARGET, workspace_id: "ws-1", user_id: "user-2", role: "owner", status: "active" },
    ])
    const res = await PATCH(
      new NextRequest("https://app.example.dev/api/team", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ member_id: TARGET, status: "deactivated" }),
      }),
    )
    expect(res.status).toBe(403)
  })

  it("PUT refuses to change your own role", async () => {
    mockAuthed()
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: TARGET,
      workspace_id: "ws-1",
      role: "owner",
    } as Awaited<ReturnType<typeof getActiveWorkspace>>)
    fakeMembers([{ id: TARGET, workspace_id: "ws-1", user_id: "user-1", role: "owner", status: "active" }])
    const res = await PUT(makeRequest("PUT", { member_id: TARGET, role: "viewer" }))
    expect(res.status).toBe(400)
  })
})

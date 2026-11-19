import { beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getAuthUser: vi.fn(),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: hoisted.createAdminClient,
}))

vi.mock("@/lib/auth/get-auth-user", () => ({
  getAuthUser: hoisted.getAuthUser,
}))

import {
  expandScope,
  getPortalWorkspace,
  getPublicDocument,
  getPublicDocumentLinks,
  getPublicFolderDetail,
  isScopeProvided,
  normalizeScopeKey,
  searchPublic,
  searchPublicForQuestion,
  visibleDocFilter,
} from "@/lib/public-kb"

function query(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  }
  return builder
}

// Documents-table builder that honours both the `document_type` allowlist
// (`.in()`) AND the id-or-slug lookup (`.eq("id" | "public_slug", value)`) the
// same way PostgREST would: a row whose type is not in the allowlist, or whose
// looked-up column doesn't match, resolves to null. Proves getPublicDocument's
// document_type guard AND its UUID-or-slug resolution both work.
function documentsQuery(
  row: { id: string; public_slug?: string | null; document_type: string } & Record<
    string,
    unknown
  >,
) {
  let typeAllowed = true
  let refMatches = true
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: string) => {
      if (column === "id") refMatches = row.id === value
      if (column === "public_slug") refMatches = (row.public_slug ?? null) === value
      return builder
    }),
    in: vi.fn((column: string, values: string[]) => {
      if (column === "document_type") typeAllowed = values.includes(row.document_type)
      return builder
    }),
    maybeSingle: vi.fn(async () => ({
      data: typeAllowed && refMatches ? row : null,
      error: null,
    })),
  }
  return builder
}

// Mirrors PostgREST `ilike` for the `%term%` patterns searchPublic sends.
function ilikeMatches(value: string, pattern: string): boolean {
  const needle = pattern.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1").toLowerCase()
  return value.toLowerCase().includes(needle)
}

function thenableQuery(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn(() => builder),
    or: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: vi.fn(
      (
        onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(onfulfilled, onrejected),
    ),
  }
  return builder
}

interface PublicDocRow {
  id: string
  public_slug?: string | null
  title: string
  source: string | null
  document_type: string
  /** The `readme_hidden:source_metadata->readme_hidden` select alias. */
  readme_hidden?: unknown
}

function publicDocsQuery(rows: PublicDocRow[]) {
  let allowedIds: string[] | null = null
  let allowedTypes: string[] | null = null
  let titlePattern: string | null = null

  const builder = {
    // Each `.select()` starts a fresh query on this shared builder.
    select: vi.fn(() => {
      allowedIds = null
      allowedTypes = null
      titlePattern = null
      return builder
    }),
    ilike: vi.fn((column: string, pattern: string) => {
      if (column === "title") titlePattern = pattern
      return builder
    }),
    limit: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    or: vi.fn(() => builder),
    in: vi.fn((column: string, values: string[]) => {
      if (column === "id") allowedIds = values
      if (column === "document_type") allowedTypes = values
      return builder
    }),
    then: vi.fn(
      (
        onfulfilled?: (value: { data: PublicDocRow[]; error: null }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => {
        const filtered = rows.filter((row) => {
          const idAllowed = !allowedIds || allowedIds.includes(row.id)
          const typeAllowed =
            !allowedTypes || allowedTypes.includes(row.document_type)
          const titleAllowed = !titlePattern || ilikeMatches(row.title, titlePattern)
          return idAllowed && typeAllowed && titleAllowed
        })
        return Promise.resolve({ data: filtered, error: null }).then(
          onfulfilled,
          onrejected,
        )
      },
    ),
  }
  return builder
}

// A documents-table builder that ALSO honours the folder `.or()` filter, so a
// scoped read (`folder_id.in.(…)`) drops docs whose folder is out of scope. Each
// row carries a `folder_id`; the `.or()` string from visibleDocFilter is parsed
// to the allowed folder-id set (and whether workspace-level docs are allowed).
interface ScopedDocRow extends PublicDocRow {
  folder_id: string | null
}

function scopedDocsQuery(rows: ScopedDocRow[]) {
  let allowedIds: string[] | null = null
  let allowedTypes: string[] | null = null
  let titlePattern: string | null = null
  let allowFolderIds: Set<string> | null = null
  let allowNullFolder = true

  const builder = {
    // Each `.select()` starts a fresh query on this shared builder.
    select: vi.fn(() => {
      allowedIds = null
      allowedTypes = null
      titlePattern = null
      return builder
    }),
    ilike: vi.fn((column: string, pattern: string) => {
      if (column === "title") titlePattern = pattern
      return builder
    }),
    limit: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn((column: string, values: string[]) => {
      if (column === "id") allowedIds = values
      if (column === "document_type") allowedTypes = values
      return builder
    }),
    or: vi.fn((filter: string) => {
      // visibleDocFilter shapes: "folder_id.is.null,folder_id.in.(a,b)" (unscoped)
      // or "folder_id.in.(a,b)" (scoped — workspace-level docs excluded).
      allowNullFolder = filter.includes("folder_id.is.null")
      const match = filter.match(/folder_id\.in\.\(([^)]*)\)/)
      allowFolderIds = match
        ? new Set(match[1].split(",").filter((id) => id.length > 0))
        : new Set<string>()
      return builder
    }),
    then: vi.fn(
      (
        onfulfilled?: (value: { data: ScopedDocRow[]; error: null }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => {
        const filtered = rows.filter((row) => {
          const idAllowed = !allowedIds || allowedIds.includes(row.id)
          const typeAllowed =
            !allowedTypes || allowedTypes.includes(row.document_type)
          let folderAllowed = true
          if (allowFolderIds !== null) {
            folderAllowed =
              row.folder_id === null
                ? allowNullFolder
                : allowFolderIds.has(row.folder_id)
          }
          const titleAllowed = !titlePattern || ilikeMatches(row.title, titlePattern)
          return idAllowed && typeAllowed && titleAllowed && folderAllowed
        })
        return Promise.resolve({ data: filtered, error: null }).then(
          onfulfilled,
          onrejected,
        )
      },
    ),
  }
  return builder
}

function workspaceRow(slug: string, kbPublic: boolean) {
  return {
    id: `ws-${slug}`,
    name: "Acme",
    slug,
    icon_url: null,
    settings: { kb_public: kbPublic },
  }
}

function expectedWorkspace(slug: string, isPublic: boolean) {
  return {
    id: `ws-${slug}`,
    name: "Acme",
    slug,
    iconUrl: null,
    isPublic,
    customDomain: "",
    portalAddressScope: "workspace",
    portalAddressMode: "breezify",
    portalChromeScope: "workspace",
    header: null,
    branding: {
      name: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
    },
    websiteUrl: "",
    footer: null,
  }
}

describe("getPortalWorkspace", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
    hoisted.getAuthUser.mockReset()
  })

  it("allows published workspaces without checking auth", async () => {
    const workspaceQuery = query({
      data: workspaceRow("published-portal", true),
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn(() => workspaceQuery),
    })

    const result = await getPortalWorkspace("published-portal")

    expect(result).toEqual({
      kind: "workspace",
      workspace: expectedWorkspace("published-portal", true),
    })
    expect(hoisted.getAuthUser).not.toHaveBeenCalled()
  })

  it("requires login for private workspaces when no user is signed in", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-login", false),
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn(() => workspaceQuery),
    })
    hoisted.getAuthUser.mockResolvedValue(null)

    await expect(getPortalWorkspace("private-login")).resolves.toEqual({
      kind: "login_required",
    })
  })

  it("allows private workspaces for active members", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-member", false),
      error: null,
    })
    const membershipQuery = query({
      data: { id: "membership-1" },
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membershipQuery : workspaceQuery,
      ),
    })
    hoisted.getAuthUser.mockResolvedValue({ id: "user-1" })

    const result = await getPortalWorkspace("private-member")

    expect(result).toEqual({
      kind: "workspace",
      workspace: expectedWorkspace("private-member", false),
    })
  })

  it("hides private workspaces from non-members", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-nonmember", false),
      error: null,
    })
    const membershipQuery = query({ data: null, error: null })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membershipQuery : workspaceQuery,
      ),
    })
    hoisted.getAuthUser.mockResolvedValue({ id: "user-1" })

    await expect(getPortalWorkspace("private-nonmember")).resolves.toEqual({
      kind: "not_found",
    })
  })

  it("fails closed when private portal auth check times out", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-auth-timeout", false),
      error: null,
    })
    const from = vi.fn(() => workspaceQuery)
    hoisted.createAdminClient.mockReturnValue({ from })
    hoisted.getAuthUser.mockRejectedValue(
      Object.assign(new Error("Auth check failed transiently"), {
        name: "AuthCheckError",
      }),
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(getPortalWorkspace("private-auth-timeout")).resolves.toEqual({
      kind: "not_found",
    })
    expect(from).not.toHaveBeenCalledWith("workspace_members")

    warn.mockRestore()
  })
})

describe("getPublicDocument document_type allowlist", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("does not return a topic_page fetched by slug", async () => {
    const docsQuery = documentsQuery({
      id: "doc-topic-page",
      public_slug: "synthesized-topic-page",
      title: "Synthesized topic page",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "topic_page",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "synthesized-topic-page")

    expect(result).toBeNull()
    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
  })

  it("does not return an unfiled GitHub repo file", async () => {
    const docsQuery = documentsQuery({
      id: "doc-github",
      public_slug: "repo-file",
      title: "acme/repo/docs/internal.md",
      content: "body",
      source: "GitHub",
      author: "GitHub",
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    expect(await getPublicDocument("ws-1", "repo-file")).toBeNull()
  })

  it("returns a visible source document with no folder", async () => {
    const docsQuery = documentsQuery({
      id: "doc-source",
      public_slug: "a-real-source",
      title: "A real source",
      content: "body",
      source: "slack",
      author: "alice",
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "a-real-source")

    expect(result).toEqual({
      id: "doc-source",
      slug: "a-real-source",
      // Sparse: only documents that declare a date carry one.
      published_at: null,
      title: "A real source",
      content: "body",
      source: "slack",
      author: "alice",
      cover: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
    })
  })

  it("returns a page document only when its folder is workspace-visible", async () => {
    const docsQuery = documentsQuery({
      id: "doc-page",
      public_slug: "a-page-in-a-folder",
      title: "A page in a folder",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: "folder-visible",
      deleted_at: null,
      document_type: "page",
    })
    const folderQuery = query({
      data: { visibility: "workspace" },
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "folders" ? folderQuery : docsQuery,
      ),
    })

    const result = await getPublicDocument("ws-1", "a-page-in-a-folder")

    expect(result?.id).toBe("doc-page")
    expect(result?.folder_id).toBe("folder-visible")
  })
})

describe("getPublicDocument id-or-slug resolution", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const UUID = "11111111-2222-3333-4444-555555555555"

  it("resolves a raw UUID via the id column (back-compat)", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: "human-readable",
      title: "By UUID",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", UUID)

    expect(result?.id).toBe(UUID)
    // UUID-shaped input must match on `id`, never `public_slug`.
    expect(docsQuery.eq).toHaveBeenCalledWith("id", UUID)
    expect(docsQuery.eq).not.toHaveBeenCalledWith("public_slug", UUID)
    // slug surfaces the public_slug so links can stay readable.
    expect(result?.slug).toBe("human-readable")
  })

  it("resolves a non-UUID value via the public_slug column", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: "developer-api-search",
      title: "By slug",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "developer-api-search")

    expect(result?.id).toBe(UUID)
    expect(result?.slug).toBe("developer-api-search")
    expect(docsQuery.eq).toHaveBeenCalledWith("public_slug", "developer-api-search")
    // Scoping preserved: workspace + document_type allowlist still applied.
    expect(docsQuery.eq).toHaveBeenCalledWith("workspace_id", "ws-1")
    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
  })

  it("falls back slug to id when public_slug is null", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: null,
      title: "No slug",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", UUID)

    expect(result?.slug).toBe(UUID)
  })

  it("404s (null) when a slug does not match", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: "real-slug",
      title: "Real",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "wrong-slug")

    expect(result).toBeNull()
  })
})

describe("public document producer document_type allowlist", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("drops topic_page rows from public document links", async () => {
    const outboundQuery = thenableQuery({
      data: [
        { target_document_id: "doc-topic-page", strength: "related" },
        { target_document_id: "doc-source", strength: "related" },
      ],
      error: null,
    })
    const inboundQuery = thenableQuery({ data: [], error: null })
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-topic-page",
        public_slug: null,
        title: "Synthesized topic page",
        source: null,
        document_type: "topic_page",
      },
      {
        id: "doc-source",
        public_slug: "visible-source",
        title: "Visible source",
        source: "slack",
        document_type: "source",
      },
    ])
    const linkQueries = [outboundQuery, inboundQuery]

    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "document_links") return linkQueries.shift() ?? inboundQuery
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const links = await getPublicDocumentLinks("ws-1", "doc-current")

    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
    expect(links.outbound).toEqual([
      {
        id: "doc-source",
        slug: "visible-source",
        title: "Visible source",
        source: "slack",
        document_type: "source",
        strength: "related",
      },
    ])
  })

  it("drops topic_page rows from public search hits", async () => {
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-topic-page",
        public_slug: null,
        title: "Synthesized topic page",
        source: null,
        document_type: "topic_page",
      },
      {
        id: "doc-source",
        public_slug: "visible-source",
        title: "Visible source",
        source: "slack",
        document_type: "source",
      },
    ])

    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          {
            document_id: "doc-topic-page",
            title: "Synthesized topic page",
            line_text: "topic page snippet",
          },
          {
            document_id: "doc-source",
            title: "Visible source",
            line_text: "source snippet",
          },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "snippet")

    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
    expect(hits).toEqual([
      {
        id: "doc-source",
        slug: "visible-source",
        title: "Visible source",
        source: "slack",
        snippet: "source snippet",
      },
    ])
  })

  it("returns readable plain-text snippets for Markdown search matches", async () => {
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-heading",
        public_slug: "connecting-integrations",
        title: "Connecting Integrations in Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-section",
        public_slug: "getting-started",
        title: "Getting Started with Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-markdown",
        public_slug: "security",
        title: "Security and Data Handling in Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-list",
        public_slug: "what-is-breezify",
        title: "What is Breezify?",
        source: null,
        document_type: "source",
      },
    ])

    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          {
            document_id: "doc-heading",
            title: "Connecting Integrations in Breezify",
            line_text: "# Connecting Integrations in Breezify",
          },
          {
            document_id: "doc-section",
            title: "Getting Started with Breezify",
            line_text: "## 2. Connect an Integration",
          },
          {
            document_id: "doc-markdown",
            title: "Security and Data Handling in Breezify",
            line_text:
              "When you connect Slack, tokens are **encrypted at rest** and `breezify-mcp` works.",
          },
          {
            document_id: "doc-list",
            title: "What is Breezify?",
            line_text:
              "- **Slack** — connect via OAuth; `@breezify` captures a conversation into the KB.",
          },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "connect")

    expect(hits.map((hit) => hit.snippet)).toEqual([
      "",
      "2. Connect an Integration",
      "When you connect Slack, tokens are encrypted at rest and breezify-mcp works.",
      "Slack — connect via OAuth; @breezify captures a conversation into the KB.",
    ])
  })

  it("ranks title matches ahead of earlier body-only matches", async () => {
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-body",
        public_slug: "connecting-integrations",
        title: "Connecting Integrations in Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-billing",
        public_slug: "account-billing",
        title: "Account and Billing",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-title",
        public_slug: "workspaces-roles-permissions",
        title: "Workspaces, Roles, and Permissions",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-snippet",
        public_slug: "security",
        title: "Security and Data Handling in Breezify",
        source: null,
        document_type: "source",
      },
    ])

    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          {
            document_id: "doc-body",
            title: "Connecting Integrations in Breezify",
            line_text:
              "Every integration embeds everything for semantic and workspace search.",
          },
          {
            document_id: "doc-billing",
            title: "Account and Billing",
            line_text: "Sign in as a workspace owner or admin.",
          },
          {
            document_id: "doc-snippet",
            title: "Security and Data Handling in Breezify",
            line_text: "Workspace isolation and row-level security",
          },
          {
            document_id: "doc-title",
            title: "Workspaces, Roles, and Permissions",
            line_text:
              "Breezify organizes your team's operational knowledge into workspaces.",
          },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "workspace")

    expect(hits.map((hit) => hit.id)).toEqual([
      "doc-title",
      "doc-snippet",
      "doc-body",
      "doc-billing",
    ])
  })
})

// A page marked `hidden: true` in its GitHub docs repository is unpublished:
// every read path must drop it, including the direct link.
describe("pages hidden in the GitHub docs repository", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  function repositoryPage(hidden: unknown) {
    return documentsQuery({
      id: "doc-apple-pay",
      public_slug: "apple-pay-direct-payment",
      title: "Apple Pay",
      content: "body",
      source: "github",
      author: null,
      updated_at: "2026-11-17T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
      source_metadata: { repo_format: "readme", readme_hidden: hidden },
    })
  }

  it("404s a hidden page fetched by its direct link", async () => {
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn(() => repositoryPage(true)),
    })

    await expect(getPublicDocument("ws-1", "apple-pay-direct-payment")).resolves.toBeNull()
  })

  it("still serves a repository page that is not hidden", async () => {
    // Unfiled GitHub captures are never navigable, so file this one.
    const docsQuery = documentsQuery({
      id: "doc-visible",
      public_slug: "quick-start",
      title: "Quick Start",
      content: "body",
      source: "github",
      author: null,
      updated_at: "2026-11-17T00:00:00Z",
      folder_id: "folder-guides",
      deleted_at: null,
      document_type: "source",
      source_metadata: { repo_format: "readme", readme_hidden: false },
    })
    const folderQuery = query({ data: { visibility: "workspace", kind: "user" }, error: null })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) => (table === "folders" ? folderQuery : docsQuery)),
    })

    const result = await getPublicDocument("ws-1", "quick-start")

    expect(result?.id).toBe("doc-visible")
  })

  it("drops hidden pages from search, by body and by title", async () => {
    const docsQuery = publicDocsQuery([
      {
        id: "doc-hidden",
        public_slug: "payout-overview",
        title: "Payout overview",
        source: null,
        document_type: "source",
        readme_hidden: true,
      },
      {
        id: "doc-visible",
        public_slug: "payout-page",
        title: "Payout page",
        source: null,
        document_type: "source",
        readme_hidden: false,
      },
    ])
    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          { document_id: "doc-hidden", title: "Payout overview", line_text: "payout internals" },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "payout")

    expect(hits.map((hit) => hit.id)).toEqual(["doc-visible"])
  })

  it("drops hidden pages from a document's related links", async () => {
    const linkQueries = [
      thenableQuery({
        data: [
          { target_document_id: "doc-hidden", strength: "related" },
          { target_document_id: "doc-visible", strength: "related" },
        ],
        error: null,
      }),
      thenableQuery({ data: [], error: null }),
    ]
    const docsQuery = publicDocsQuery([
      {
        id: "doc-hidden",
        public_slug: "payout-overview",
        title: "Payout overview",
        source: null,
        document_type: "source",
        readme_hidden: true,
      },
      {
        id: "doc-visible",
        public_slug: "payout-page",
        title: "Payout page",
        source: null,
        document_type: "source",
      },
    ])
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "document_links") {
          return linkQueries.shift() ?? thenableQuery({ data: [], error: null })
        }
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const links = await getPublicDocumentLinks("ws-1", "doc-current")

    expect(links.outbound.map((entry) => entry.id)).toEqual(["doc-visible"])
  })

  describe("folder pages", () => {
    function orderedQuery(result: { data: unknown; error: unknown }) {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        is: vi.fn(() => builder),
        in: vi.fn(() => builder),
        order: vi.fn(() => builder),
        then: vi.fn(
          (
            onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
            onrejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(result).then(onfulfilled, onrejected),
        ),
      }
      return builder
    }

    function adminForFolder(input: {
      folderId: string
      indexHidden: boolean
      documents: Array<{ id: string; title: string; readme_hidden?: boolean }>
    }) {
      const folderQuery = query({
        data: {
          id: input.folderId,
          display_name: "Payouts",
          name: "payouts",
          kind: "user",
          visibility: "workspace",
          parent_folder_id: null,
          content: "Landing page body",
          source_metadata: { index_frontmatter: { hidden: input.indexHidden } },
        },
        error: null,
      })
      const docsQuery = orderedQuery({
        data: input.documents.map((doc) => ({
          ...doc,
          public_slug: doc.id,
          source: "github",
          folder_id: input.folderId,
        })),
        error: null,
      })
      hoisted.createAdminClient.mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === "folders") return folderQuery
          if (table === "folder_stats") return orderedQuery({ data: [], error: null })
          if (table === "documents") return docsQuery
          throw new Error(`Unexpected table ${table}`)
        }),
      })
    }

    it("lists only the pages that are not hidden", async () => {
      adminForFolder({
        folderId: "folder-mixed",
        indexHidden: false,
        documents: [
          { id: "doc-hidden", title: "Payout events", readme_hidden: true },
          { id: "doc-visible", title: "Payout page" },
        ],
      })

      const detail = await getPublicFolderDetail("ws-1", "folder-mixed")

      expect(detail?.documents.map((doc) => doc.id)).toEqual(["doc-visible"])
      expect(detail?.folder.content).toBe("Landing page body")
    })

    it("withholds a hidden landing page but keeps the folder's visible pages", async () => {
      adminForFolder({
        folderId: "folder-hidden-index",
        indexHidden: true,
        documents: [{ id: "doc-visible", title: "Sales tax remittance" }],
      })

      const detail = await getPublicFolderDetail("ws-1", "folder-hidden-index")

      expect(detail?.folder.content).toBeNull()
      expect(detail?.documents.map((doc) => doc.id)).toEqual(["doc-visible"])
    })

    it("404s a folder whose landing page and every page are hidden", async () => {
      adminForFolder({
        folderId: "folder-all-hidden",
        indexHidden: true,
        documents: [{ id: "doc-hidden", title: "Payout events", readme_hidden: true }],
      })

      await expect(getPublicFolderDetail("ws-1", "folder-all-hidden")).resolves.toBeNull()
    })
  })
})

// Visibility is inherited: a folder that is Public by its own setting is not
// served while a folder above it is members-only.
describe("folders beneath a members-only folder", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const OFFRAMP = "folder-offramp"
  const NESTED = "folder-offramp-flows"
  const tree = [
    { id: "folder-guide", parent_folder_id: null, visibility: "workspace", kind: "user" },
    { id: "folder-tax", parent_folder_id: "folder-guide", visibility: "workspace", kind: "user" },
    { id: OFFRAMP, parent_folder_id: "folder-guide", visibility: "role", kind: "user" },
    { id: NESTED, parent_folder_id: OFFRAMP, visibility: "workspace", kind: "user" },
  ]

  // `folders` answers the single-row gates (maybeSingle) and the listings the
  // visibility lookups await, honouring their `visibility` filter.
  function foldersTable(single: unknown) {
    let onlyVisibility: string | null = null
    const builder = {
      select: vi.fn(() => {
        onlyVisibility = null
        return builder
      }),
      eq: vi.fn((column: string, value: string) => {
        if (column === "visibility") onlyVisibility = value
        return builder
      }),
      maybeSingle: vi.fn(async () => ({ data: single, error: null })),
      then: vi.fn(
        (
          onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
          onrejected?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve({
            data: tree.filter((row) => !onlyVisibility || row.visibility === onlyVisibility),
            error: null,
          }).then(onfulfilled, onrejected),
      ),
    }
    return builder
  }

  function adminFor(tables: Record<string, unknown>) {
    const admin = {
      rpc: vi.fn(async () => ({ data: [], error: null })),
      from: vi.fn((table: string) => {
        if (table in tables) return tables[table]
        throw new Error(`Unexpected table ${table}`)
      }),
    }
    hoisted.createAdminClient.mockReturnValue(admin)
  }

  function pageIn(folderId: string) {
    return documentsQuery({
      id: `doc-in-${folderId}`,
      public_slug: `page-in-${folderId}`,
      title: "Customer Offramp Overview",
      content: "body",
      source: "github",
      author: null,
      updated_at: "2026-11-17T00:00:00Z",
      folder_id: folderId,
      deleted_at: null,
      document_type: "source",
      source_metadata: { repo_format: "readme", readme_hidden: false },
    })
  }

  it("404s a page in a public folder that sits inside a members-only folder", async () => {
    adminFor({
      documents: pageIn(NESTED),
      // The nested folder's own row says it is public.
      folders: foldersTable({ visibility: "workspace", kind: "user" }),
    })

    await expect(getPublicDocument("ws-1", `page-in-${NESTED}`)).resolves.toBeNull()
  })

  it("still serves a page in a folder whose ancestors are all public", async () => {
    adminFor({
      documents: pageIn("folder-tax"),
      folders: foldersTable({ visibility: "workspace", kind: "user" }),
    })

    const result = await getPublicDocument("ws-1", "page-in-folder-tax")

    expect(result?.id).toBe("doc-in-folder-tax")
  })

  it("404s the page of a public folder inside a members-only folder", async () => {
    adminFor({
      folders: foldersTable({
        id: NESTED,
        display_name: "Flows",
        name: "flows",
        kind: "user",
        visibility: "workspace",
        parent_folder_id: OFFRAMP,
        content: null,
        source_metadata: {},
      }),
    })

    await expect(getPublicFolderDetail("ws-1", NESTED)).resolves.toBeNull()
  })

  it("drops pages inside the members-only subtree from search", async () => {
    const docsQuery = scopedDocsQuery([
      {
        id: "doc-offramp",
        public_slug: "customer-offramp-overview",
        title: "Customer Offramp Overview",
        source: "github",
        document_type: "source",
        folder_id: OFFRAMP,
      },
      {
        id: "doc-nested",
        public_slug: "offramp-flows",
        title: "Offramp flows",
        source: "github",
        document_type: "source",
        folder_id: NESTED,
      },
      {
        id: "doc-tax",
        public_slug: "sales-tax-remittance",
        title: "Offramp tax notes",
        source: "github",
        document_type: "source",
        folder_id: "folder-tax",
      },
    ])
    adminFor({ documents: docsQuery, folders: foldersTable(null) })

    const hits = await searchPublic("ws-1", "offramp")

    expect(hits.map((hit) => hit.id)).toEqual(["doc-tax"])
  })
})

describe("searchPublic title matching", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("finds a doc by title even when its body never contains the query", async () => {
    const docsQuery = publicDocsQuery([
      {
        id: "doc-quickstart",
        public_slug: "quickstart",
        title: "Quickstart",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-other",
        public_slug: "other",
        title: "Other",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-hidden",
        public_slug: "hidden-quickstart",
        title: "Quickstart (internal)",
        source: null,
        document_type: "topic_page",
      },
    ])
    hoisted.createAdminClient.mockReturnValue({
      // Body grep finds nothing.
      rpc: vi.fn(async () => ({ data: [], error: null })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "quickstart")

    expect(hits).toEqual([
      {
        id: "doc-quickstart",
        slug: "quickstart",
        title: "Quickstart",
        source: null,
        snippet: "",
      },
    ])
  })
})

describe("searchPublic fuzzy title matching", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  function adminWithTitles(titles: string[]) {
    const docsQuery = publicDocsQuery(
      titles.map((title, i) => ({
        id: `doc-${i}`,
        public_slug: `doc-${i}`,
        title,
        source: null,
        document_type: "page",
      })),
    )
    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({ data: [], error: null })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })
  }

  const TITLES = ["Quick Start", "QuickStart", "Payout page status update", "List statements"]

  it.each(["quit start", "quick start", "quickstart", "quikstart", "quick"])(
    "%s finds both Quick Start spellings",
    async (q) => {
      adminWithTitles(TITLES)
      const hits = await searchPublic("ws-1", q)
      expect(hits.map((h) => h.title).sort()).toEqual(["Quick Start", "QuickStart"])
    },
  )

  it("does not let a typo budget pull in unrelated words", async () => {
    adminWithTitles(TITLES)
    const hits = await searchPublic("ws-1", "start")
    expect(hits.map((h) => h.title)).not.toContain("Payout page status update")
    expect(hits.map((h) => h.title)).not.toContain("List statements")
  })
})

// ---------------------------------------------------------------------------
// Project scope correctness
// ---------------------------------------------------------------------------

describe("scope helpers", () => {
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"

  it("treats only null/undefined as unscoped; [] is an empty fail-closed scope", () => {
    expect(isScopeProvided(null)).toBe(false)
    expect(isScopeProvided(undefined)).toBe(false)
    expect(isScopeProvided([])).toBe(true)
    expect(isScopeProvided([A])).toBe(true)
    // A provided-but-typoed scope is STILL provided (must fail closed, not widen).
    expect(isScopeProvided(["not-a-uuid"])).toBe(true)
  })

  it("keys no-scope to '', valid scope to sorted ids, all-invalid scope to a distinct sentinel", () => {
    expect(normalizeScopeKey(null)).toBe("")
    expect(normalizeScopeKey([])).not.toBe("")
    expect(normalizeScopeKey([B, A])).toBe(`${A},${B}`)
    // A provided scope of only invalid ids must NOT collapse to the '' (whole
    // workspace) key — otherwise it would share an entry and widen.
    expect(normalizeScopeKey(["typo", "also-bad"])).not.toBe("")
    expect(normalizeScopeKey(["typo"])).toBe(normalizeScopeKey(["other-typo"]))
  })

  it("expands scope roots to descendants and drops topics", () => {
    const rows = [
      { id: A, kind: "user", parent_folder_id: null },
      { id: "child", kind: "user", parent_folder_id: A },
      { id: "topic", kind: "topic", parent_folder_id: A },
      { id: B, kind: "user", parent_folder_id: null },
    ]
    const allowed = expandScope(rows, [A])
    expect(allowed.has(A)).toBe(true)
    expect(allowed.has("child")).toBe(true)
    expect(allowed.has("topic")).toBe(false)
    expect(allowed.has(B)).toBe(false)
  })

  it("scoped visibleDocFilter matches nothing for an empty folder set (fail closed)", () => {
    // A provided-but-invalid scope yields an empty folder set; the scoped filter
    // must resolve to a never-matching clause, NOT the unscoped null-folder one.
    const filter = visibleDocFilter([], true)
    expect(filter).not.toContain("folder_id.is.null")
    expect(filter).toContain("folder_id.in.(00000000-0000-0000-0000-000000000000)")
  })
})

describe("searchPublic scope", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const IN_SCOPE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  const OUT_OF_SCOPE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

  function adminForScopedSearch() {
    const foldersQuery = thenableQuery({
      data: [
        { id: IN_SCOPE, kind: "user", parent_folder_id: null, visibility: "workspace" },
        { id: OUT_OF_SCOPE, kind: "user", parent_folder_id: null, visibility: "workspace" },
      ],
      error: null,
    })
    const docsQuery = scopedDocsQuery([
      {
        id: "doc-in",
        public_slug: "in-scope-doc",
        title: "In scope",
        source: "slack",
        document_type: "source",
        folder_id: IN_SCOPE,
      },
      {
        id: "doc-out",
        public_slug: "out-of-scope-doc",
        title: "Out of scope",
        source: "slack",
        document_type: "source",
        folder_id: OUT_OF_SCOPE,
      },
    ])
    return {
      rpc: vi.fn(async () => ({
        data: [
          { document_id: "doc-in", title: "In scope", line_text: "match in" },
          { document_id: "doc-out", title: "Out of scope", line_text: "match out" },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
      docsQuery,
    }
  }

  it("excludes out-of-scope docs from a scoped search", async () => {
    const admin = adminForScopedSearch()
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublic("ws-1", "match", 25, [IN_SCOPE])

    expect(hits.map((h) => h.id)).toEqual(["doc-in"])
    // Scoped filter excludes workspace-level docs entirely.
    expect(admin.docsQuery.or).toHaveBeenCalledWith(
      `folder_id.in.(${IN_SCOPE})`,
    )
  })

  it("a provided-but-invalid scope returns no hits (fails closed, not whole-workspace)", async () => {
    const admin = adminForScopedSearch()
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublic("ws-1", "match", 25, ["not-a-uuid"])

    expect(hits).toEqual([])
    // The scoped filter must be the never-matching sentinel, never the unscoped
    // null-folder clause that would surface every workspace doc.
    expect(admin.docsQuery.or).toHaveBeenCalledWith(
      "folder_id.in.(00000000-0000-0000-0000-000000000000)",
    )
  })

  it("an unscoped search still surfaces docs across the workspace", async () => {
    const admin = adminForScopedSearch()
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublic("ws-1", "match", 25)

    expect(hits.map((h) => h.id).sort()).toEqual(["doc-in", "doc-out"])
  })
})

describe("searchPublicForQuestion", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const DOC_A = {
    id: "doc-a",
    public_slug: "alpha",
    title: "Alpha",
    source: "slack",
    document_type: "source",
    folder_id: null,
  }
  const DOC_B = {
    id: "doc-b",
    public_slug: "beta",
    title: "Beta",
    source: "slack",
    document_type: "source",
    folder_id: null,
  }

  // grep responds per literal pattern: the whole-sentence pattern matches
  // nothing; individual keywords match docs. Builders are minted per call so
  // parallel keyword searches don't share filter state.
  function adminForQuestion(byPattern: Record<string, Array<typeof DOC_A>>) {
    return {
      rpc: vi.fn(async (_fn: string, args: { p_pattern: string }) => ({
        data: (byPattern[args.p_pattern] ?? []).map((doc) => ({
          document_id: doc.id,
          title: doc.title,
          line_text: `${doc.title} mentions things`,
        })),
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return scopedDocsQuery([DOC_A, DOC_B])
        throw new Error(`Unexpected table ${table}`)
      }),
    }
  }

  it("falls back to keyword retrieval and ranks docs hit by more keywords first", async () => {
    const admin = adminForQuestion({ breezify: [DOC_A, DOC_B], portal: [DOC_B] })
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublicForQuestion(
      "ws-1",
      "explain what does the breezify portal do",
      8,
    )

    // Direct phrase first, then one grep per keyword (stopwords dropped).
    const patterns = admin.rpc.mock.calls.map(
      (call) => (call[1] as { p_pattern: string }).p_pattern,
    )
    expect(patterns).toEqual(["explain what does the breezify portal do", "breezify", "portal"])
    // doc-b matched both keywords, doc-a only one.
    expect(hits.map((h) => h.id)).toEqual(["doc-b", "doc-a"])
  })

  it("short-circuits on a direct phrase hit without keyword fan-out", async () => {
    const admin = adminForQuestion({ breezify: [DOC_A] })
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublicForQuestion("ws-1", "breezify", 8)

    expect(hits.map((h) => h.id)).toEqual(["doc-a"])
    expect(admin.rpc).toHaveBeenCalledTimes(1)
  })

  it("returns nothing for a stopword-only question", async () => {
    const admin = adminForQuestion({})
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublicForQuestion("ws-1", "what does it do", 8)

    expect(hits).toEqual([])
    // Only the direct-phrase attempt — no keywords survive the stopword filter.
    expect(admin.rpc).toHaveBeenCalledTimes(1)
  })
})

// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  globalMutateMock: vi.fn(),
  mutateDocsMock: vi.fn(),
  mutateFoldersMock: vi.fn(),
  useDocumentsMock: vi.fn(),
  useFoldersMock: vi.fn(),
  reorderFoldersMock: vi.fn(),
  routerPushMock: vi.fn(),
  routerPrefetchMock: vi.fn(),
  pathname: "/knowledge",
  documentsData: undefined as Array<Record<string, unknown>> | undefined,
  foldersData: undefined as Array<Record<string, unknown>> | undefined,
  documentsLoading: true,
  foldersLoading: true,
  pageOutline: { portal: null } as { portal: Record<string, unknown> | null },
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  usePathname: () => hoisted.pathname,
  useRouter: () => ({
    prefetch: hoisted.routerPrefetchMock,
    push: hoisted.routerPushMock,
  }),
}))

vi.mock("swr", () => ({
  preload: vi.fn(),
  useSWRConfig: () => ({
    mutate: hoisted.globalMutateMock,
  }),
}))

vi.mock("@/hooks/swr", () => ({
  useDocuments: (options: unknown) => {
    hoisted.useDocumentsMock(options)
    return {
      data: hoisted.documentsData,
      isLoading: hoisted.documentsLoading,
      mutate: hoisted.mutateDocsMock,
    }
  },
  useFolders: (options: unknown) => {
    hoisted.useFoldersMock(options)
    return {
      data: hoisted.foldersData,
      isLoading: hoisted.foldersLoading,
      mutate: hoisted.mutateFoldersMock,
    }
  },
  useWorkspace: () => ({
    data: { id: "ws-1" },
  }),
  usePortalPageOutline: (options?: { enabled?: boolean }) => ({
    data: options?.enabled ? hoisted.pageOutline : undefined,
    error: undefined,
  }),
}))

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => ({
      on: () => ({
        on: () => ({
          subscribe: () => ({}),
        }),
      }),
    }),
    removeChannel: () => {},
  }),
}))

vi.mock("@/lib/api/folders", () => ({
  reorderFolders: hoisted.reorderFoldersMock,
}))

import { DocumentsSubNav } from "./documents-sub-nav"

const FOLDER_DRAG_TYPE = "application/x-breezify-folder-id"

function createDataTransfer(initialData: Record<string, string>) {
  const data = new Map(Object.entries(initialData))
  const types = Object.keys(initialData)
  return {
    dataTransfer: {
      types,
      files: [],
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value)
        if (!types.includes(type)) types.push(type)
      }),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
    },
  }
}

function dispatchDragEvent(
  target: Element,
  type: "dragover" | "drop",
  event: ReturnType<typeof createDataTransfer>,
  clientY: number,
): Event {
  const dragEvent = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(dragEvent, "dataTransfer", {
    value: event.dataTransfer,
  })
  Object.defineProperty(dragEvent, "clientY", { value: clientY })
  fireEvent(target, dragEvent)
  return dragEvent
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  hoisted.pathname = "/knowledge"
  hoisted.documentsData = undefined
  hoisted.foldersData = undefined
  hoisted.documentsLoading = true
  hoisted.foldersLoading = true
  hoisted.pageOutline = { portal: null }
  window.localStorage.clear()
})

describe("DocumentsSubNav loading state", () => {
  it("picks a folder's visibility in its row menu, without a dialog", () => {
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = [
      {
        id: "folder-1",
        name: "blog",
        display_name: "Blog",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: null,
        icon: null,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(<DocumentsSubNav />)

    fireEvent.click(screen.getByText("Blog"))
    expect(hoisted.routerPushMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Actions for Blog" }))
    // Two choices, the current one checked; the role-based options are gone.
    const choices = screen.getAllByRole("menuitemradio")
    expect(choices.map((choice) => choice.textContent)).toEqual(["Public", "Members"])
    expect(screen.getByRole("menuitemradio", { name: "Public" })).toBeChecked()
    expect(screen.getByRole("menuitemradio", { name: "Members" })).not.toBeChecked()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("grays out folders and pages the public cannot see", () => {
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    const stamp = "2026-07-08T00:00:00.000Z"
    hoisted.foldersData = [
      {
        id: "folder-1",
        name: "offramp",
        display_name: "Customer Offramp",
        kind: "user",
        parent_folder_id: null,
        visibility: "role",
        required_role: "agent-only",
        document_count: 0,
        hidden_from_public: true,
        sort_order: null,
        icon: null,
        last_seen_at: stamp,
        created_at: stamp,
        updated_at: stamp,
      },
    ]
    hoisted.documentsData = [
      {
        id: "doc-hidden",
        title: "Apple Pay",
        source: "github",
        folder_id: null,
        hidden_from_public: true,
        created_at: stamp,
        updated_at: stamp,
      },
      {
        id: "doc-public",
        title: "Quick Start",
        source: "github",
        folder_id: null,
        hidden_from_public: false,
        created_at: stamp,
        updated_at: stamp,
      },
    ]

    render(<DocumentsSubNav />)

    const hint = "Hidden from the public portal"
    expect(screen.getByText("Customer Offramp").closest("button")).toHaveAttribute("title", hint)
    expect(screen.getByText("Apple Pay").closest("button")).toHaveAttribute("title", hint)
    expect(screen.getByText("Quick Start").closest("button")).not.toHaveAttribute("title")

    // A Members folder shows as Members in its menu.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Customer Offramp" }))
    expect(screen.getByRole("menuitemradio", { name: "Members" })).toBeChecked()
  })

  it("keeps a document's folder open after clicking away from that document", () => {
    window.localStorage.clear()
    const folder = (id: string, display: string, parent: string | null) => ({
      id,
      name: id,
      display_name: display,
      kind: "user",
      parent_folder_id: parent,
      visibility: "workspace",
      required_role: null,
      document_count: 1,
      sort_order: null,
      icon: null,
      last_seen_at: "2026-07-08T00:00:00.000Z",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    })
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.foldersData = [folder("guides", "Guides", null), folder("payments", "Payments", "guides")]
    hoisted.documentsData = [
      { id: "11111111-1111-4111-8111-111111111111", title: "Refunds", source: "Manual", folder_id: "payments", updated_at: "2026-07-08T00:00:00.000Z" },
      { id: "22222222-2222-4222-8222-222222222222", title: "Welcome", source: "Manual", folder_id: null, updated_at: "2026-07-08T00:00:00.000Z" },
    ]

    // Open a doc that lives two folders deep.
    hoisted.pathname = "/knowledge/11111111-1111-4111-8111-111111111111"
    const { rerender } = render(<DocumentsSubNav />)
    expect(screen.getByText("Refunds")).toBeInTheDocument()

    // Click away to a document outside those folders: they stay open.
    hoisted.pathname = "/knowledge/22222222-2222-4222-8222-222222222222"
    rerender(<DocumentsSubNav />)
    expect(screen.getByText("Payments")).toBeInTheDocument()
    expect(screen.getByText("Refunds")).toBeInTheDocument()
  })

  it("lets the host show a clicked document instead of opening its editor", () => {
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.foldersData = []
    hoisted.documentsData = [
      { id: "22222222-2222-4222-8222-222222222222", title: "Welcome", source: "Manual", folder_id: null, updated_at: "2026-07-08T00:00:00.000Z" },
      { id: "33333333-3333-4333-8333-333333333333", title: "Private notes", source: "Manual", folder_id: null, updated_at: "2026-07-08T00:00:00.000Z" },
    ]
    const pushState = vi.spyOn(window.history, "pushState")
    const onOpenDocument = vi.fn(
      (id: string) => id === "22222222-2222-4222-8222-222222222222",
    )
    render(<DocumentsSubNav onOpenDocument={onOpenDocument} />)

    // Handled by the host: no editor.
    fireEvent.click(screen.getByText("Welcome"))
    expect(onOpenDocument).toHaveBeenLastCalledWith(
      "22222222-2222-4222-8222-222222222222",
    )
    expect(pushState).not.toHaveBeenCalled()
    expect(hoisted.routerPushMock).not.toHaveBeenCalled()

    // Declined by the host: the editor opens as usual.
    fireEvent.click(screen.getByText("Private notes"))
    expect(pushState).toHaveBeenCalledWith(
      null,
      "",
      "/knowledge/33333333-3333-4333-8333-333333333333",
    )
  })

  it("keeps the knowledge controls outside the scrolling document tree", () => {
    const { container } = render(<DocumentsSubNav />)

    const controls = container.querySelector(
      '[data-slot="documents-sub-nav-controls"]',
    )
    const tree = container.querySelector('[data-slot="documents-sub-nav-tree"]')

    expect(controls).toHaveClass("shrink-0", "bg-background")
    expect(controls).not.toHaveClass("sticky")
    expect(
      within(controls as HTMLElement).getByPlaceholderText(/filter/i),
    ).toBeInTheDocument()
    expect(
      within(controls as HTMLElement).getByRole("button", { name: /new doc/i }),
    ).toBeInTheDocument()
    expect(
      within(controls as HTMLElement).getByRole("button", {
        name: /new folder/i,
      }),
    ).toBeInTheDocument()
    expect(tree).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
      "overscroll-y-none",
    )
    expect(controls?.contains(tree)).toBe(false)
    expect(tree?.contains(controls)).toBe(false)
  })

  it("keeps the builder tree in its existing parent-owned scroll region", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = []

    const { container } = render(
      <DocumentsSubNav chrome="builder" routeRoot="kb" />,
    )

    const tree = container.querySelector('[data-slot="documents-sub-nav-tree"]')
    expect(tree).not.toHaveClass("overflow-y-auto", "overscroll-y-none")
    expect(
      container.querySelector('[data-slot="documents-sub-nav-controls"]'),
    ).toBeNull()
  })

  it("renders a tree-shaped skeleton while documents and folders load", () => {
    const { container } = render(<DocumentsSubNav />)

    expect(screen.getByRole("status")).toHaveTextContent(/loading documents/i)
    expect(container.querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(10)
    expect(screen.getByPlaceholderText(/filter/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /new doc/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /new folder/i })).toBeInTheDocument()
  })

  it("shows a promoted project root's contents without rendering the root folder", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = [
      {
        id: "doc-1",
        title: "Getting started",
        source: "Manual",
        folder_id: "root-folder",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.foldersData = [
      {
        id: "root-folder",
        name: "developer-docs",
        display_name: "Developer Docs",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "child-folder",
        name: "api",
        display_name: "API",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        promotedRootFolderIds={new Set(["root-folder"])}
        projectRootFolderId="root-folder"
      />,
    )

    expect(screen.queryByText("Developer Docs")).not.toBeInTheDocument()
    expect(screen.getByText("API")).toBeInTheDocument()
    expect(screen.getByText("Getting started")).toBeInTheDocument()
  })

  it("keeps a Docs-named root as its own folder in the workspace-wide Knowledge tree", () => {
    hoisted.pathname = "/knowledge"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    const folder = (id: string, display_name: string, parent_folder_id: string | null) => ({
      id,
      name: id,
      display_name,
      kind: "user",
      parent_folder_id,
      visibility: "workspace",
      required_role: null,
      document_count: 0,
      last_seen_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    })
    hoisted.foldersData = [
      folder("docs-root", "Breeze Docs", null),
      folder("guide", "Core Integration Guide", "docs-root"),
      folder("api-root", "Breeze API Reference", null),
    ]

    render(<DocumentsSubNav chrome="builder" routeRoot="knowledge" />)

    expect(screen.getByText("Breeze Docs")).toBeInTheDocument()
    expect(screen.getByText("Breeze API Reference")).toBeInTheDocument()
    expect(screen.queryByText("Core Integration Guide")).not.toBeInTheDocument()
  })

  it("shows only Home's included docs when the tree follows Documents", () => {
    hoisted.pathname = "/knowledge"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    const doc = (id: string, title: string, folder_id: string) => ({
      id,
      title,
      source: "Manual",
      folder_id,
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    })
    hoisted.documentsData = [
      doc("guide-doc", "Quickstart", "guide"),
      doc("api-doc", "Create a payment", "api-root"),
    ]
    const folder = (id: string, display_name: string, parent_folder_id: string | null) => ({
      id,
      name: id,
      display_name,
      kind: "user",
      parent_folder_id,
      visibility: "workspace",
      required_role: null,
      document_count: 1,
      last_seen_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    })
    hoisted.foldersData = [
      folder("docs-root", "Breeze Docs", null),
      folder("guide", "Core Integration Guide", "docs-root"),
      folder("api-root", "Breeze API Reference", null),
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="knowledge"
        portalPageScope={[{ id: "docs-root", promote: true, rootOnly: false }]}
        promotedRootFolderIds={new Set(["docs-root"])}
        projectRootFolderId="docs-root"
      />,
    )

    expect(screen.getByText("Core Integration Guide")).toBeInTheDocument()
    expect(screen.queryByText("Breeze Docs")).not.toBeInTheDocument()
    expect(screen.queryByText("Breeze API Reference")).not.toBeInTheDocument()
  })

  it("shows only the selected portal page's folders and documents", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = [
      {
        id: "api-doc",
        title: "List entries",
        source: "Manual",
        folder_id: "api-folder",
        sort_order: 0,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "guide-doc",
        title: "Getting started",
        source: "Manual",
        folder_id: "guide-folder",
        sort_order: 0,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-doc",
        title: "Internal roadmap",
        source: "Manual",
        folder_id: "secret-folder",
        sort_order: 0,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.foldersData = [
      {
        id: "root-folder",
        name: "developer-docs",
        display_name: "Developer Docs",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 2,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "api-folder",
        name: "api",
        display_name: "API",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "guide-folder",
        name: "guides",
        display_name: "Guides",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        sort_order: 1,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-folder",
        name: "internal",
        display_name: "Internal",
        kind: "user",
        parent_folder_id: null,
        visibility: "private",
        required_role: "member",
        document_count: 1,
        sort_order: 2,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        projectSlug="developers"
        portalPageSlug="api-reference"
        portalPageScope={["api-folder"]}
        promotedRootFolderIds={new Set(["root-folder"])}
        projectRootFolderId="root-folder"
      />,
    )

    expect(hoisted.useDocumentsMock).toHaveBeenCalledWith({ projectSlug: null })
    expect(hoisted.useFoldersMock).toHaveBeenCalledWith({ projectSlug: null })

    expect(screen.getByText("API")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand folder" }))
    expect(screen.getByText("List entries")).toBeInTheDocument()
    expect(screen.queryByText("Guides")).not.toBeInTheDocument()
    expect(screen.queryByText("Getting started")).not.toBeInTheDocument()
    expect(screen.queryByText("Internal")).not.toBeInTheDocument()
    expect(screen.queryByText("Internal roadmap")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("List entries"))
    expect(hoisted.routerPushMock).toHaveBeenCalledWith(
      "/kb/doc/api-doc?project=developers&page=api-reference",
    )
  })

  it("hides restricted folders from a workspace-wide portal page", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = [
      {
        id: "public-doc",
        title: "Public guide",
        source: "Manual",
        document_type: "page",
        folder_id: "public-folder",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-doc",
        title: "Internal roadmap",
        source: "Manual",
        document_type: "page",
        folder_id: "secret-folder",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.foldersData = [
      {
        id: "public-folder",
        name: "public",
        display_name: "Public",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-folder",
        name: "internal",
        display_name: "Internal",
        kind: "user",
        parent_folder_id: null,
        visibility: "private",
        required_role: "member",
        document_count: 1,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        projectSlug="developers"
        portalPageSlug="everything"
        portalPageScope={null}
      />,
    )

    expect(screen.getByText("Public")).toBeInTheDocument()
    expect(screen.queryByText("Internal")).not.toBeInTheDocument()
    expect(screen.queryByText("Internal roadmap")).not.toBeInTheDocument()
  })

  it("creates a new builder document inside the selected project root", async () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = []
    const onRootDocumentCreated = vi.fn()
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "created-doc",
            title: "Untitled",
            folder_id: "root-folder",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        projectRootFolderId="root-folder"
        onRootDocumentCreated={onRootDocumentCreated}
      />,
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Create document or folder" }),
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "New doc" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(request.body as string)).toEqual(
      expect.objectContaining({ folder_id: "root-folder" }),
    )
    await waitFor(() =>
      expect(onRootDocumentCreated).toHaveBeenCalledWith("created-doc"),
    )
  })

  it("rejects a root-to-root folder drop but still moves a nested folder to root", async () => {
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = [
      {
        id: "root-folder",
        name: "root-folder",
        display_name: "Root folder",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "nested-folder",
        name: "nested-folder",
        display_name: "Nested folder",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsSubNav />)

    fireEvent.click(screen.getByRole("button", { name: "Expand folder" }))
    const rootDropZone = screen.getByTestId("documents-root-drop-zone")
    const rootFolder = screen
      .getByText("Root folder")
      .closest("[draggable='true']")
    const nestedFolder = screen
      .getByText("Nested folder")
      .closest("[draggable='true']")
    expect(rootFolder).not.toBeNull()
    expect(nestedFolder).not.toBeNull()

    const rootDrag = createDataTransfer({})
    fireEvent.dragStart(rootFolder!, rootDrag)
    const rootDragOver = dispatchDragEvent(rootDropZone, "dragover", rootDrag, 0)

    expect(rootDragOver.defaultPrevented).toBe(false)
    expect(rootDrag.dataTransfer.dropEffect).toBe("none")
    expect(screen.queryByText("Drop to root")).not.toBeInTheDocument()

    dispatchDragEvent(rootDropZone, "drop", rootDrag, 0)
    expect(hoisted.mutateFoldersMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    const nestedDrag = createDataTransfer({})
    fireEvent.dragStart(nestedFolder!, nestedDrag)
    const nestedDragOver = dispatchDragEvent(
      rootDropZone,
      "dragover",
      nestedDrag,
      0,
    )

    expect(nestedDragOver.defaultPrevented).toBe(true)
    expect(nestedDrag.dataTransfer.dropEffect).toBe("move")
    expect(screen.getByText("Drop to root")).toBeInTheDocument()

    dispatchDragEvent(rootDropZone, "drop", nestedDrag, 0)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/folders/nested-folder",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ parent_folder_id: null }),
        }),
      )
    })
  })

  it("persists builder sidebar folder order by dragging a folder after another", async () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "alpha",
        display_name: "Alpha",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "beta",
        display_name: "Beta",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 1,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.reorderFoldersMock.mockResolvedValue({
      ordered_ids: [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ],
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 240,
      height: 30,
      top: 0,
      right: 240,
      bottom: 30,
      left: 0,
      toJSON: () => {},
    })
    const onFoldersReordered = vi.fn()

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        onFoldersReordered={onFoldersReordered}
      />,
    )

    const beta = screen.getByText("Beta").closest("[draggable='true']")
    expect(beta).not.toBeNull()
    const event = createDataTransfer({
      [FOLDER_DRAG_TYPE]: "00000000-0000-4000-8000-000000000001",
    })
    dispatchDragEvent(beta!, "dragover", event, 29)
    dispatchDragEvent(beta!, "drop", event, 29)

    await waitFor(() => {
      expect(hoisted.reorderFoldersMock).toHaveBeenCalledWith("user", [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ])
      expect(onFoldersReordered).toHaveBeenCalled()
    })
  })
})

describe("DocumentsSubNav editor page roots", () => {
  const stamp = "2026-07-08T00:00:00.000Z"
  const folder = (
    id: string,
    display_name: string,
    parent_folder_id: string | null,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    name: id,
    display_name,
    kind: "user",
    parent_folder_id,
    visibility: "workspace",
    required_role: null,
    document_count: 0,
    sort_order: null,
    icon: null,
    last_seen_at: stamp,
    created_at: stamp,
    updated_at: stamp,
    ...extra,
  })
  const doc = (id: string, title: string, folder_id: string | null) => ({
    id,
    title,
    source: "Manual",
    folder_id,
    document_type: "page",
    created_at: stamp,
    updated_at: stamp,
  })

  function seedWorkspace(): void {
    hoisted.pathname = "/editor"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.foldersData = [
      folder("docs-root", "Breeze Docs", null),
      folder("guide", "Core Integration Guide", "docs-root"),
      folder("api-root", "Breeze API Reference", null),
      folder("payments", "Payments", "api-root"),
      folder("runbooks", "Runbooks", null, { visibility: "role", required_role: "agent-only" }),
    ]
    hoisted.documentsData = [
      doc("doc-guide", "Quickstart", "guide"),
      doc("doc-charge", "Create a charge", "payments"),
      doc("doc-runbook", "Refund runbook", "runbooks"),
    ]
    hoisted.pageOutline = {
      portal: {
        slug: "breeze",
        displayName: "Breeze",
        scope: [{ id: "docs-root", promote: true, rootOnly: true }, "guide"],
        homePosition: 0,
        pages: [
          {
            id: "page-api",
            title: "API Reference",
            slug: "api-reference",
            scope: ["api-root"],
            presentation: "api_reference",
          },
        ],
      },
    }
  }

  function rootRow(title: string): HTMLElement {
    const row = screen.getByRole("button", { name: title }).parentElement
    expect(row).not.toBeNull()
    return row as HTMLElement
  }

  function rootSection(title: string): HTMLElement {
    const section = screen
      .getByRole("button", { name: title })
      .closest("[data-page-root]")
    expect(section).not.toBeNull()
    return section as HTMLElement
  }

  it("puts each portal page at the top of the editor tree", () => {
    seedWorkspace()
    render(<DocumentsSubNav routeRoot="editor" />)

    const roots = Array.from(document.querySelectorAll("[data-page-root]")).map(
      (element) => element.querySelector("button")?.textContent,
    )
    expect(roots).toEqual(["Documents", "API Reference", "Not in portal"])

    // The wrapper folders are the pages themselves, so they are not rows.
    expect(screen.queryByText("Breeze Docs")).not.toBeInTheDocument()
    expect(screen.queryByText("Breeze API Reference")).not.toBeInTheDocument()
    expect(
      within(rootSection("Documents")).getByText("Core Integration Guide"),
    ).toBeInTheDocument()
    expect(within(rootSection("API Reference")).getByText("Payments")).toBeInTheDocument()
    expect(within(rootSection("Not in portal")).getByText("Runbooks")).toBeInTheDocument()
  })

  it("keeps the plain folder tree outside the editor", () => {
    seedWorkspace()
    hoisted.pathname = "/knowledge"
    render(<DocumentsSubNav routeRoot="knowledge" />)

    expect(document.querySelector("[data-page-root]")).toBeNull()
    expect(screen.getByText("Breeze Docs")).toBeInTheDocument()
  })

  it("keeps the plain folder tree when the portal has no pages of its own", () => {
    seedWorkspace()
    hoisted.pageOutline = {
      portal: {
        slug: "breeze",
        displayName: "Breeze",
        scope: null,
        homePosition: 0,
        pages: [],
      },
    }
    render(<DocumentsSubNav routeRoot="editor" />)

    expect(document.querySelector("[data-page-root]")).toBeNull()
    expect(screen.getByText("Breeze API Reference")).toBeInTheDocument()
  })

  it("opens the tree's first document on bare /editor", async () => {
    seedWorkspace()
    window.history.replaceState(null, "", "/editor")
    const replaceState = vi.spyOn(window.history, "replaceState")
    try {
      render(<DocumentsSubNav routeRoot="editor" />)

      // Documents is the first root; its first folder's first document.
      await waitFor(() => {
        expect(replaceState).toHaveBeenCalledWith(null, "", "/editor/doc-guide")
      })
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })

  it("leaves an open document alone", () => {
    seedWorkspace()
    hoisted.pathname = "/editor/doc-charge"
    window.history.replaceState(null, "", "/editor/doc-charge")
    const replaceState = vi.spyOn(window.history, "replaceState")
    try {
      render(<DocumentsSubNav routeRoot="editor" />)

      expect(replaceState).not.toHaveBeenCalled()
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })

  it("collapses a page root and remembers it", () => {
    seedWorkspace()
    const { unmount } = render(<DocumentsSubNav routeRoot="editor" />)

    fireEvent.click(screen.getByRole("button", { name: "API Reference" }))
    expect(screen.queryByText("Payments")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "API Reference" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    unmount()

    render(<DocumentsSubNav routeRoot="editor" />)
    expect(screen.queryByText("Payments")).not.toBeInTheDocument()
    expect(screen.getByText("Core Integration Guide")).toBeInTheDocument()
  })

  it("moves a folder dropped on a page root into that page's folder", async () => {
    seedWorkspace()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    render(<DocumentsSubNav routeRoot="editor" />)

    const runbooks = screen.getByText("Runbooks").closest("[draggable='true']")
    expect(runbooks).not.toBeNull()
    const drag = createDataTransfer({})
    fireEvent.dragStart(runbooks!, drag)
    const over = dispatchDragEvent(rootRow("API Reference"), "dragover", drag, 0)
    expect(over.defaultPrevented).toBe(true)
    expect(drag.dataTransfer.dropEffect).toBe("move")

    dispatchDragEvent(rootRow("API Reference"), "drop", drag, 0)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/folders/runbooks",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ parent_folder_id: "api-root" }),
        }),
      )
    })
  })

  it("refuses a folder drop on a root with no folder that would show it", () => {
    seedWorkspace()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    render(<DocumentsSubNav routeRoot="editor" />)

    // Home's root folder includes only the sections it lists, so a folder moved
    // into it would not show on the portal.
    const payments = screen.getByText("Payments").closest("[draggable='true']")
    const drag = createDataTransfer({})
    fireEvent.dragStart(payments!, drag)
    const over = dispatchDragEvent(rootRow("Documents"), "dragover", drag, 0)

    expect(drag.dataTransfer.dropEffect).toBe("none")
    expect(over.defaultPrevented).toBe(true)
    dispatchDragEvent(rootRow("Documents"), "drop", drag, 0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Add to Not in portal" })).toBeNull()
  })
})

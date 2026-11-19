// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GithubHostedDocsSyncGate } from "./github-hosted-docs-sync-gate"

const mocks = vi.hoisted(() => ({
  useGithubHostedDocs: vi.fn(),
  useHasHydrated: vi.fn(() => true),
}))

vi.mock("@/hooks/swr", () => ({
  useGithubHostedDocs: mocks.useGithubHostedDocs,
}))

vi.mock("@/hooks/use-has-hydrated", () => ({
  useHasHydrated: mocks.useHasHydrated,
}))

type InitialSource = React.ComponentProps<
  typeof GithubHostedDocsSyncGate
>["initialSource"]

function renderGate(initialSource?: InitialSource): void {
  render(
    <GithubHostedDocsSyncGate initialSource={initialSource}>
      <button type="button">Editable control</button>
    </GithubHostedDocsSyncGate>,
  )
}

function serverSource(
  syncStatus: "pending" | "syncing" | "synced",
  updatedAt: string,
): NonNullable<InitialSource> {
  return {
    sync_status: syncStatus,
    repo_full_name: "breezify/breezify",
    paths: ["docs"],
    updated_at: updatedAt,
  }
}

describe("GithubHostedDocsSyncGate", () => {
  beforeEach(() => {
    mocks.useHasHydrated.mockReturnValue(true)
    mocks.useGithubHostedDocs.mockReturnValue({
      data: { source: null },
      error: undefined,
      isLoading: false,
      isValidating: false,
    })
  })

  it.each(["pending", "syncing"])(
    "locks the editors while hosted docs are %s",
    (syncStatus) => {
      mocks.useGithubHostedDocs.mockReturnValue({
        data: {
          source: {
            sync_status: syncStatus,
            repo_full_name: "breezify/breezify",
            paths: ["docs/breezify-docs"],
          },
        },
        error: undefined,
        isLoading: false,
        isValidating: false,
      })

      renderGate()

      expect(
        screen.getByRole("heading", { name: "Syncing Breezify docs from GitHub" }),
      ).toBeInTheDocument()
      expect(screen.getByRole("progressbar")).toBeInTheDocument()
      expect(screen.getByText("breezify/breezify/docs/breezify-docs")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Editable control" })).toBeNull()
      expect(document.querySelector(".animate-spin")).toBeNull()
    },
  )

  it("shows the editor when the source is ready", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: { source: { sync_status: "synced" } },
      error: undefined,
      isLoading: false,
      isValidating: false,
    })

    renderGate()

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("fails open when the status request fails", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: undefined,
      error: new Error("temporary failure"),
      isLoading: false,
      isValidating: false,
    })

    renderGate()

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
  })

  it("keeps the editor mounted while the status check revalidates in the background", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: { source: { sync_status: "synced" } },
      error: undefined,
      isLoading: false,
      isValidating: true,
    })

    renderGate()

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("keeps the editor mounted on a cold load before the first status arrives", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      isValidating: true,
    })

    renderGate()

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("renders the server-shaped tree until hydration even when the cache reports a sync", () => {
    mocks.useHasHydrated.mockReturnValue(false)
    mocks.useGithubHostedDocs.mockReturnValue({
      data: { source: { sync_status: "syncing", repo_full_name: "breezify/breezify", paths: ["docs"] } },
      error: undefined,
      isLoading: false,
      isValidating: false,
    })

    renderGate()

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("locks from the server state before hydration, without any client status", () => {
    mocks.useHasHydrated.mockReturnValue(false)
    mocks.useGithubHostedDocs.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      isValidating: true,
    })

    renderGate(serverSource("syncing", "2026-11-19T22:01:28Z"))

    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.getByText("breezify/breezify/docs")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Editable control" })).toBeNull()
  })

  it("keeps the server lock while the cached client status is older", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: {
        source: { sync_status: "synced", updated_at: "2026-11-18T09:00:00Z" },
      },
      error: undefined,
      isLoading: false,
      isValidating: true,
    })

    renderGate(serverSource("syncing", "2026-11-19T22:01:28Z"))

    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Editable control" })).toBeNull()
  })

  it("unlocks once a newer client status reports the sync finished", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: {
        source: { sync_status: "synced", updated_at: "2026-11-19T22:01:36Z" },
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
    })

    renderGate(serverSource("syncing", "2026-11-19T22:01:28Z"))

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("does not lock on a stale cached sync when the server state is newer", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: {
        source: { sync_status: "syncing", updated_at: "2026-11-19T21:00:00Z" },
      },
      error: undefined,
      isLoading: false,
      isValidating: true,
    })

    renderGate(serverSource("synced", "2026-11-19T22:01:36Z"))

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("unlocks when the client learns the repository was unlinked", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: { source: null },
      error: undefined,
      isLoading: false,
      isValidating: false,
    })

    renderGate(serverSource("syncing", "2026-11-19T22:01:28Z"))

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
  })

  it("fails open on a server lock when the status request fails", () => {
    mocks.useGithubHostedDocs.mockReturnValue({
      data: undefined,
      error: new Error("temporary failure"),
      isLoading: false,
      isValidating: false,
    })

    renderGate(serverSource("syncing", "2026-11-19T22:01:28Z"))

    expect(screen.getByRole("button", { name: "Editable control" })).toBeEnabled()
  })
})

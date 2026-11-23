// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  role: "admin",
  review: undefined as Record<string, unknown> | undefined,
  reviewError: null as Error | null,
  publishStatus: { status: "up_to_date", changed_file_count: 0 } as Record<string, unknown>,
  mutateReview: vi.fn(),
  mutateSource: vi.fn(),
  mutatePublishStatus: vi.fn(),
}))

vi.mock("@/hooks/swr", () => ({
  useWorkspace: () => ({ data: { id: "workspace-1", user_role: harness.role } }),
  useGithubHostedDocs: () => ({
    data: {
      source: {
        id: "source-1",
        format: "readme",
        branch: "v1.6",
        publish_pull_request_number: 7,
        publish_pull_request_head: "v1.6_pricing",
      },
    },
    isLoading: false,
    mutate: harness.mutateSource,
  }),
  useGithubHostedDocsReview: () => ({
    data: harness.review,
    error: harness.reviewError,
    isLoading: false,
    mutate: harness.mutateReview,
  }),
  useGithubHostedDocsPublishStatus: () => ({
    data: harness.publishStatus,
    mutate: harness.mutatePublishStatus,
  }),
}))

import { WorkspaceBranchReview } from "./workspace-branch-review"

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    open: true,
    branch: "v1.6_pricing",
    base: "v1.6",
    repo_full_name: "example-org/docs",
    pull_request: {
      number: 7,
      url: "https://github.test/pull/7",
      title: "docs: v1.6_pricing",
      draft: true,
      created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    behind_by: 0,
    commits: [
      {
        sha: "a1",
        url: "https://github.test/commit/a1",
        subject: "docs: update docs/pricing.md from Breezify",
        author: "breezify-bot[bot]",
        date: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ],
    contributors: [
      { name: "Ada Example", login: null, avatar_url: null, last_active_at: new Date().toISOString() },
    ],
    files: [
      {
        path: "docs/pricing.md",
        previous_path: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n context\n-old price\n+new price\n+one more line",
      },
      {
        path: "docs/fees.md",
        previous_path: null,
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+Fees are simple.",
      },
    ],
    file_count: 2,
    additions: 3,
    deletions: 1,
    truncated: false,
    ...overrides,
  }
}

beforeEach(() => {
  harness.role = "admin"
  harness.review = review()
  harness.reviewError = null
  harness.publishStatus = { status: "up_to_date", changed_file_count: 0 }
  harness.mutateReview.mockReset()
  harness.mutateSource.mockReset()
  harness.mutatePublishStatus.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("WorkspaceBranchReview", () => {
  it("summarizes what the branch changes, who changed it and when", () => {
    render(<WorkspaceBranchReview />)

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("v1.6›v1.6_pricing")
    expect(screen.getByText("Draft")).toBeInTheDocument()
    expect(screen.getByText(/would update 2 files \(1 changed, 1 added\)/)).toBeInTheDocument()
    expect(screen.getByText("Branch created")).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "docs: update docs/pricing.md from Breezify" }),
    ).toHaveAttribute("href", "https://github.test/commit/a1")
    expect(screen.getByText("Ada Example")).toBeInTheDocument()
    // Reviews and comments stay on the pull request.
    expect(screen.getByRole("link", { name: /Pull request #7/ })).toHaveAttribute(
      "href",
      "https://github.test/pull/7",
    )
  })

  it("shows each file's diff", async () => {
    const user = userEvent.setup()
    render(<WorkspaceBranchReview />)

    await user.click(screen.getByRole("tab", { name: /Diff/ }))
    const files = screen.getByRole("navigation", { name: "Changed files" })
    expect(within(files).getAllByRole("button")).toHaveLength(2)
    expect(screen.getByText("old price")).toBeInTheDocument()
    expect(screen.getByText("new price")).toBeInTheDocument()

    await user.click(within(files).getByRole("button", { name: /fees\.md/ }))
    expect(screen.getByText("Fees are simple.")).toBeInTheDocument()
    expect(screen.queryByText("old price")).not.toBeInTheDocument()
  })

  it("requests a review by taking the pull request out of draft", async () => {
    const user = userEvent.setup()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ pull_request_number: 7, draft: false })))
    vi.stubGlobal("fetch", fetchMock)
    render(<WorkspaceBranchReview />)

    await user.click(screen.getByRole("button", { name: "Request review" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/github/hosted-docs/review", { method: "POST" })
    })
    expect(harness.mutateReview).toHaveBeenCalled()
  })

  it("has nothing to request once the pull request is ready", () => {
    harness.review = review({
      pull_request: { number: 7, url: null, title: "x", draft: false, created_at: "", updated_at: "" },
    })
    render(<WorkspaceBranchReview />)
    expect(screen.getByText("Ready for review")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Request review" })).not.toBeInTheDocument()
  })

  it("merges into the version after a confirmation", async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ merged: true })))
    vi.stubGlobal("fetch", fetchMock)
    render(<WorkspaceBranchReview />)

    await user.click(screen.getByRole("button", { name: "Merge to v1.6" }))
    expect(
      screen.getByRole("heading", { name: "Merge v1.6_pricing into v1.6?" }),
    ).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    const dialog = screen.getByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Merge to v1.6" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/github/hosted-docs/publish/merge", {
        method: "POST",
      })
    })
    expect(await screen.findByText(/The workspace is back on v1.6/)).toBeInTheDocument()
    expect(harness.mutateSource).toHaveBeenCalled()
  })

  it("leaves merging to owners and admins", () => {
    harness.role = "editor"
    render(<WorkspaceBranchReview />)
    expect(screen.getByRole("button", { name: "Merge to v1.6" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Request review" })).toBeEnabled()
  })

  it("says when saved changes are not on the branch yet", () => {
    harness.publishStatus = { status: "changes", changed_file_count: 2 }
    render(<WorkspaceBranchReview />)
    expect(screen.getByText(/2 saved changes are not on this branch yet/)).toBeInTheDocument()
  })

  it("renders what the server rendered until hydration is done", () => {
    // The server has no cached review and renders the loading state. With one
    // already in the cache, the pre-hydration render has to be that same
    // state, or React fails hydration and rebuilds the page on the client.
    const html = renderToString(<WorkspaceBranchReview />)
    expect(html).toContain("Loading the review")
    expect(html).not.toContain("v1.6_pricing")
  })

  it("lets go of a branch that was closed or deleted on GitHub", () => {
    // The link still names the branch; GitHub no longer has it open.
    harness.review = { open: false }
    render(<WorkspaceBranchReview />)
    expect(screen.getByText("No branch to review")).toBeInTheDocument()
    // Reading the link again is what clears the branch from the sidebar.
    expect(harness.mutateSource).toHaveBeenCalled()
  })

  it("explains how to start a branch when there is none", () => {
    harness.review = { open: false }
    render(<WorkspaceBranchReview />)
    expect(screen.getByText("No branch to review")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Back to the editor" })).toHaveAttribute("href", "/editor")
  })
})

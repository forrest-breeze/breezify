// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

const working = vi.hoisted(() => ({
  number: null as number | null,
  head: null as string | null,
}))

vi.mock("@/hooks/swr", () => ({
  // What the SWR cache restored from localStorage hands the first client
  // render: a linked repository, before any request was made.
  useGithubHostedDocs: () => ({
    data: {
      source: {
        format: "readme",
        sync_status: "synced",
        branch: "v1.6",
        repo_full_name: "example-org/docs",
        publish_pull_request_number: working.number,
        publish_pull_request_head: working.head,
      },
    },
  }),
}))

import { GithubBranchPicker } from "./github-branch-picker"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  working.number = null
  working.head = null
})

describe("GithubBranchPicker", () => {
  it("renders what the server rendered until hydration is done", () => {
    // The server has no cached data and renders nothing. With data already in
    // the cache, the pre-hydration render has to be the same nothing, or React
    // fails hydration and rebuilds the whole shell on the client.
    expect(renderToString(<GithubBranchPicker />)).toBe("")
  })

  it("shows the synced branch once mounted", () => {
    // The branch list is only needed once the picker opens.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ linked: false }))),
    )
    render(<GithubBranchPicker />)
    expect(
      screen.getByRole("button", { name: "Versions and branches, synced with v1.6" }),
    ).toBeInTheDocument()
  })

  it("shows the working branch beside the version while changes are saved to one", () => {
    working.number = 7
    working.head = "v1.6_pricing"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ linked: false }))),
    )
    render(<GithubBranchPicker />)
    const pill = screen.getByRole("button", {
      name: "Versions and branches, synced with v1.6, saving to v1.6_pricing",
    })
    // Beside `v1.6`, the branch reads as its own part of the name.
    expect(pill).toHaveTextContent("v1.6›pricing")
  })

  it("lists only the versions and the branches cut from the selected one", async () => {
    const entry = (name: string, synced = false) => ({
      name,
      updatedAt: null,
      author: null,
      synced,
      isDefault: synced,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            linked: true,
            repo_full_name: "example-org/docs",
            total: 4,
            versions: [
              { ...entry("v1.7"), branches: [] },
              { ...entry("v1.6", true), branches: [entry("v1.6_pricing")] },
            ],
          }),
        ),
      ),
    )
    // Its own cache, so the branch list is not the one an earlier test loaded.
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <GithubBranchPicker />
      </SWRConfig>,
    )
    fireEvent.click(screen.getByRole("button", { name: /^Versions and branches/ }))

    // The synced version is the one opened.
    expect(await screen.findByRole("link", { name: /v1\.6_pricing/ })).toBeInTheDocument()
    const versions = screen.getByRole("region", { name: "Versions" })
    expect(Array.from(versions.querySelectorAll("li"), (row) => row.textContent)).toEqual([
      "v1.7",
      "v1.6Default(synced)",
    ])
    expect(screen.queryByText("Other branches")).not.toBeInTheDocument()
  })
})

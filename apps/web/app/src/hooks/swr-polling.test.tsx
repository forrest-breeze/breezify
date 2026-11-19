// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGithubHostedDocs } from "./swr"

function statusResponse(syncStatus: string): Response {
  return new Response(
    JSON.stringify({
      source: { sync_status: syncStatus, updated_at: "2026-11-19T22:01:28Z" },
      linked_folder: null,
      linked_path_count: 0,
      linked_document_count: 0,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function wrapper({ children }: { children: React.ReactNode }) {
  // A fresh cache per test, with nothing stored: the cold-load case.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  )
}

describe("useGithubHostedDocs polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("starts polling when the first response reports a sync, and stops when it ends", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(statusResponse("pending"))
      .mockResolvedValueOnce(statusResponse("syncing"))
      .mockResolvedValue(statusResponse("synced"))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useGithubHostedDocs(), { wrapper })

    // Nothing was cached at mount, so the interval started at 0.
    await waitFor(() =>
      expect(result.current.data?.source?.sync_status).toBe("pending"),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await waitFor(() =>
      expect(result.current.data?.source?.sync_status).toBe("syncing"),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await waitFor(() =>
      expect(result.current.data?.source?.sync_status).toBe("synced"),
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Synced: no further polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

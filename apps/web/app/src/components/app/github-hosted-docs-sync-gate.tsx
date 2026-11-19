"use client"

import { GitMerge } from "lucide-react"
import { useGithubHostedDocs, type GithubHostedDocsResponse } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { LoadingBar } from "@/components/ui/loading-bar"
import type { HostedDocsSyncSnapshot } from "@/lib/github/github-hosted-docs-sync-snapshot"

interface GithubHostedDocsSyncGateProps {
  children: React.ReactNode
  /**
   * The sync state the server read while rendering the layout: `null` when no
   * repository is linked, `undefined` when it could not be read.
   */
  initialSource?: HostedDocsSyncSnapshot | null
}

/**
 * The newer of the server's snapshot and the client's status. The client
 * status can come from the cache persisted in localStorage, which may predate
 * the server render; a response fetched after it is always at least as new.
 */
function freshestSource(
  initialSource: HostedDocsSyncSnapshot | null | undefined,
  data: GithubHostedDocsResponse | undefined,
): HostedDocsSyncSnapshot | null {
  if (!data) return initialSource ?? null
  const live = data.source
  if (!initialSource || !live) return live
  return Date.parse(initialSource.updated_at) > Date.parse(live.updated_at)
    ? initialSource
    : live
}

/**
 * Keep both workspace editors unmounted while GitHub is changing their shared
 * document tree. Unmounting is intentional: it prevents autosave and portal
 * draft mutations from racing the repository reconciliation.
 *
 * The lock engages only on a *known* in-flight sync (`pending` / `syncing`).
 * The server decides it first: the layout reads the stored sync state and
 * passes it as `initialSource`, so the lock (or the editor) is in the server
 * HTML and does not wait for a client fetch. After hydration the status hook
 * takes over, polling while a sync runs so the lock lifts when it completes.
 *
 * The status check itself runs in the background: SWR revalidates on every
 * mount, and the layouts that host this gate remount on each route switch, so
 * blocking on `isLoading` / `isValidating` would replace the page with a
 * "checking" card every time the user moves between Knowledge and the portal
 * editor.
 *
 * Client status is applied post-hydration only. The server never has SWR data,
 * so branching on cached data before hydration would mismatch the server tree.
 */
export function GithubHostedDocsSyncGate({
  children,
  initialSource,
}: GithubHostedDocsSyncGateProps): React.ReactElement {
  const hydrated = useHasHydrated()
  const { data, error } = useGithubHostedDocs()
  const source = hydrated
    ? freshestSource(initialSource, data)
    : (initialSource ?? null)
  const syncing =
    source?.sync_status === "pending" || source?.sync_status === "syncing"

  // A failed status request fails open: with no way to learn that the sync
  // finished, a lock would never lift.
  if (syncing && !(hydrated && error)) {
    // "." is how a ReadMe-format link records the repository root.
    const storedRoot = source?.paths?.[0]
    const root = storedRoot === "." ? "" : storedRoot

    return (
      <div
        className="flex h-full min-h-[calc(100svh-3.5rem)] items-center justify-center bg-background px-6 lg:min-h-screen"
        role="status"
        aria-live="polite"
      >
        <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <GitMerge className="size-5 text-muted-foreground" />
          </div>
          <h1 className="mt-4 text-lg font-semibold">
            Syncing Breezify docs from GitHub
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Knowledge and portal editing are temporarily locked so local edits
            cannot race the repository reconciliation.
          </p>
          {source && storedRoot ? (
            <p className="mt-4 truncate rounded-md bg-muted/60 px-3 py-2 font-mono text-xs text-muted-foreground">
              {source.repo_full_name}
              {root ? `/${root}` : ""}
            </p>
          ) : null}
          <LoadingBar
            label="GitHub docs reconciliation progress"
            className="mt-4"
          />
          <p className="mt-3 text-xs text-muted-foreground">
            This screen unlocks automatically when the sync completes.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

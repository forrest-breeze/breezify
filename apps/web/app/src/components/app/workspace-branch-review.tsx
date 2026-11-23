"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileMinus2,
  FilePen,
  FilePlus2,
  GitBranch,
  GitMerge,
  GitPullRequestDraft,
  Tag,
  UserCheck,
} from "lucide-react"
import {
  useGithubHostedDocs,
  useGithubHostedDocsPublishStatus,
  useGithubHostedDocsReview,
  useWorkspace,
  type GithubHostedDocsReview,
  type GithubHostedDocsReviewFile,
} from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { mergeGithubPublishPullRequest } from "@/lib/github/api/docs-automation"
import { compactAge } from "@/lib/github/branch-groups"
import { readmeWorkingBranch } from "@/lib/github/readme/readme-branch-name"
import { Button } from "@/components/ui/button"
import { LoadingBar } from "@/components/ui/loading-bar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The Review of a working branch: the branch workspace changes were saved to
// instead of the synced version. It shows what merging the branch would change
// (Overview and Diff), and carries the two steps that move it along: asking
// for a review and merging it into the version.
//
// The review is the branch's pull request on GitHub. Comments and approvals
// live there; this page links to it rather than copying them.
// ---------------------------------------------------------------------------

const REQUEST_ROLES = new Set(["owner", "admin", "editor"])
const MERGE_ROLES = new Set(["owner", "admin"])

const STATUS_ICON = {
  added: FilePlus2,
  modified: FilePen,
  renamed: FilePen,
  removed: FileMinus2,
} as const

const STATUS_TONE = {
  added: "text-emerald-700 dark:text-emerald-300",
  modified: "text-amber-700 dark:text-amber-400",
  renamed: "text-amber-700 dark:text-amber-400",
  removed: "text-red-700 dark:text-red-300",
} as const

function LineCounts({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}): React.ReactElement {
  return (
    <span
      className={cn("shrink-0 font-mono text-[11px] tabular-nums", className)}
      aria-label={`${additions} lines added, ${deletions} lines removed`}
    >
      <span className="text-emerald-700 dark:text-emerald-300">+{additions}</span>{" "}
      <span className="text-red-700 dark:text-red-300">−{deletions}</span>
    </span>
  )
}

/** Trailing path segment, with the leading directories shown muted beside it. */
function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/")
  return index === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

/** A unified diff as GitHub returns it, one row per line. */
function PatchView({ patch }: { patch: string }): React.ReactElement {
  return (
    <div className="overflow-hidden rounded border bg-muted/20 font-mono text-xs">
      {patch.split("\n").map((line, index) => {
        const hunk = line.startsWith("@@")
        const added = !hunk && line.startsWith("+")
        const removed = !hunk && line.startsWith("-")
        const note = line.startsWith("\\")
        return (
          <div
            key={index}
            className={cn(
              // `anywhere`: frontmatter ids and long URLs have no break
              // opportunity and would otherwise set the width of the pane.
              "whitespace-pre-wrap px-3 py-1 leading-relaxed [overflow-wrap:anywhere]",
              hunk &&
                "border-y border-border/60 bg-background/80 text-[11px] text-muted-foreground first:border-t-0",
              added && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              removed && "bg-red-500/10 text-red-700 dark:text-red-300",
              !hunk && !added && !removed && "text-muted-foreground",
            )}
          >
            {hunk || note ? (
              line
            ) : (
              <>
                <span className="mr-2 inline-block w-3 select-none text-center opacity-70">
                  {added ? "+" : removed ? "-" : " "}
                </span>
                {line.slice(1) || " "}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function fileSummary(review: GithubHostedDocsReview): string {
  const count = (status: GithubHostedDocsReviewFile["status"]): number =>
    review.files.filter((file) => file.status === status).length
  const parts = [
    [count("modified") + count("renamed"), "changed"],
    [count("added"), "added"],
    [count("removed"), "removed"],
  ]
    .filter(([total]) => (total as number) > 0)
    .map(([total, verb]) => `${total} ${verb}`)
  const pages = `${review.file_count} file${review.file_count === 1 ? "" : "s"}`
  return parts.length > 1 || review.truncated
    ? `${pages} (${parts.join(", ")})`
    : `${pages} ${parts[0]?.split(" ")[1] ?? "changed"}`
}

function Overview({ review }: { review: GithubHostedDocsReview }): React.ReactElement {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-8">
        <section aria-labelledby="review-summary">
          <h2 id="review-summary" className="text-sm font-semibold">
            Summary
          </h2>
          {review.file_count === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              This branch has no changes that {review.base} does not already have.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm">
                Merging <span className="font-mono">{review.branch}</span> into{" "}
                <span className="font-mono">{review.base}</span> would update {fileSummary(review)}:{" "}
                <LineCounts additions={review.additions} deletions={review.deletions} className="text-xs" />
              </p>
              <ul className="mt-3 space-y-1">
                {review.files.slice(0, 8).map((file) => {
                  const Icon = STATUS_ICON[file.status]
                  return (
                    <li key={file.path} className="flex items-center gap-2 text-xs">
                      <Icon className={cn("size-3.5 shrink-0", STATUS_TONE[file.status])} aria-hidden="true" />
                      <span className="min-w-0 truncate font-mono" title={file.path}>
                        {file.path}
                      </span>
                      <LineCounts additions={file.additions} deletions={file.deletions} className="ml-auto" />
                    </li>
                  )
                })}
              </ul>
              {review.file_count > 8 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  and {review.file_count - 8} more in the Diff tab.
                </p>
              ) : null}
            </>
          )}
        </section>

        <section aria-labelledby="review-activity">
          <h2 id="review-activity" className="text-sm font-semibold">
            Activity
          </h2>
          <ol className="mt-3 space-y-2.5">
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Branch created</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{compactAge(review.pull_request.created_at)}</span>
            </li>
            {review.commits.map((commit) => (
              <li key={commit.sha} className="flex items-start gap-2 text-sm">
                <FilePen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {commit.url ? (
                    <a
                      href={commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {commit.subject}
                    </a>
                  ) : (
                    commit.subject
                  )}
                  <span className="text-muted-foreground">
                    {" "}
                    · {commit.author}
                    {commit.date ? ` · ${compactAge(commit.date)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-6">
        <section aria-labelledby="review-contributors">
          <h2 id="review-contributors" className="text-xs font-medium text-muted-foreground">
            Contributors
          </h2>
          {review.contributors.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No commits yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {review.contributors.map((contributor) => (
                <li key={`${contributor.login ?? ""}:${contributor.name}`} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium uppercase"
                  >
                    {contributor.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{contributor.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {compactAge(contributor.last_active_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="review-reviewers">
          <h2 id="review-reviewers" className="text-xs font-medium text-muted-foreground">
            Reviewers
          </h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Reviews and comments are on the pull request.
          </p>
          {review.pull_request.url ? (
            <a
              href={review.pull_request.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm hover:underline"
            >
              Pull request #{review.pull_request.number}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          ) : null}
        </section>
      </aside>
    </div>
  )
}

function Diff({ review }: { review: GithubHostedDocsReview }): React.ReactElement {
  const [activePath, setActivePath] = useState<string | null>(null)
  const active = review.files.find((file) => file.path === activePath) ?? review.files[0] ?? null

  if (!active) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Nothing on this branch differs from {review.base}.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Changed files"
        className="w-72 shrink-0 overflow-y-auto overscroll-contain border-r border-border p-2"
      >
        <ul className="space-y-0.5">
          {review.files.map((file) => {
            const Icon = STATUS_ICON[file.status]
            const { dir, name } = splitPath(file.path)
            const isActive = file.path === active.path
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setActivePath(file.path)}
                  aria-current={isActive ? "true" : undefined}
                  title={file.path}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                    isActive ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", STATUS_TONE[file.status])} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{name}</span>
                    {dir ? (
                      <span className="block truncate text-[11px] text-muted-foreground">{dir}</span>
                    ) : null}
                  </span>
                  <LineCounts additions={file.additions} deletions={file.deletions} className="mt-0.5" />
                </button>
              </li>
            )
          })}
        </ul>
        {review.truncated ? (
          <p className="px-2 pt-2 text-[11px] leading-4 text-muted-foreground">
            Showing {review.files.length} of {review.file_count} files. The rest are on the pull request.
          </p>
        ) : null}
      </nav>

      {/* min-w-0: one long unbroken token must not widen the pane. */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate font-mono text-xs">
            {active.previous_path ? `${active.previous_path} → ` : ""}
            {active.path}
          </p>
          <span
            className={cn(
              "shrink-0 text-[11px] font-medium uppercase tracking-wide",
              STATUS_TONE[active.status],
            )}
          >
            {active.status}
          </span>
        </div>
        {active.patch ? (
          <PatchView patch={active.patch} />
        ) : (
          <p className="rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {active.status === "renamed" && active.additions + active.deletions === 0
              ? "Renamed without changes."
              : "This diff is too large to show here. Open the pull request to read it."}
          </p>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col items-center justify-center gap-3 px-6 text-center lg:h-screen">
      {children}
    </div>
  )
}

export function WorkspaceBranchReview(): React.ReactElement {
  const { data: workspace } = useWorkspace()
  const { data: hostedDocs, isLoading: sourceLoading, mutate: mutateSource } = useGithubHostedDocs()
  const source = hostedDocs?.source ?? null
  const { data, error, isLoading, mutate } = useGithubHostedDocsReview(source)
  const canRequest = Boolean(workspace && REQUEST_ROLES.has(workspace.user_role))
  const canMerge = Boolean(workspace && MERGE_ROLES.has(workspace.user_role))
  const { data: publishStatus, mutate: mutatePublishStatus } = useGithubHostedDocsPublishStatus(source, {
    enabled: canRequest,
  })

  const [tab, setTab] = useState<"overview" | "diff">("overview")
  const [requesting, setRequesting] = useState(false)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [merging, setMerging] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** The branch and version of a merge made from this page. */
  const [merged, setMerged] = useState<{ branch: string; base: string } | null>(null)
  const hydrated = useHasHydrated()

  // GitHub says the branch is gone (merged, closed or deleted there) while
  // the workspace still shows it: read the link again so the sidebar leaves
  // the branch too.
  const closedElsewhere = data?.open === false && readmeWorkingBranch(source) !== null
  useEffect(() => {
    if (closedElsewhere) void mutateSource()
  }, [closedElsewhere, mutateSource])

  // The server has no cached data and renders the loading state; the cache
  // restored from localStorage would render the review on the first client
  // pass. Hold the server's render until hydration is done.
  if (!hydrated) {
    return (
      <Centered>
        <span className="text-sm text-muted-foreground">Loading the review…</span>
        <LoadingBar label="Review loading progress" className="w-full max-w-48" />
      </Centered>
    )
  }

  if (merged) {
    return (
      <Centered>
        <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <p className="text-sm font-medium">
          Merged <span className="font-mono">{merged.branch}</span> into{" "}
          <span className="font-mono">{merged.base}</span>
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          The workspace is back on {merged.base}. New changes are published there until you save to
          another branch.
        </p>
        <Link href="/editor" className="text-sm underline-offset-4 hover:underline">
          Back to the editor
        </Link>
      </Centered>
    )
  }

  if (!data && (sourceLoading || isLoading)) {
    return (
      <Centered>
        <span className="text-sm text-muted-foreground">Loading the review…</span>
        <LoadingBar label="Review loading progress" className="w-full max-w-48" />
      </Centered>
    )
  }

  if (error && !data) {
    return (
      <Centered>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Could not load the review of this branch."}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void mutate()}>
          Try again
        </Button>
      </Centered>
    )
  }

  if (!data || !data.open) {
    return (
      <Centered>
        <GitBranch className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">No branch to review</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          When you publish, choose “Save to a branch” to collect changes on a branch of their own.
          They are reviewed here before they are merged into {source?.branch ?? "the synced version"}.
        </p>
        <Link href="/editor" className="text-sm underline-offset-4 hover:underline">
          Back to the editor
        </Link>
      </Centered>
    )
  }

  const review = data
  const draft = review.pull_request.draft
  const pendingCount =
    publishStatus?.status === "changes" ? publishStatus.changed_file_count : 0

  const requestReview = async (): Promise<void> => {
    setRequesting(true)
    setActionError(null)
    try {
      const response = await fetch("/api/github/hosted-docs/review", { method: "POST" })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? "Could not request a review.")
      }
      await mutate(
        (current) =>
          current?.open
            ? { ...current, pull_request: { ...current.pull_request, draft: false } }
            : current,
        { revalidate: true },
      )
    } catch (requestError) {
      setActionError(
        requestError instanceof Error ? requestError.message : "Could not request a review.",
      )
    } finally {
      setRequesting(false)
    }
  }

  const merge = async (): Promise<void> => {
    setMerging(true)
    setActionError(null)
    const result = await mergeGithubPublishPullRequest()
    setMerging(false)
    if (result.error) {
      setActionError(result.error)
      setConfirmMerge(false)
      return
    }
    setConfirmMerge(false)
    setMerged({ branch: review.branch, base: review.base })
    void Promise.all([mutateSource(), mutatePublishStatus()])
  }

  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col lg:h-screen">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5">
        <h1 className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-mono">{review.base}</span>
          <span className="text-muted-foreground" aria-hidden="true">
            ›
          </span>
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-mono" title={review.branch}>
            {review.branch}
          </span>
          <span className="sr-only">review</span>
        </h1>

        <div role="tablist" aria-label="Review" className="flex items-center gap-1 rounded-full bg-muted/60 p-0.5">
          {(
            [
              ["overview", "Overview"],
              ["diff", "Diff"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                tab === key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {key === "diff" ? (
                <LineCounts additions={review.additions} deletions={review.deletions} />
              ) : null}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium">
            {draft ? (
              <GitPullRequestDraft className="size-3.5 text-muted-foreground" aria-hidden="true" />
            ) : (
              <UserCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            )}
            {draft ? "Draft" : "Ready for review"}
          </span>
          {draft && canRequest ? (
            <Button type="button" size="sm" disabled={requesting} onClick={() => void requestReview()}>
              <UserCheck className="size-3.5" />
              {requesting ? "Requesting review" : "Request review"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canMerge || review.file_count === 0}
            title={
              !canMerge
                ? "Only workspace owners and admins can merge."
                : review.file_count === 0
                  ? "There is nothing to merge."
                  : undefined
            }
            onClick={() => {
              setActionError(null)
              setConfirmMerge(true)
            }}
          >
            <GitMerge className="size-3.5" />
            Merge to {review.base}
          </Button>
        </div>
      </header>

      {actionError ? (
        <p role="alert" className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {pendingCount > 0 ? (
        <p className="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-5 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {pendingCount} saved change{pendingCount === 1 ? " is" : "s are"} not on this branch yet. Save
          to {review.branch} from the sidebar to include {pendingCount === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {review.behind_by > 0 ? (
        <p className="shrink-0 border-b border-border px-5 py-2 text-xs text-muted-foreground">
          {review.base} has {review.behind_by} newer commit{review.behind_by === 1 ? "" : "s"} than this
          branch. GitHub merges both; it will say so if they touch the same lines.
        </p>
      ) : null}

      {tab === "overview" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Overview review={review} />
        </div>
      ) : (
        <Diff review={review} />
      )}

      <AlertDialog
        open={confirmMerge}
        onOpenChange={(open) => {
          if (!merging) setConfirmMerge(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {review.branch} into {review.base}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This merges pull request #{review.pull_request.number} in {review.repo_full_name}, which
              makes {review.file_count} changed file{review.file_count === 1 ? "" : "s"} live on{" "}
              {review.base}.
              {draft ? " The pull request is still a draft; merging marks it ready first." : ""}
              {pendingCount > 0
                ? ` ${pendingCount} saved change${pendingCount === 1 ? " is" : "s are"} not on the branch and will not be merged.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {merging ? <LoadingBar label="Merge progress" /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={merging}
              onClick={(event) => {
                event.preventDefault()
                void merge()
              }}
            >
              {merging ? "Merging" : `Merge to ${review.base}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

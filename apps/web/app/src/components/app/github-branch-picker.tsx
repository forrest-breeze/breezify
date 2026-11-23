"use client"

import React, { useMemo, useRef, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { Check, ExternalLink, GitBranch, Search, Tag } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useGithubHostedDocs } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import {
  compactAge,
  filterBranchGroups,
  type BranchEntry,
  type BranchGroups,
} from "@/lib/github/branch-groups"
import { readmeWorkingBranch } from "@/lib/github/readme/readme-branch-name"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The version pill in the Knowledge sidebar header. It names the branch
// this workspace is synced with and opens ReadMe's two-pane picker: the
// repository's versions on the left, the branches cut from the selected
// version on the right. Every branch opens on GitHub; the working branch, the
// one workspace changes are being saved to, is shown beside the version and
// opens its review.
// ---------------------------------------------------------------------------

interface BranchesResponse extends BranchGroups {
  linked: boolean
  repo_full_name?: string
  default_branch?: string | null
  synced_branch?: string | null
  truncated?: boolean
}

const BRANCHES_PATH = "/api/github/hosted-docs/branches"
const SETTINGS_PATH = "/settings/integrations/github"
const REVIEW_PATH = "/editor/review"

async function loadBranches(url: string): Promise<BranchesResponse> {
  const response = await fetch(url)
  const body = (await response.json().catch(() => ({}))) as BranchesResponse & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Could not load branches.")
  return body
}

function branchUrl(repoFullName: string, name: string): string {
  return `https://github.com/${repoFullName}/tree/${name.split("/").map(encodeURIComponent).join("/")}`
}

/** The version holding the synced branch, else the default version. */
function homeVersion(groups: BranchGroups): string | null {
  const home =
    groups.versions.find(
      (version) => version.synced || version.branches.some((branch) => branch.synced),
    ) ?? groups.versions.find((version) => version.isDefault)
  return home?.name ?? null
}

const rowClass =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"

function SyncedMark(): React.JSX.Element {
  return (
    <>
      <Check className="size-3.5 shrink-0 text-foreground/70" aria-hidden="true" />
      <span className="sr-only">(synced)</span>
    </>
  )
}

function VersionRow({
  label,
  isDefault,
  synced,
  selected,
  onSelect,
}: {
  label: string
  isDefault: boolean
  synced: boolean
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        title={synced ? "This workspace is synced with this version" : undefined}
        className={cn(rowClass, selected && "bg-muted")}
      >
        <span className="truncate">{label}</span>
        {isDefault ? (
          <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 text-[11px] font-medium leading-[18px] text-muted-foreground">
            Default
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">{synced ? <SyncedMark /> : null}</span>
      </button>
    </li>
  )
}

function BranchRow({
  branch,
  repoFullName,
  onNavigate,
}: {
  branch: BranchEntry
  repoFullName: string
  onNavigate: () => void
}): React.JSX.Element {
  const age = compactAge(branch.updatedAt)
  // The working branch is the one this workspace is on: it opens its review
  // here, not the branch on GitHub.
  if (branch.working) {
    return (
      <li>
        <Link
          href={REVIEW_PATH}
          onClick={onNavigate}
          title={[branch.name, "Saving changes here", "Open the review"].join(" · ")}
          className={cn(rowClass, "bg-muted/60")}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{branch.name}</span>
          <span className="shrink-0 text-xs font-medium">Review</span>
        </Link>
      </li>
    )
  }
  return (
    <li>
      <a
        href={branchUrl(repoFullName, branch.name)}
        target="_blank"
        rel="noopener noreferrer"
        title={[branch.name, branch.author, age, "Open on GitHub"].filter(Boolean).join(" · ")}
        className={rowClass}
      >
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {branch.synced ? <SyncedMark /> : null}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {age.replace(/ ago$/, "")}
        </span>
      </a>
    </li>
  )
}

function PaneHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1 px-3.5 pb-1 pt-3 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  )
}

export function GithubBranchPicker({
  className,
  align = "start",
}: {
  className?: string
  /** Which edge of the pill the list lines up with. */
  align?: "start" | "end"
}): React.JSX.Element | null {
  const { data: hostedDocs } = useGithubHostedDocs()
  const source = hostedDocs?.source ?? null
  const linked = Boolean(source && source.format === "readme" && source.sync_status !== "disabled")
  const { data, error, isLoading } = useSWR<BranchesResponse>(
    // Keyed by the working branch, so starting or merging one reads the
    // repository's branches again.
    linked
      ? `${BRANCHES_PATH}?working=${encodeURIComponent(readmeWorkingBranch(source) ?? "")}`
      : null,
    loadBranches,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  // The version the reader clicked; null shows the one holding the synced branch.
  const [selected, setSelected] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const groups = useMemo(
    () => (data?.linked ? filterBranchGroups(data, query) : null),
    [data, query],
  )
  const home = useMemo(() => (data?.linked ? homeVersion(data) : null), [data])
  // The server has no SWR data and renders nothing; the cache restored from
  // localStorage would render the pill on the first client pass.
  const hydrated = useHasHydrated()
  if (!hydrated || !linked || !source) return null

  const current = source.branch ?? data?.synced_branch ?? null
  const workingBranch = readmeWorkingBranch(source)
  // `v1.6_pricing` beside `v1.6` reads as `pricing`.
  const workingLabel =
    workingBranch && current && /^[_/]/.test(workingBranch.slice(current.length)) &&
    workingBranch.startsWith(current)
      ? workingBranch.slice(current.length + 1)
      : workingBranch
  const repo = data?.repo_full_name ?? source.repo_full_name
  const versions = groups?.versions ?? []
  const activeVersion =
    [selected, home]
      .map((name) => versions.find((version) => version.name === name))
      .find(Boolean) ??
    versions[0] ??
    null

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) {
      setQuery("")
      setSelected(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={cn(
          "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
        aria-label={`Versions and branches${current ? `, synced with ${current}` : ""}${
          workingBranch ? `, saving to ${workingBranch}` : ""
        }`}
      >
        <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 font-mono">{current ?? "default branch"}</span>
        {workingBranch ? (
          <>
            <span className="text-muted-foreground" aria-hidden="true">
              ›
            </span>
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-mono" title={workingBranch}>
              {workingLabel}
            </span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        initialFocus={searchRef}
        aria-label="Versions and branches"
        className="w-[36rem] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <label className="flex h-11 items-center gap-2.5 border-b border-border px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search branches"
            aria-label="Search branches"
            className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>

        {workingBranch ? (
          <Link
            href={REVIEW_PATH}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate">
              Saving changes to <span className="font-mono">{workingBranch}</span>
            </span>
            <span className="ml-auto shrink-0 font-medium">Review</span>
          </Link>
        ) : null}

        {error ? (
          <p role="alert" className="px-3.5 py-8 text-center text-xs text-destructive">
            {error instanceof Error ? error.message : "Could not load branches."}
          </p>
        ) : isLoading || !groups ? (
          <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">Loading branches…</p>
        ) : !activeVersion ? (
          <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">
            {query.trim() ? "No branch matches that search." : "No versions yet."}
          </p>
        ) : (
          <div className="flex max-h-72 min-h-40">
            <section aria-label="Versions" className="flex w-2/5 min-w-0 flex-col border-r border-border">
              <PaneHeading>Versions</PaneHeading>
              <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
                {versions.map((version) => (
                  <VersionRow
                    key={version.name}
                    label={version.name}
                    isDefault={version.isDefault}
                    synced={version.name === home}
                    selected={version === activeVersion}
                    onSelect={() => setSelected(version.name)}
                  />
                ))}
              </ul>
              {data?.truncated ? (
                <p className="px-3.5 pb-2 text-[11px] leading-4 text-muted-foreground">
                  Showing the first {data.total} branches.
                </p>
              ) : null}
            </section>

            <section
              aria-label={`Branches in ${activeVersion.name}`}
              className="flex min-w-0 flex-1 flex-col"
            >
              <PaneHeading>
                <span className="truncate">Branches in {activeVersion.name}</span>
                <a
                  href={branchUrl(repo, activeVersion.name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${activeVersion.name} on GitHub`}
                  title={`Open ${activeVersion.name} on GitHub`}
                  className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
                >
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </PaneHeading>
              {activeVersion.branches.length > 0 ? (
                <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
                  {activeVersion.branches.map((branch) => (
                    <BranchRow
                      key={branch.name}
                      branch={branch}
                      repoFullName={repo}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-3.5 py-1.5 text-xs text-muted-foreground">
                  No branches in {activeVersion.name} yet.
                </p>
              )}
            </section>
          </div>
        )}

        <div className="flex border-t border-border">
          <div className="w-2/5 min-w-0 border-r border-border p-1.5">
            <Link
              href={SETTINGS_PATH}
              onClick={() => setOpen(false)}
              title="Change the synced version in Settings, Integrations, GitHub"
              className={rowClass}
            >
              <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">Manage versions</span>
            </Link>
          </div>
          <div className="min-w-0 flex-1 p-1.5">
            <a
              href={`https://github.com/${repo}/branches`}
              target="_blank"
              rel="noopener noreferrer"
              title={`${repo} on GitHub`}
              className={rowClass}
            >
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">View all branches</span>
              <ExternalLink className="ml-auto size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            </a>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

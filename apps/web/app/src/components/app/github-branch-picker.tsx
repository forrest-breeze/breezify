"use client"

import React, { useMemo, useState } from "react"
import useSWR from "swr"
import { ChevronRight, ExternalLink, GitBranch, Search, Tag } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useGithubHostedDocs } from "@/hooks/swr"
import {
  compactAge,
  filterBranchGroups,
  type BranchEntry,
  type BranchGroups,
} from "@/lib/github/branch-groups"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The version pill at the top of the Knowledge sidebar. It names the branch
// this workspace is synced with and opens a list of the repository's versions
// with the branches that belong to each. Read-only: every row opens the branch
// on GitHub.
// ---------------------------------------------------------------------------

interface BranchesResponse extends BranchGroups {
  linked: boolean
  repo_full_name?: string
  default_branch?: string | null
  synced_branch?: string | null
  truncated?: boolean
}

const BRANCHES_PATH = "/api/github/hosted-docs/branches"

async function loadBranches(url: string): Promise<BranchesResponse> {
  const response = await fetch(url)
  const body = (await response.json().catch(() => ({}))) as BranchesResponse & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Could not load branches.")
  return body
}

function branchUrl(repoFullName: string, name: string): string {
  return `https://github.com/${repoFullName}/tree/${name.split("/").map(encodeURIComponent).join("/")}`
}

function Badge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  )
}

function BranchLink({
  branch,
  repoFullName,
  indented,
}: {
  branch: BranchEntry
  repoFullName: string
  indented?: boolean
}): React.JSX.Element {
  return (
    <a
      href={branchUrl(repoFullName, branch.name)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group flex items-center gap-2 rounded-md py-1.5 pr-2 text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
        indented ? "pl-7" : "pl-2",
      )}
    >
      <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono" title={branch.name}>
        {branch.name}
      </span>
      {branch.synced ? <Badge>Synced</Badge> : null}
      <span className="hidden max-w-24 shrink-0 truncate text-muted-foreground sm:inline" title={branch.author ?? undefined}>
        {branch.author}
      </span>
      <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
        {compactAge(branch.updatedAt)}
      </span>
      <ExternalLink
        className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden="true"
      />
    </a>
  )
}

function Group({
  label,
  count,
  icon,
  badges,
  age,
  open,
  onToggle,
  children,
}: {
  label: string
  count: number
  icon: React.ReactNode
  badges?: React.ReactNode
  age?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        {icon}
        <span className="truncate font-medium">{label}</span>
        {badges}
        <span className="ml-auto shrink-0 text-muted-foreground">
          {count} branch{count === 1 ? "" : "es"}
          {age ? ` · ${age}` : ""}
        </span>
      </button>
      {open ? <div className="pb-1">{children}</div> : null}
    </li>
  )
}

export function GithubBranchPicker({ className }: { className?: string }): React.JSX.Element | null {
  const { data: hostedDocs } = useGithubHostedDocs()
  const source = hostedDocs?.source ?? null
  const linked = Boolean(source && source.format === "readme" && source.sync_status !== "disabled")
  const { data, error, isLoading } = useSWR<BranchesResponse>(
    linked ? BRANCHES_PATH : null,
    loadBranches,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  )
  const [query, setQuery] = useState("")
  // Which groups the reader opened or closed; the synced version starts open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  const groups = useMemo(
    () => (data?.linked ? filterBranchGroups(data, query) : null),
    [data, query],
  )
  if (!linked || !source) return null

  const current = source.branch ?? data?.synced_branch ?? null
  const searching = query.trim().length > 0
  const isOpen = (key: string, fallback: boolean): boolean =>
    searching ? true : toggled[key] ?? fallback
  const toggle = (key: string, fallback: boolean): void =>
    setToggled((state) => ({ ...state, [key]: !(state[key] ?? fallback) }))
  const repo = data?.repo_full_name ?? source.repo_full_name
  const nothingFound =
    groups !== null && groups.versions.length === 0 && groups.other.length === 0

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
        aria-label={`Versions and branches${current ? `, synced with ${current}` : ""}`}
      >
        <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-mono">{current ?? "default branch"}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Versions and branches</p>
            <a
              href={`https://github.com/${repo}/branches`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            >
              {repo}
              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            </a>
          </div>
          <label className="flex h-8 items-center gap-2 rounded-md border border-input px-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search branches"
              aria-label="Search branches"
              className="h-full w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {error ? (
            <p role="alert" className="px-2 py-3 text-xs text-destructive">
              {error instanceof Error ? error.message : "Could not load branches."}
            </p>
          ) : isLoading || !groups ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Loading branches…</p>
          ) : nothingFound ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No branch matches that search.</p>
          ) : (
            <ul className="space-y-0.5">
              {groups.versions.map((version) => {
                const key = `version:${version.name}`
                const open = isOpen(key, version.synced)
                return (
                  <Group
                    key={key}
                    label={version.name}
                    count={version.branches.length}
                    icon={<Tag className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    badges={
                      <>
                        {version.synced ? <Badge>Synced</Badge> : null}
                        {version.isDefault ? <Badge>Default</Badge> : null}
                      </>
                    }
                    age={compactAge(version.updatedAt)}
                    open={open}
                    onToggle={() => toggle(key, version.synced)}
                  >
                    <BranchLink branch={version} repoFullName={repo} indented />
                    {version.branches.map((branch) => (
                      <BranchLink key={branch.name} branch={branch} repoFullName={repo} indented />
                    ))}
                  </Group>
                )
              })}
              {groups.other.length > 0 ? (
                <Group
                  label="Other branches"
                  count={groups.other.length}
                  icon={<GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  open={isOpen("other", groups.versions.length === 0)}
                  onToggle={() => toggle("other", groups.versions.length === 0)}
                >
                  {groups.other.map((branch) => (
                    <BranchLink key={branch.name} branch={branch} repoFullName={repo} indented />
                  ))}
                </Group>
              ) : null}
            </ul>
          )}
        </div>

        {data?.linked ? (
          <p className="border-t border-border px-3 py-2 text-[11px] leading-4 text-muted-foreground">
            {data.total} branch{data.total === 1 ? "" : "es"}
            {data.truncated ? " shown; the repository has more" : ""}. This workspace is synced
            with <span className="font-mono">{data.synced_branch ?? "the default branch"}</span>.
            Change it in Settings, Integrations, GitHub.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

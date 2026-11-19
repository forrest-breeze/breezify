"use client"

import React, { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitBranch,
  RefreshCw,
  Repeat,
  Unlink,
} from "lucide-react"
import type { GitHubHostedDocsSourceRow, GitHubIntegrationRow } from "@breezify/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingBar } from "@/components/ui/loading-bar"
import { Skeleton } from "@/components/ui/skeleton"
import { InfoHint } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import {
  useAvailableGithubRepos,
  useGithubHostedDocs,
  useGithubIntegration,
  useWorkspace,
} from "@/hooks/swr"
import {
  disableGithubHostedDocsSource,
  initiateGithubInstall,
  saveGithubHostedDocsSource,
} from "@/lib/github/api/github-integrations"
import { GithubBranchPicker } from "@/components/app/github-branch-picker"
import {
  GithubDocsAutomationSettings,
  MergePublishPullRequestButton,
} from "@/components/settings/github-docs-automation"
import { OpenApiSpecs } from "@/components/settings/openapi-specs"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Settings -> Integrations -> GitHub.
//
// Two-way sync between this workspace and a GitHub repository, in the layout
// ReadMe's GitHub integration uses (docs/, reference/, _order.yaml, index.md,
// YAML frontmatter). A repository that was synced with ReadMe can be linked
// here as it is.
//
// Connecting takes two steps: install the GitHub App on an organization or
// account, then link one of its repositories. Each step shows a status chip
// that opens its options. The installation can only be removed on GitHub.
// ---------------------------------------------------------------------------

type PublishMode = "direct" | "pull_request"

const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "The GitHub App installation was cancelled.",
  invalid_request: "GitHub returned an incomplete installation response. Try again.",
  invalid_state: "The installation link expired. Start again from this page.",
  server_misconfigured: "The GitHub App is not configured on this deployment.",
  github_api_error: "GitHub could not confirm the installation. Try again.",
  unauthorized: "Sign in as a workspace admin to connect GitHub.",
}

interface SkippedFile {
  path: string
  reason: string
  quiet?: boolean
}

function skippedFiles(source: GitHubHostedDocsSourceRow): SkippedFile[] {
  const skipped = (source.sync_state as { skipped?: unknown } | null | undefined)?.skipped
  if (!Array.isArray(skipped)) return []
  return skipped.filter(
    (entry): entry is SkippedFile =>
      typeof (entry as SkippedFile)?.path === "string" &&
      typeof (entry as SkippedFile)?.reason === "string",
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function sourceRoot(source: GitHubHostedDocsSourceRow): string {
  return source.paths[0] && source.paths[0] !== "." ? source.paths[0] : ""
}

/** Where GitHub manages this installation: repository access and uninstalling. */
function installationSettingsUrl(integration: GitHubIntegrationRow): string {
  return integration.github_account_type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(integration.github_account_login)}/settings/installations/${integration.installation_id}`
    : `https://github.com/settings/installations/${integration.installation_id}`
}

function PublishModeField({
  value,
  onChange,
  disabled,
}: {
  value: PublishMode
  onChange: (value: PublishMode) => void
  disabled?: boolean
}): React.JSX.Element {
  const options: Array<{ value: PublishMode; title: string; description?: string }> = [
    {
      value: "direct",
      title: "Commit directly",
      description:
        "A protected branch must let the Breezify GitHub App bypass its rules. Otherwise, open a pull request instead.",
    },
    { value: "pull_request", title: "Open a pull request" },
  ]
  return (
    <div role="radiogroup" aria-label="How Breezify publishes to GitHub" className="space-y-2">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 has-[:checked]:border-foreground"
        >
          <input
            type="radio"
            name="publish-mode"
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {option.title}
            {option.description ? <InfoHint>{option.description}</InfoHint> : null}
          </span>
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connection steps
// ---------------------------------------------------------------------------

const statusChipClass =
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

function ConnectionStep({
  step,
  done,
  inactive,
  title,
  description,
  status,
  children,
}: {
  step: number
  done: boolean
  /** Dims a step that cannot start until the previous one is done. */
  inactive?: boolean
  title: string
  description?: React.ReactNode
  status?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="px-4 py-3">
      <div className={cn("flex items-center gap-3", inactive && "opacity-60")}>
        <span
          aria-hidden="true"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
            done ? "bg-emerald-600 text-white" : "border text-muted-foreground",
          )}
        >
          {done ? <Check className="size-3" strokeWidth={3} /> : step}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            <span className="sr-only">
              Step {step}
              {done ? ", done" : ""}:{" "}
            </span>
            {title}
          </p>
          {description ? (
            <div className="text-xs text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {status ? <div className="shrink-0">{status}</div> : null}
      </div>
      {children ? <div className="mt-4 sm:pl-8">{children}</div> : null}
    </li>
  )
}

function OrganizationStatus({
  integration,
}: {
  integration: GitHubIntegrationRow
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(statusChipClass, "bg-background hover:bg-muted")}
        aria-label={`GitHub connected to ${integration.github_account_login}`}
      >
        <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden="true" />
        Connected
        <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm">
        <p>
          The Breezify GitHub App is installed on{" "}
          <span className="font-medium">{integration.github_account_login}</span>.
        </p>
        <p className="text-muted-foreground">
          Repository access and uninstalling are managed on GitHub. The installation
          cannot be removed from Breezify.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<a href={installationSettingsUrl(integration)} target="_blank" rel="noreferrer" />}
        >
          Manage on GitHub
          <ExternalLink aria-hidden="true" />
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function RepositoryStatus({
  canManage,
  disabled,
  onChange,
  onUnlink,
}: {
  canManage: boolean
  disabled?: boolean
  /** Omitted when the link cannot be switched in place. */
  onChange?: () => void
  onUnlink: () => void
}): React.JSX.Element {
  const className = cn(
    statusChipClass,
    "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  )
  const label = (
    <>
      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
      Connected
    </>
  )
  if (!canManage) return <span className={className}>{label}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(className, "hover:bg-emerald-500/15 disabled:opacity-50")}
        disabled={disabled}
        aria-label="Repository connected. Change the connection"
      >
        {label}
        <ChevronDown className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {onChange ? (
          <DropdownMenuItem onClick={onChange}>
            <Repeat />
            Change repository
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem variant="destructive" onClick={onUnlink}>
          <Unlink />
          Unlink repository
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LinkForm({
  initial,
  onLinked,
  onCancel,
}: {
  /** The current link, when switching to another repository. */
  initial?: GitHubHostedDocsSourceRow
  onLinked: () => Promise<unknown>
  onCancel?: () => void
}): React.JSX.Element {
  const { data, isLoading, error: reposError } = useAvailableGithubRepos()
  const repositories = data?.repositories ?? []
  const [repoId, setRepoId] = useState<number | null>(initial?.repo_id ?? null)
  const [branch, setBranch] = useState(initial?.branch ?? "")
  const [rootPath, setRootPath] = useState(initial ? sourceRoot(initial) : "")
  const [publishMode, setPublishMode] = useState<PublishMode>(
    initial?.publish_mode === "pull_request" ? "pull_request" : "direct",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const selected = repositories.find((repo) => repo.id === repoId) ?? null

  const link = async (): Promise<void> => {
    if (!repoId) return
    setSaving(true)
    setError("")
    try {
      const result = await saveGithubHostedDocsSource({
        repoId,
        rootPath: rootPath.trim(),
        mode: "merge",
        format: "readme",
        publishMode,
        branch: branch.trim() || null,
      })
      if (result.error) setError(result.error)
      else await onLinked()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />
  if (reposError || repositories.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The GitHub App cannot access any repositories yet. Grant it access to the
          docs repository on GitHub, then reload this page.
        </p>
        {onCancel ? (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="space-y-1.5">
        <Label>Repository</Label>
        <Select
          value={repoId ? String(repoId) : ""}
          onValueChange={(value) => setRepoId(Number(value))}
        >
          <SelectTrigger className="font-mono text-sm">
            <SelectValue placeholder="Choose a repository">
              {selected?.full_name ?? "Choose a repository"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {repositories.map((repo) => (
              <SelectItem key={repo.id} value={String(repo.id)} className="font-mono">
                {repo.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="github-branch">Branch</Label>
          <Input
            id="github-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="Default branch"
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="github-root">Folder</Label>
          <Input
            id="github-root"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="Repository root"
            className="font-mono text-sm"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Publishing</Label>
        <PublishModeField value={publishMode} onChange={setPublishMode} disabled={saving} />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void link()} disabled={!repoId || saving}>
          {saving ? "Linking…" : initial ? "Switch repository" : "Link repository"}
        </Button>
        {onCancel ? (
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sync details for a linked repository
// ---------------------------------------------------------------------------

function LinkedSource({
  source,
  canManage,
  refresh,
}: {
  source: GitHubHostedDocsSourceRow
  canManage: boolean
  refresh: () => Promise<unknown>
}): React.JSX.Element {
  const [pending, setPending] = useState<"sync" | "replace" | "mode" | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [error, setError] = useState("")
  const publishMode: PublishMode = source.publish_mode === "direct" ? "direct" : "pull_request"
  const root = sourceRoot(source)
  const syncing = source.sync_status === "pending" || source.sync_status === "syncing"
  const skipped = skippedFiles(source)
  const problems = skipped.filter((entry) => !entry.quiet)
  const ignored = skipped.length - problems.length
  const repositoryUrl = `https://github.com/${source.repo_full_name}`

  const save = async (
    action: "sync" | "replace" | "mode",
    overrides: { mode?: "merge" | "github_wins"; publishMode?: PublishMode } = {},
  ): Promise<void> => {
    setPending(action)
    setError("")
    try {
      const result = await saveGithubHostedDocsSource({
        repoId: source.repo_id,
        rootPath: root,
        mode: overrides.mode ?? "merge",
        format: "readme",
        publishMode: overrides.publishMode ?? publishMode,
        branch: source.branch ?? null,
      })
      if (result.error) setError(result.error)
      await refresh()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setPending(null)
      setConfirmReplace(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="max-w-3xl rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3.5" aria-hidden="true" />
              {source.branch ?? "default branch"}
            </span>
            <span className="font-mono">/{root}</span>
            <GithubBranchPicker />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
              {source.sync_status === "synced" ? (
                <CheckCircle2 className="size-3 text-emerald-600" aria-hidden="true" />
              ) : source.sync_status === "error" ? (
                <AlertTriangle className="size-3 text-destructive" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3" aria-hidden="true" />
              )}
              {syncing
                ? "Syncing"
                : source.sync_status === "error"
                  ? "Needs attention"
                  : `${source.document_count} pages in sync`}
            </span>
            {canManage ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null || syncing}
                  onClick={() => void save("sync")}
                >
                  <RefreshCw
                    className={cn(pending === "sync" && "animate-spin")}
                    aria-hidden="true"
                  />
                  {pending === "sync" ? "Starting…" : "Sync now"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  title="Replace workspace pages with the repository's version"
                  disabled={pending !== null || syncing}
                  onClick={() => setConfirmReplace(true)}
                >
                  Reset from GitHub
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {syncing ? <LoadingBar label="GitHub sync progress" /> : null}

        <div className="border-t px-4 py-3">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Last sync</dt>
              <dd>{formatWhen(source.last_sync_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Synced commit</dt>
              <dd className="font-mono">
                {source.last_sync_commit_sha ? (
                  <a
                    href={`${repositoryUrl}/commit/${source.last_sync_commit_sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {source.last_sync_commit_sha.slice(0, 7)}
                  </a>
                ) : (
                  "none yet"
                )}
              </dd>
            </div>
          </dl>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {source.last_sync_error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {source.last_sync_error}
            </p>
          ) : null}
          {source.conflict_count > 0 ? (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {source.conflict_count} page{source.conflict_count === 1 ? " was" : "s were"} changed
                in both Breezify and GitHub. Breezify kept its version. Publishing asks
                before overwriting GitHub, or use &quot;Reset from GitHub&quot; above to take the
                repository&apos;s version everywhere.
              </span>
            </p>
          ) : null}
          {source.publish_pull_request_url ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <a
                href={source.publish_pull_request_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
              >
                Open publish pull request
                {source.publish_pull_request_number ? ` #${source.publish_pull_request_number}` : ""}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
              {canManage ? (
                <MergePublishPullRequestButton
                  pullRequestNumber={source.publish_pull_request_number}
                  disabled={pending !== null || syncing}
                  onMerged={refresh}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {problems.length > 0 ? (
        <div className="max-w-3xl space-y-2">
          <h3 className="text-sm font-medium">Files that could not be synced</h3>
          <ul className="divide-y rounded-lg border text-sm">
            {problems.slice(0, 25).map((entry) => (
              <li key={entry.path} className="px-3 py-2">
                <span className="font-mono text-xs">{entry.path}</span>
                <span className="block text-xs text-muted-foreground">{entry.reason}</span>
              </li>
            ))}
          </ul>
          {problems.length > 25 ? (
            <p className="text-xs text-muted-foreground">
              and {problems.length - 25} more.
            </p>
          ) : null}
        </div>
      ) : null}
      {ignored > 0 ? (
        <p className="text-xs text-muted-foreground">
          {ignored} file{ignored === 1 ? "" : "s"} left unchanged in the repository
          (generated API reference and ReadMe settings pages).
        </p>
      ) : null}

      {canManage ? (
        <>
          <div className="max-w-xl space-y-1.5">
            <Label>Publishing</Label>
            <PublishModeField
              value={publishMode}
              disabled={pending !== null || syncing}
              onChange={(value) => {
                if (value !== publishMode) void save("mode", { publishMode: value })
              }}
            />
          </div>

          <GithubDocsAutomationSettings publishMode={publishMode} disabled={pending !== null} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only workspace owners and admins can change this link.
        </p>
      )}

      <AlertDialog
        open={confirmReplace}
        onOpenChange={(open) => {
          if (!open && pending === null) setConfirmReplace(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the workspace from GitHub?</AlertDialogTitle>
            <AlertDialogDescription>
              Every linked page takes the repository&apos;s content, title, order and
              folder. Edits made in Breezify that were not published are replaced; the
              previous versions stay in each page&apos;s history. Pages that are not in the
              repository move to the trash, and folders left empty are removed. API
              reference pages and role-restricted folders are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null}
              onClick={(event) => {
                event.preventDefault()
                void save("replace", { mode: "github_wins" })
              }}
            >
              Reset from GitHub
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function GithubIntegrationContent(): React.JSX.Element {
  const searchParams = useSearchParams()
  const callbackError = searchParams.get("error")
  const { data: workspace } = useWorkspace()
  const integration = useGithubIntegration()
  const installation = integration.data?.integration ?? null
  const connected = Boolean(installation)
  const hostedDocs = useGithubHostedDocs({ enabled: connected })
  const source = hostedDocs.data?.source ?? null
  const readmeSource = source?.format === "readme" ? source : null
  const canManage = workspace?.user_role === "owner" || workspace?.user_role === "admin"
  const loading = integration.isLoading || (connected && hostedDocs.isLoading)

  const [changingRepo, setChangingRepo] = useState(false)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [unlinkError, setUnlinkError] = useState("")

  const unlink = async (): Promise<void> => {
    setUnlinking(true)
    setUnlinkError("")
    try {
      const result = await disableGithubHostedDocsSource()
      if (result.error) setUnlinkError(result.error)
      else setChangingRepo(false)
      await hostedDocs.mutate()
    } catch {
      setUnlinkError("Could not reach the server. Try again shortly.")
    } finally {
      setUnlinking(false)
      setConfirmUnlink(false)
    }
  }

  const accountTitle =
    installation?.github_account_type === "User" ? "GitHub account" : "GitHub organization"

  let repositoryDescription: React.ReactNode
  if (!connected) {
    repositoryDescription = "Available once GitHub is connected."
  } else if (source) {
    repositoryDescription = (
      <>
        <a
          href={`https://github.com/${source.repo_full_name}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-foreground hover:underline"
        >
          {source.repo_full_name}
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
        {readmeSource ? null : (
          <span className="mt-1 block">
            Linked in the Breezify document format. Unlink it to link a repository in
            the ReadMe layout instead.
          </span>
        )}
      </>
    )
  } else {
    repositoryDescription = canManage
      ? "Choose the repository that holds your docs."
      : "Ask a workspace owner or admin to link a repository."
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-base font-semibold">GitHub</h2>
      </header>

      {callbackError ? (
        <p role="alert" className="text-sm text-destructive">
          {CALLBACK_ERRORS[callbackError] ?? "GitHub could not be connected. Try again."}
        </p>
      ) : null}

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <section className="max-w-3xl space-y-2">
            <ol className="divide-y rounded-lg border">
              <ConnectionStep
                step={1}
                done={connected}
                title={accountTitle}
                description={
                  installation ? (
                    <>
                      Breezify GitHub App installed on{" "}
                      <span className="font-medium text-foreground">
                        {installation.github_account_login}
                      </span>
                    </>
                  ) : canManage ? (
                    "Install the Breezify GitHub App on the organization that owns your docs repository."
                  ) : (
                    "Ask a workspace owner or admin to connect GitHub."
                  )
                }
                status={
                  installation ? (
                    <OrganizationStatus integration={installation} />
                  ) : canManage ? (
                    <Button size="sm" onClick={() => initiateGithubInstall()}>
                      Connect GitHub
                    </Button>
                  ) : null
                }
              />
              <ConnectionStep
                step={2}
                done={Boolean(source)}
                inactive={!connected}
                title="Docs repository"
                description={repositoryDescription}
                status={
                  source ? (
                    <RepositoryStatus
                      canManage={canManage}
                      disabled={unlinking}
                      onChange={readmeSource ? () => setChangingRepo(true) : undefined}
                      onUnlink={() => setConfirmUnlink(true)}
                    />
                  ) : null
                }
              >
                {connected && canManage && (!source || (readmeSource && changingRepo)) ? (
                  <LinkForm
                    key={changingRepo ? "change" : "link"}
                    initial={changingRepo ? (readmeSource ?? undefined) : undefined}
                    onCancel={changingRepo ? () => setChangingRepo(false) : undefined}
                    onLinked={async () => {
                      await hostedDocs.mutate()
                      setChangingRepo(false)
                    }}
                  />
                ) : null}
              </ConnectionStep>
            </ol>
            {unlinkError ? (
              <p role="alert" className="text-sm text-destructive">
                {unlinkError}
              </p>
            ) : null}
          </section>

          {readmeSource ? (
            <LinkedSource
              source={readmeSource}
              canManage={canManage}
              refresh={() => hostedDocs.mutate()}
            />
          ) : null}
        </>
      )}

      {/* Works without a linked repository too (manual upload or CI). */}
      <OpenApiSpecs className="border-t pt-8" />

      <AlertDialog
        open={confirmUnlink}
        onOpenChange={(open) => {
          if (!open && !unlinking) setConfirmUnlink(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this repository?</AlertDialogTitle>
            <AlertDialogDescription>
              Syncing stops. Pages already in the workspace and files already in the
              repository stay as they are. The GitHub App stays installed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlinking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={unlinking}
              onClick={(event) => {
                event.preventDefault()
                void unlink()
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function GithubIntegrationPage(): React.JSX.Element {
  // useSearchParams needs a Suspense boundary to render during prerendering.
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
      <GithubIntegrationContent />
    </Suspense>
  )
}

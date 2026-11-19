"use client"

import React, { useState } from "react"
import { GitMerge } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
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
import { useWorkspace } from "@/hooks/swr"
import {
  mergeGithubPublishPullRequest,
  saveDocsAutomationSettings,
} from "@/lib/github/api/docs-automation"
import {
  AUTO_PUBLISH_IDLE_SECONDS,
  getDocsChecksSettings,
  getGithubPublishingSettings,
  type DocsCheckMode,
  type DocsChecksSettings,
  type GithubPublishingSettings,
  type PullRequestMergeMethod,
} from "@/lib/github/docs-automation-settings"

// ---------------------------------------------------------------------------
// Settings -> Integrations -> GitHub: how publishing behaves beyond the
// direct-commit / pull-request choice, and which checks run on pull requests.
// Every option is off until a workspace admin turns it on.
// ---------------------------------------------------------------------------

const MERGE_METHODS: Array<{ value: PullRequestMergeMethod; label: string }> = [
  { value: "merge", label: "Merge commit" },
  { value: "squash", label: "Squash" },
  { value: "rebase", label: "Rebase" },
]

const CHECK_MODES: Array<{ value: DocsCheckMode; label: string }> = [
  { value: "disabled", label: "Disabled" },
  { value: "warning", label: "Warning" },
  { value: "blocking", label: "Blocking" },
]

const CHECKS: Array<{ key: keyof DocsChecksSettings; title: string; description: string }> = [
  {
    key: "brokenLinks",
    title: "Broken links",
    description:
      "Check every commit and pull request in the linked repository for links to docs pages or files that do not exist. Warning reports them; Blocking fails the check. External URLs are not fetched.",
  },
  {
    key: "formatting",
    title: "Formatting",
    description:
      "Check every commit and pull request for pages Breezify cannot read: frontmatter that is not valid YAML, code blocks and components that are never closed, merge conflict markers, _order.yaml entries for pages that do not exist, and OpenAPI files that do not parse. Writing style is not checked.",
  },
]

function SettingRow({
  title,
  description,
  note,
  children,
}: {
  title: string
  description: string
  /** Why the option has no effect right now. */
  note?: string | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">{description}</p>
        {note ? <p className="text-xs leading-5 text-amber-700 dark:text-amber-400">{note}</p> : null}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

export function GithubDocsAutomationSettings({
  publishMode,
  disabled,
}: {
  publishMode: "direct" | "pull_request"
  disabled?: boolean
}): React.JSX.Element {
  const { data: workspace, mutate } = useWorkspace()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const publishing = getGithubPublishingSettings(workspace?.settings)
  const checks = getDocsChecksSettings(workspace?.settings)
  const locked = disabled || saving || !workspace

  const save = async (next: {
    publishing?: GithubPublishingSettings
    checks?: DocsChecksSettings
  }): Promise<void> => {
    setSaving(true)
    setError("")
    try {
      const result = await saveDocsAutomationSettings(next)
      if (result.error) setError(result.error)
      await mutate()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setSaving(false)
    }
  }
  const setPublishing = (patch: Partial<GithubPublishingSettings>): void => {
    void save({ publishing: { ...publishing, ...patch } })
  }

  return (
    <div className="space-y-6">
      <section className="max-w-3xl space-y-2">
        <h3 className="text-sm font-medium">Publishing options</h3>
        <div className="divide-y rounded-lg border">
          <SettingRow
            title="Pull request merge method"
            description="How Breezify merges its publish pull request when you choose Merge pull request."
            note={
              publishMode === "direct"
                ? "Only used when publishing opens a pull request."
                : null
            }
          >
            <Select
              value={publishing.mergeMethod}
              disabled={locked}
              onValueChange={(value) => setPublishing({ mergeMethod: value as PullRequestMergeMethod })}
            >
              <SelectTrigger className="w-40" aria-label="Pull request merge method">
                <SelectValue>
                  {MERGE_METHODS.find((method) => method.value === publishing.mergeMethod)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MERGE_METHODS.map((method) => (
                  <SelectItem key={method.value} value={method.value}>
                    {method.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            title="Auto publish"
            description={`Commit workspace edits to the synced branch about ${AUTO_PUBLISH_IDLE_SECONDS} seconds after editing stops, while someone has the workspace open. Changes go live with no review. Pages changed on both sides are never published this way.`}
            note={
              publishMode === "pull_request"
                ? "Only applies when publishing commits directly to the branch."
                : null
            }
          >
            <Switch
              aria-label="Auto publish"
              checked={publishing.autoPublish}
              disabled={locked}
              onCheckedChange={(checked) => setPublishing({ autoPublish: checked })}
            />
          </SettingRow>
          <SettingRow
            title="Create draft pull requests"
            description="Open publish pull requests as drafts. Merging from Breezify marks the pull request ready first."
            note={
              publishMode === "direct"
                ? "Only used when publishing opens a pull request."
                : null
            }
          >
            <Switch
              aria-label="Create draft pull requests"
              checked={publishing.draftPullRequests}
              disabled={locked}
              onCheckedChange={(checked) => setPublishing({ draftPullRequests: checked })}
            />
          </SettingRow>
          <SettingRow
            title="Add co-authors to commits"
            description="Credit everyone who edited the published pages as a co-author. Their name and email become visible to anyone who can see the repository."
          >
            <Switch
              aria-label="Add co-authors to commits"
              checked={publishing.coAuthors}
              disabled={locked}
              onCheckedChange={(checked) => setPublishing({ coAuthors: checked })}
            />
          </SettingRow>
        </div>
      </section>

      <section className="max-w-3xl space-y-2">
        <h3 className="text-sm font-medium">Pull request checks</h3>
        <div className="divide-y rounded-lg border">
          {CHECKS.map((check) => (
            <SettingRow key={check.key} title={check.title} description={check.description}>
              <Select
                value={checks[check.key]}
                disabled={locked}
                onValueChange={(value) =>
                  void save({ checks: { ...checks, [check.key]: value as DocsCheckMode } })
                }
              >
                <SelectTrigger className="w-40" aria-label={`${check.title} check`}>
                  <SelectValue>
                    {CHECK_MODES.find((mode) => mode.value === checks[check.key])?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CHECK_MODES.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          ))}
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Merges the open publish pull request, after a confirmation. */
export function MergePublishPullRequestButton({
  pullRequestNumber,
  disabled,
  onMerged,
}: {
  pullRequestNumber: number | null
  disabled?: boolean
  onMerged: () => Promise<unknown>
}): React.JSX.Element {
  const { data: workspace } = useWorkspace()
  const [open, setOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState("")
  const method = getGithubPublishingSettings(workspace?.settings).mergeMethod
  const methodLabel = MERGE_METHODS.find((entry) => entry.value === method)?.label ?? "Merge commit"

  const merge = async (): Promise<void> => {
    setMerging(true)
    setError("")
    try {
      const result = await mergeGithubPublishPullRequest()
      if (result.error) {
        setError(result.error)
      } else {
        setOpen(false)
      }
      await onMerged()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setMerging(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || merging}
        onClick={() => {
          setError("")
          setOpen(true)
        }}
      >
        <GitMerge className="size-3.5" aria-hidden="true" />
        Merge pull request
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!merging) setOpen(next)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge pull request{pullRequestNumber ? ` #${pullRequestNumber}` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This merges the Breezify publish pull request into the synced branch
              using &quot;{methodLabel}&quot;, which makes its changes live. A draft
              is marked ready first. GitHub still enforces the branch&apos;s
              required checks and reviews.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={merging}
              onClick={(event) => {
                event.preventDefault()
                void merge()
              }}
            >
              {merging ? "Merging…" : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

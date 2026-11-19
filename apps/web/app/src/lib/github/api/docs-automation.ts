import {
  storedDocsChecks,
  storedGithubPublishing,
  type DocsChecksSettings,
  type GithubPublishingSettings,
} from "@/lib/github/docs-automation-settings"

/**
 * Save the GitHub publishing options and/or docs checks. Each is one key in
 * the workspace settings, replaced whole, so the two never overwrite each other.
 */
export async function saveDocsAutomationSettings(input: {
  publishing?: GithubPublishingSettings
  checks?: DocsChecksSettings
}): Promise<{ error?: string }> {
  const settings: Record<string, unknown> = {}
  if (input.publishing) settings.github_publishing = storedGithubPublishing(input.publishing)
  if (input.checks) settings.docs_checks = storedDocsChecks(input.checks)
  const res = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { error: body.error ?? "Could not save the setting." }
  }
  return {}
}

/** Merge the open Breezify publish pull request with the workspace's merge method. */
export async function mergeGithubPublishPullRequest(): Promise<{ error?: string }> {
  const res = await fetch("/api/github/hosted-docs/publish/merge", { method: "POST" })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { error: body.error ?? "Could not merge the pull request." }
  }
  return {}
}

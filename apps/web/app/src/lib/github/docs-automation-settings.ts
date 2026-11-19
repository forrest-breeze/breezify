// ---------------------------------------------------------------------------
// Workspace settings for the GitHub docs workflow: how workspace edits are
// published, and which checks run on pull requests against the linked
// repository. Stored in `workspaces.settings` under `github_publishing` and
// `docs_checks`. Everything is off by default: each option changes what is
// written to a repository or shown on a pull request, so it is opt-in.
// ---------------------------------------------------------------------------

export const PULL_REQUEST_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
export type PullRequestMergeMethod = (typeof PULL_REQUEST_MERGE_METHODS)[number]

export const DOCS_CHECK_MODES = ['disabled', 'warning', 'blocking'] as const
/**
 * `warning` reports problems without failing the check; `blocking` fails it,
 * which stops the merge when the repository requires the check.
 */
export type DocsCheckMode = (typeof DOCS_CHECK_MODES)[number]

export interface GithubPublishingSettings {
  /** How Breezify merges its publish pull request. */
  mergeMethod: PullRequestMergeMethod
  /** Commit edits to the synced branch shortly after editing stops. */
  autoPublish: boolean
  /** Open publish pull requests as drafts. */
  draftPullRequests: boolean
  /** List everyone who edited the published pages as a commit co-author. */
  coAuthors: boolean
}

export interface DocsChecksSettings {
  /** The "Docs links" check: links to pages or files that do not exist. */
  brokenLinks: DocsCheckMode
  /** The "Docs format" check: malformed pages, order files and definitions. */
  formatting: DocsCheckMode
}

export const DEFAULT_GITHUB_PUBLISHING: GithubPublishingSettings = {
  mergeMethod: 'merge',
  autoPublish: false,
  draftPullRequests: false,
  coAuthors: false,
}

export const DEFAULT_DOCS_CHECKS: DocsChecksSettings = {
  brokenLinks: 'disabled',
  formatting: 'disabled',
}

/** Seconds without an edit before an automatic publish may run. */
export const AUTO_PUBLISH_IDLE_SECONDS = 45

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function getGithubPublishingSettings(settings: unknown): GithubPublishingSettings {
  const stored = record(record(settings).github_publishing)
  return {
    mergeMethod: oneOf(
      stored.merge_method,
      PULL_REQUEST_MERGE_METHODS,
      DEFAULT_GITHUB_PUBLISHING.mergeMethod,
    ),
    autoPublish: stored.auto_publish === true,
    draftPullRequests: stored.draft_pull_requests === true,
    coAuthors: stored.co_authors === true,
  }
}

export function getDocsChecksSettings(settings: unknown): DocsChecksSettings {
  const stored = record(record(settings).docs_checks)
  return {
    brokenLinks: oneOf(stored.broken_links, DOCS_CHECK_MODES, DEFAULT_DOCS_CHECKS.brokenLinks),
    formatting: oneOf(stored.formatting, DOCS_CHECK_MODES, DEFAULT_DOCS_CHECKS.formatting),
  }
}

/** The stored shape of `settings.github_publishing`. */
export function storedGithubPublishing(value: GithubPublishingSettings): Record<string, unknown> {
  return {
    merge_method: value.mergeMethod,
    auto_publish: value.autoPublish,
    draft_pull_requests: value.draftPullRequests,
    co_authors: value.coAuthors,
  }
}

/** The stored shape of `settings.docs_checks`. */
export function storedDocsChecks(value: DocsChecksSettings): Record<string, unknown> {
  return { broken_links: value.brokenLinks, formatting: value.formatting }
}

/**
 * Canonicalize both keys in a settings object in place: unknown values fall
 * back to their defaults, and a key that was never set stays absent.
 */
export function normalizeDocsAutomationSettings(settings: Record<string, unknown>): void {
  if (settings.github_publishing !== undefined) {
    settings.github_publishing = storedGithubPublishing(getGithubPublishingSettings(settings))
  }
  if (settings.docs_checks !== undefined) {
    settings.docs_checks = storedDocsChecks(getDocsChecksSettings(settings))
  }
}

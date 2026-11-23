import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { createAdminClient } from '@/lib/supabase/admin'
import { portalDocumentToMarkdown } from '@/lib/portal/portal-doc-markdown'
import { listDocumentCoAuthors, loadDocsAutomationSettings } from '../docs-automation.server'
import type { PullRequestMergeMethod } from '../docs-automation-settings'
import {
  compareRepositoryRefs,
  getInstallationToken,
  getPullRequest,
  markPullRequestReadyForReview,
  mergeRepositoryPullRequest,
  type GitHubPR,
} from '../github'
import { GitHubApiError, withGitHubRetry } from '../retry'
import { reconcileReadmeFolderVisibility } from './readme-folder-visibility'
import { readmeRootFromPaths } from './readme-layout'
import {
  commitReadmeSpecFile,
  diffReadmePublish,
  inspectReadmePublish,
  isReadmePublishBranch,
  README_PUBLISH_BRANCH_PREFIX,
  publishReadmeWorkspace,
  ReadmePublishError,
  type ReadmePublishDeps,
  type ReadmePublishSource,
} from './readme-publish'
import { buildReadmeBranchReview, type ReadmeBranchReview } from './readme-review'
import { createSupabaseReadmeStore } from './readme-store-supabase'
import {
  ReadmeSyncError,
  syncReadmeRepository,
  type ReadmeSyncMode,
  type ReadmeSyncResult,
} from './readme-sync'

/**
 * Server wiring for the ReadMe-format GitHub sync: binds the pure sync and
 * publish logic to the workspace database and the GitHub App installation.
 */

const STALE_SYNC_MS = 5 * 60 * 1000

export function isReadmeFormatSource(
  source: Pick<GitHubHostedDocsSourceRow, 'format'> | null | undefined,
): boolean {
  return source?.format === 'readme'
}

function publishSource(source: GitHubHostedDocsSourceRow): ReadmePublishSource {
  return {
    installationId: source.installation_id,
    repoId: source.repo_id,
    repoFullName: source.repo_full_name,
    root: readmeRootFromPaths(source.paths),
    branch: source.branch ?? null,
    lastSyncCommitSha: source.last_sync_commit_sha,
    syncState: source.sync_state ?? null,
    publishMode: source.publish_mode === 'direct' ? 'direct' : 'pull_request',
    publishPullRequestNumber: source.publish_pull_request_number,
    publishPullRequestHead: source.publish_pull_request_head,
  }
}

function publishDeps(admin: SupabaseClient, source: GitHubHostedDocsSourceRow): ReadmePublishDeps {
  return {
    store: createSupabaseReadmeStore(admin, {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      repoId: source.repo_id,
    }),
    toMarkdown: portalDocumentToMarkdown,
  }
}

function safeSyncError(error: unknown): string {
  if (error instanceof ReadmeSyncError) return error.message
  const status = (error as { status?: number }).status
  if (status === 403 || status === 404) {
    return 'GitHub can no longer read the linked repository or branch.'
  }
  return 'GitHub sync failed. Retry from GitHub settings.'
}

export interface ReadmeSourceSyncOptions {
  /** Exact commit or branch to read; defaults to the configured branch. */
  ref?: string
  force?: boolean
  mode?: ReadmeSyncMode
}

/**
 * Pull the repository into the workspace. Returns null when another sync of
 * the same source is already running.
 */
export async function syncReadmeSource(
  source: GitHubHostedDocsSourceRow,
  options: ReadmeSourceSyncOptions = {},
  admin: SupabaseClient = createAdminClient(),
): Promise<ReadmeSyncResult | null> {
  // Claim the source so a webhook and a status poll cannot reconcile the same
  // workspace at once: first if nothing is syncing, otherwise only by taking
  // over a sync whose heartbeat went stale.
  const claim = () =>
    admin
      .from('github_hosted_docs_sources')
      .update({ sync_status: 'syncing', last_sync_error: null })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
  const idle = await claim().neq('sync_status', 'syncing').select('*').maybeSingle()
  if (idle.error) throw new Error(`readme sync claim: ${idle.error.message}`)
  let claimed = idle.data as GitHubHostedDocsSourceRow | null
  if (!claimed) {
    const staleBefore = new Date(Date.now() - STALE_SYNC_MS).toISOString()
    const stale = await claim()
      .eq('sync_status', 'syncing')
      .lt('updated_at', staleBefore)
      .select('*')
      .maybeSingle()
    if (stale.error) throw new Error(`readme sync claim: ${stale.error.message}`)
    claimed = stale.data as GitHubHostedDocsSourceRow | null
  }
  if (!claimed) return null
  const current = claimed

  const deps = publishDeps(admin, current)
  try {
    const result = await syncReadmeRepository(
      {
        installationId: current.installation_id,
        repoId: current.repo_id,
        repoFullName: current.repo_full_name,
        root: readmeRootFromPaths(current.paths),
        branch: current.branch ?? null,
        ref: options.ref,
        lastSyncCommitSha: current.last_sync_commit_sha,
        syncState: current.sync_state ?? null,
        mode: options.mode ?? current.pending_sync_mode ?? 'merge',
        force: options.force,
      },
      deps,
    )
    // The sync has just recorded the repository's order files; folders the
    // repository stopped or started listing take the matching visibility.
    await reconcileReadmeFolderVisibility(admin, {
      workspaceId: current.workspace_id,
      sourceId: current.id,
      repoId: current.repo_id,
    })
    await reconcileReadmePublishPullRequest(current, admin)
    return result
  } catch (error) {
    await deps.store
      .updateSource({
        sync_status: 'error',
        last_sync_at: new Date().toISOString(),
        last_sync_error: safeSyncError(error),
      })
      .catch((statusError: unknown) => {
        console.error('[Breezify] readme sync status update failed:', statusError)
      })
    throw error
  }
}

/**
 * Forget the publish pull request once it has been merged or closed.
 *
 * A working branch someone named is where the workspace is until it merges.
 * Closing its pull request without merging, or deleting the branch, discards
 * it: the workspace goes back to the synced branch, with the next sync
 * replacing what Breezify holds (a document's replaced content stays in its
 * version history). Until that sync has run the link is `pending`, which also
 * keeps the discarded changes from being published to the synced branch.
 *
 * A pull request Breezify opened itself (pull request mode) is different: its
 * changes are the workspace's own, so closing it leaves them to publish again.
 */
export async function reconcileReadmePublishPullRequest(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<GitHubHostedDocsSourceRow> {
  const head = source.publish_pull_request_head
  if (!source.publish_pull_request_number || !isReadmePublishBranch(head)) {
    return source
  }
  try {
    const token = await withGitHubRetry(() => getInstallationToken(source.installation_id))
    const pullRequest = await withGitHubRetry(() =>
      getPullRequest(token, source.repo_full_name, source.publish_pull_request_number!),
    )
    if (pullRequest.state === 'open') return source
    const merged = pullRequest.merged === true || Boolean(pullRequest.merged_at)
    const discarded = !merged && !head!.startsWith(README_PUBLISH_BRANCH_PREFIX)
    // The reset is recorded together with letting go of the branch, and only
    // while no sync is running: a running sync would mark the link synced
    // again and the reset would be lost. The next poll tries again.
    if (discarded && source.sync_status !== 'synced') return source
    let update = admin
      .from('github_hosted_docs_sources')
      .update({
        publish_pull_request_number: null,
        publish_pull_request_url: null,
        publish_pull_request_head: null,
        publish_last_commit_sha: null,
        ...(discarded
          ? { sync_status: 'pending', pending_sync_mode: 'replace_breezify', last_sync_error: null }
          : {}),
      })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
      .eq('publish_pull_request_number', pullRequest.number)
    if (discarded) update = update.eq('sync_status', 'synced')
    const { data, error } = await update.select('*').maybeSingle()
    if (error) throw error
    return (data as GitHubHostedDocsSourceRow | null) ?? source
  } catch (error) {
    // Keep the pointer through a transient GitHub failure; the next poll or
    // sync reconciles it again.
    console.error('[Breezify] readme publish PR reconciliation failed:', error)
    return source
  }
}

/**
 * Whether the link is waiting for the reset that follows a discarded working
 * branch (see reconcileReadmePublishPullRequest). Whoever sees it starts the
 * sync; the claim in syncReadmeSource lets only one of them run it.
 */
export function awaitsReadmeWorkspaceReset(source: GitHubHostedDocsSourceRow): boolean {
  return (
    isReadmeFormatSource(source) &&
    source.sync_status === 'pending' &&
    source.pending_sync_mode === 'replace_breezify' &&
    source.pending_pull_request_number === null
  )
}

export function inspectReadmeSourcePublish(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
) {
  return inspectReadmePublish(publishSource(source), publishDeps(admin, source))
}

export function diffReadmeSourcePublish(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
) {
  return diffReadmePublish(publishSource(source), publishDeps(admin, source))
}

export async function publishReadmeSource(
  source: GitHubHostedDocsSourceRow,
  options: {
    includeConflicts?: boolean
    selectedPaths?: string[]
    message?: string
    /** Save to a new working branch with this name. */
    branch?: string
  },
  admin: SupabaseClient = createAdminClient(),
) {
  const { publishing } = await loadDocsAutomationSettings(admin, source.workspace_id)
  return publishReadmeWorkspace(
    { ...publishSource(source), draftPullRequests: publishing.draftPullRequests },
    publishDeps(admin, source),
    {
      ...options,
      ...(publishing.coAuthors
        ? {
            coAuthors: (documentIds: string[]) =>
              listDocumentCoAuthors(admin, {
                workspaceId: source.workspace_id,
                documentIds,
                fallbackSince: source.last_sync_at ?? null,
              }),
          }
        : {}),
    },
  )
}

/**
 * The open pull request of the working branch, or null when there is none:
 * nothing was saved to a branch, or its pull request was merged or closed (in
 * which case the link forgets it).
 */
async function openWorkingBranchPullRequest(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient,
): Promise<{ token: string; branch: string; pullRequest: GitHubPR } | null> {
  const number = source.publish_pull_request_number
  const branch = source.publish_pull_request_head
  if (!number || !branch || !isReadmePublishBranch(branch)) return null
  const token = await withGitHubRetry(() => getInstallationToken(source.installation_id))
  const pullRequest = await withGitHubRetry(() =>
    getPullRequest(token, source.repo_full_name, number),
  )
  if (pullRequest.state !== 'open') {
    await reconcileReadmePublishPullRequest(source, admin)
    return null
  }
  if (pullRequest.head?.ref !== branch) return null
  return { token, branch, pullRequest }
}

/** What the working branch changes on the synced branch, for the Review page. */
export async function loadReadmeSourceReview(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<ReadmeBranchReview | null> {
  const open = await openWorkingBranchPullRequest(source, admin)
  if (!open) return null
  const base = open.pullRequest.base?.ref ?? source.branch
  if (!base) return null
  const comparison = await withGitHubRetry(() =>
    compareRepositoryRefs(open.token, source.repo_full_name, base, open.branch),
  )
  return buildReadmeBranchReview({
    branch: open.branch,
    base,
    repoFullName: source.repo_full_name,
    pullRequest: open.pullRequest,
    comparison,
  })
}

/**
 * Ask for a review of the working branch: take its pull request out of draft,
 * which is what tells its reviewers on GitHub it is ready.
 */
export async function requestReadmeSourceReview(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<{ pullRequestNumber: number; draft: boolean }> {
  const open = await openWorkingBranchPullRequest(source, admin)
  if (!open) {
    throw new ReadmePublishError('There is no open working branch to review.', 409, 'no_pull_request')
  }
  if (open.pullRequest.draft && open.pullRequest.node_id) {
    await markPullRequestReadyForReview(open.token, open.pullRequest.node_id)
  }
  return { pullRequestNumber: open.pullRequest.number, draft: false }
}

export interface ReadmePullRequestMergeResult {
  merged: boolean
  pullRequestNumber: number
  mergeCommitSha: string | null
  method: PullRequestMergeMethod
}

/**
 * Merge the open publish pull request with the workspace's merge method. A
 * draft is marked ready first, because GitHub refuses to merge a draft. The
 * merge lands on the synced branch; the next sync links the new pages.
 */
export async function mergeReadmeSourcePullRequest(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<ReadmePullRequestMergeResult> {
  const number = source.publish_pull_request_number
  if (!number || !isReadmePublishBranch(source.publish_pull_request_head)) {
    throw new ReadmePublishError(
      'There is no open publish pull request to merge.',
      409,
      'no_pull_request',
    )
  }
  const { publishing } = await loadDocsAutomationSettings(admin, source.workspace_id)
  const token = await withGitHubRetry(() => getInstallationToken(source.installation_id))
  const pullRequest = await withGitHubRetry(() =>
    getPullRequest(token, source.repo_full_name, number),
  )
  if (pullRequest.state !== 'open') {
    await reconcileReadmePublishPullRequest(source, admin)
    throw new ReadmePublishError(
      pullRequest.merged
        ? 'The publish pull request was already merged.'
        : 'The publish pull request was closed without merging.',
      409,
      'pull_request_not_open',
    )
  }
  if (pullRequest.head?.ref !== source.publish_pull_request_head) {
    throw new ReadmePublishError(
      'The publish pull request no longer points at the Breezify branch.',
      409,
      'pull_request_changed',
    )
  }
  try {
    if (pullRequest.draft && pullRequest.node_id) {
      await markPullRequestReadyForReview(token, pullRequest.node_id)
    }
    const merged = await mergeRepositoryPullRequest(token, source.repo_full_name, number, {
      method: publishing.mergeMethod,
      sha: pullRequest.head?.sha,
    })
    await reconcileReadmePublishPullRequest(source, admin)
    return {
      merged: merged.merged,
      pullRequestNumber: number,
      mergeCommitSha: merged.sha ?? null,
      method: publishing.mergeMethod,
    }
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error
    // 405: not mergeable (required checks or reviews, conflicts, or the method
    // is not allowed in this repository). 409: the head moved. 403: the App
    // may not merge here. GitHub's own wording says which, so pass it on.
    if (![403, 405, 409, 422].includes(error.status)) throw error
    const detail = /"message"\s*:\s*"([^"]+)"/.exec(error.message)?.[1]
    throw new ReadmePublishError(
      detail
        ? `GitHub did not merge the pull request: ${detail}`
        : 'GitHub did not merge the pull request. Check its required checks and reviews.',
      409,
      'merge_refused',
    )
  }
}

async function linkedReadmeSource(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<GitHubHostedDocsSourceRow | null> {
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`readme source lookup: ${error.message}`)
  const source = data as GitHubHostedDocsSourceRow | null
  if (!source || !isReadmeFormatSource(source) || source.sync_status === 'disabled') return null
  return source
}

export interface OpenApiRepositoryOutcome {
  /** True when a commit was made on the synced branch. */
  committed: boolean
  path: string | null
  commit_sha: string | null
  /** Why the definition was not committed, when it was not. */
  reason?: 'pull_request_mode' | 'unchanged' | 'failed'
  message?: string
}

/**
 * After an OpenAPI definition was uploaded (CI or Settings), write it to
 * `reference/` in the linked ReadMe-format repository. This is what keeps the
 * existing upload integration and the GitHub sync on one source of truth.
 *
 * Never throws: the upload already succeeded, so a GitHub failure is reported
 * in the result instead of failing the request.
 */
export async function writeOpenApiSourceToLinkedRepository(
  admin: SupabaseClient,
  workspaceId: string,
  slug: string,
): Promise<OpenApiRepositoryOutcome | null> {
  try {
    const source = await linkedReadmeSource(admin, workspaceId)
    if (!source) return null
    if (source.publish_mode !== 'direct') {
      return { committed: false, path: null, commit_sha: null, reason: 'pull_request_mode' }
    }
    const { data, error } = await admin
      .from('openapi_sources')
      .select('spec_raw, repo_path')
      .eq('workspace_id', workspaceId)
      .eq('slug', slug)
      .maybeSingle()
    if (error) throw new Error(`OpenAPI source lookup: ${error.message}`)
    const row = data as { spec_raw: string | null; repo_path: string | null } | null
    if (!row?.spec_raw) return null
    const outcome = await commitReadmeSpecFile(publishSource(source), publishDeps(admin, source), {
      slug,
      raw: row.spec_raw,
      repoPath: row.repo_path,
    })
    return {
      committed: outcome.committed,
      path: outcome.path,
      commit_sha: outcome.commitSha,
      ...(outcome.committed ? {} : { reason: 'unchanged' as const }),
    }
  } catch (error) {
    console.error('[Breezify] OpenAPI definition push to GitHub failed:', error)
    return {
      committed: false,
      path: null,
      commit_sha: null,
      reason: 'failed',
      message:
        error instanceof ReadmePublishError
          ? error.message
          : 'The definition was published, but could not be written to the linked GitHub repository.',
    }
  }
}

/** Look up where a definition lives in the repository before it is deleted. */
export async function openApiSourceRepositoryPath(
  admin: SupabaseClient,
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('openapi_sources')
      .select('repo_path')
      .eq('workspace_id', workspaceId)
      .eq('slug', slug)
      .maybeSingle()
    if (error) return null
    return (data as { repo_path: string | null } | null)?.repo_path ?? null
  } catch {
    // Best effort: removing the source must not fail on this lookup.
    return null
  }
}

/** After an OpenAPI source was removed, delete its file from the repository. */
export async function removeOpenApiSourceFromLinkedRepository(
  admin: SupabaseClient,
  workspaceId: string,
  input: { slug: string; repoPath: string | null },
): Promise<OpenApiRepositoryOutcome | null> {
  if (!input.repoPath) return null
  try {
    const source = await linkedReadmeSource(admin, workspaceId)
    if (!source) return null
    if (source.publish_mode !== 'direct') {
      return { committed: false, path: input.repoPath, commit_sha: null, reason: 'pull_request_mode' }
    }
    const outcome = await commitReadmeSpecFile(publishSource(source), publishDeps(admin, source), {
      slug: input.slug,
      raw: null,
      repoPath: input.repoPath,
    })
    return {
      committed: outcome.committed,
      path: outcome.path,
      commit_sha: outcome.commitSha,
      ...(outcome.committed ? {} : { reason: 'unchanged' as const }),
    }
  } catch (error) {
    console.error('[Breezify] OpenAPI definition removal from GitHub failed:', error)
    return {
      committed: false,
      path: input.repoPath,
      commit_sha: null,
      reason: 'failed',
      message:
        error instanceof ReadmePublishError
          ? error.message
          : 'The definition was removed, but its file could not be deleted from the linked GitHub repository.',
    }
  }
}

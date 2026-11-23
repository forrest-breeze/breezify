import { NextResponse } from 'next/server'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ReadmePublishError } from '@/lib/github/readme/readme-publish'
import {
  isReadmeFormatSource,
  loadReadmeSourceReview,
  requestReadmeSourceReview,
} from '@/lib/github/readme/readme-service'
import { GitHubApiError } from '@/lib/github/retry'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// /api/github/hosted-docs/review
//
// The review of the working branch: the branch workspace changes were saved to
// instead of the synced branch.
//
// GET   What the branch changes on the synced branch (files with their diffs),
//       its commits and contributors, and whether its pull request is a draft.
//       `{ open: false }` when nothing is saved to a branch.
// POST  Request a review: take the pull request out of draft.
//
// Workspace owners, admins and editors: the same people who can publish.
// Merging is POST /api/github/hosted-docs/publish/merge.
// ---------------------------------------------------------------------------

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
}

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

async function resolveSource(): Promise<
  | { ok: true; source: GitHubHostedDocsSourceRow | null; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return { ok: false, response: json({ error: 'Sign in to review changes.', code: 'unauthenticated' }, 401) }
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return { ok: false, response: json({ error: 'Choose a workspace first.', code: 'workspace_required' }, 403) }
  }
  if (!['owner', 'admin', 'editor'].includes(workspace.role)) {
    return {
      ok: false,
      response: json(
        {
          error: 'Only workspace owners, admins, and editors can review changes.',
          code: 'insufficient_role',
        },
        403,
      ),
    }
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return {
      ok: false,
      response: json(
        { error: 'GitHub publishing is not enabled for this workspace.', code: 'feature_not_enabled' },
        402,
      ),
    }
  }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('*')
    .eq('workspace_id', workspace.workspace_id)
    .maybeSingle()
  if (error) throw error
  const source = data as GitHubHostedDocsSourceRow | null
  const usable = source && isReadmeFormatSource(source) && source.sync_status !== 'disabled'
  return { ok: true, source: usable ? source : null, admin }
}

function failure(err: unknown, fallback: string): NextResponse {
  if (err instanceof ReadmePublishError) {
    return json({ error: err.message, code: err.code }, err.status)
  }
  if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
    return json(
      {
        error: 'The GitHub App can no longer read the linked repository or the branch.',
        code: 'github_unavailable',
      },
      409,
    )
  }
  console.error('[Breezify] hosted docs review failed:', err)
  return json({ error: fallback, code: 'review_failed' }, 500)
}

export async function GET(): Promise<NextResponse> {
  try {
    const resolved = await resolveSource()
    if (!resolved.ok) return resolved.response
    if (!resolved.source) return json({ open: false })
    const review = await loadReadmeSourceReview(resolved.source, resolved.admin)
    if (!review) return json({ open: false })
    return json({
      open: true,
      branch: review.branch,
      base: review.base,
      repo_full_name: review.repoFullName,
      pull_request: {
        number: review.pullRequest.number,
        url: review.pullRequest.url,
        title: review.pullRequest.title,
        draft: review.pullRequest.draft,
        created_at: review.pullRequest.createdAt,
        updated_at: review.pullRequest.updatedAt,
      },
      behind_by: review.behindBy,
      commits: review.commits,
      contributors: review.contributors.map((contributor) => ({
        name: contributor.name,
        login: contributor.login,
        avatar_url: contributor.avatarUrl,
        last_active_at: contributor.lastActiveAt,
      })),
      files: review.files.map((file) => ({
        path: file.path,
        previous_path: file.previousPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      })),
      file_count: review.fileCount,
      additions: review.additions,
      deletions: review.deletions,
      truncated: review.truncated,
    })
  } catch (err) {
    return failure(err, 'Could not load the review of this branch.')
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const resolved = await resolveSource()
    if (!resolved.ok) return resolved.response
    if (!resolved.source) {
      return json({ error: 'There is no open working branch to review.', code: 'no_pull_request' }, 409)
    }
    const requested = await requestReadmeSourceReview(resolved.source, resolved.admin)
    return json({ pull_request_number: requested.pullRequestNumber, draft: requested.draft })
  } catch (err) {
    return failure(err, 'Could not request a review.')
  }
}

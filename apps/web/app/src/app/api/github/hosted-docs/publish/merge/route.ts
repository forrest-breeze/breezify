import { after, NextResponse } from 'next/server'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ReadmePublishError } from '@/lib/github/readme/readme-publish'
import {
  isReadmeFormatSource,
  mergeReadmeSourcePullRequest,
  syncReadmeSource,
} from '@/lib/github/readme/readme-service'

export const runtime = 'nodejs'
// The follow-up sync runs after the response, inside this function's lifetime.
export const maxDuration = 300

// ---------------------------------------------------------------------------
// POST /api/github/hosted-docs/publish/merge
//
// Merge the open Breezify publish pull request, using the merge method chosen
// in Settings -> Integrations -> GitHub. Admins and owners only: this is the
// step that makes the changes live on the synced branch.
// ---------------------------------------------------------------------------

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to merge the publish pull request.', code: 'unauthenticated' },
      { status: 401 },
    )
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json(
      { error: 'Choose a workspace first.', code: 'workspace_required' },
      { status: 403 },
    )
  }
  if (!['owner', 'admin'].includes(workspace.role)) {
    return NextResponse.json(
      {
        error: 'Only workspace owners and admins can merge the publish pull request.',
        code: 'insufficient_role',
      },
      { status: 403 },
    )
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return NextResponse.json(
      { error: 'GitHub publishing is not enabled for this workspace.', code: 'feature_not_enabled' },
      { status: 402 },
    )
  }

  const admin = createAdminClient()
  try {
    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (error) throw error
    const source = data as GitHubHostedDocsSourceRow | null
    if (!source || !isReadmeFormatSource(source) || source.sync_status === 'disabled') {
      return NextResponse.json(
        { error: 'No linked GitHub docs to merge into.', code: 'hosted_docs_not_ready' },
        { status: 409 },
      )
    }

    const merged = await mergeReadmeSourcePullRequest(source, admin)

    // Pull the merge commit in straight away so new pages are linked without
    // waiting for the webhook. A sync that is already running wins the claim.
    after(async () => {
      try {
        const { data: refreshed } = await admin
          .from('github_hosted_docs_sources')
          .select('*')
          .eq('id', source.id)
          .eq('workspace_id', workspace.workspace_id)
          .maybeSingle()
        if (refreshed) await syncReadmeSource(refreshed as GitHubHostedDocsSourceRow, {}, admin)
      } catch (syncError) {
        console.error('[Breezify] sync after publish merge failed:', syncError)
      }
    })

    return NextResponse.json({
      merged: merged.merged,
      pull_request_number: merged.pullRequestNumber,
      merge_commit_sha: merged.mergeCommitSha,
      merge_method: merged.method,
    })
  } catch (err) {
    if (err instanceof ReadmePublishError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    console.error('[Breezify] publish pull request merge failed:', err)
    return NextResponse.json(
      { error: 'Could not merge the publish pull request.', code: 'merge_failed' },
      { status: 500 },
    )
  }
}

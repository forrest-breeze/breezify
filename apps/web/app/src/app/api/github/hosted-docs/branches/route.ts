import { NextResponse } from 'next/server'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { groupBranchesByVersion } from '@/lib/github/branch-groups'
import { getInstallationToken, listRepositoryBranches } from '@/lib/github/github'
import { readmeWorkingBranch } from '@/lib/github/readme/readme-branch-name'
import { GitHubApiError, withGitHubRetry } from '@/lib/github/retry'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// GET /api/github/hosted-docs/branches
//
// The versions and branches of the linked docs repository, grouped the way
// ReadMe names them (a `v1.6` branch per version, `v1.6_<name>` branches under
// it). Read-only, for any member of the workspace.
// ---------------------------------------------------------------------------

const PRIVATE_HEADERS = { 'Cache-Control': 'private, max-age=30', Vary: 'Cookie' }

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return NextResponse.json({ error: 'Sign in to see branches.' }, { status: 401 })
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: 'Choose a workspace first.' }, { status: 403 })
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
    if (!source || source.sync_status === 'disabled') {
      return NextResponse.json({ linked: false }, { headers: PRIVATE_HEADERS })
    }

    const token = await withGitHubRetry(() => getInstallationToken(source.installation_id))
    const listed = await withGitHubRetry(() => listRepositoryBranches(token, source.repo_full_name))
    const syncedBranch = source.branch ?? listed.defaultBranch
    const groups = groupBranchesByVersion(listed.branches, {
      defaultBranch: listed.defaultBranch,
      syncedBranch,
      workingBranch: readmeWorkingBranch(source),
    })
    return NextResponse.json(
      {
        linked: true,
        repo_full_name: source.repo_full_name,
        default_branch: listed.defaultBranch,
        synced_branch: syncedBranch,
        truncated: listed.truncated,
        ...groups,
      },
      { headers: PRIVATE_HEADERS },
    )
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
      return NextResponse.json(
        { error: 'The GitHub App can no longer read the linked repository.' },
        { status: 409 },
      )
    }
    console.error('[Breezify] GET /api/github/hosted-docs/branches failed:', err)
    return NextResponse.json({ error: 'Could not load branches.' }, { status: 500 })
  }
}

import 'server-only'

import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { getAuthUser } from '@/lib/auth/get-auth-user'
import { getActiveWorkspaceForUser } from '@/lib/db/workspace'
import { createAdminClient } from '@/lib/supabase/admin'
import { withTimeout } from '@/lib/utils'

/** The part of a hosted-docs link the editor sync lock needs. */
export type HostedDocsSyncSnapshot = Pick<
  GitHubHostedDocsSourceRow,
  'sync_status' | 'repo_full_name' | 'paths' | 'updated_at'
>

/** A slow lookup must not hold up the editor; the client check still runs. */
const SNAPSHOT_TIMEOUT_MS = 2000

async function readSnapshot(): Promise<HostedDocsSyncSnapshot | null> {
  const user = await getAuthUser()
  if (!user) return null
  const admin = createAdminClient()
  const workspace = await getActiveWorkspaceForUser(user.id, admin)
  if (!workspace) return null
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('sync_status, repo_full_name, paths, updated_at')
    .eq('workspace_id', workspace.workspace_id)
    .maybeSingle()
  if (error) throw new Error(`hosted docs sync snapshot: ${error.message}`)
  const source = data as HostedDocsSyncSnapshot | null
  // A link without a root is not active; the status API reports it as unlinked.
  if (!source || source.paths.length === 0) return null
  return source
}

/**
 * The workspace's GitHub docs sync state, read during the server render so the
 * editor layouts can decide the sync lock before any client code runs.
 *
 * This only reads the stored row. It never calls GitHub and never starts a
 * sync. Returns `null` when no repository is linked and `undefined` when the
 * state could not be read, in which case the caller should not lock.
 */
export async function loadHostedDocsSyncSnapshot(): Promise<
  HostedDocsSyncSnapshot | null | undefined
> {
  try {
    return await withTimeout(readSnapshot(), SNAPSHOT_TIMEOUT_MS)
  } catch (error) {
    console.warn('[Breezify] hosted docs sync snapshot unavailable:', error)
    return undefined
  }
}

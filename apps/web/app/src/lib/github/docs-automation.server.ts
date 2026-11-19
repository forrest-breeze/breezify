import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import {
  AUTO_PUBLISH_IDLE_SECONDS,
  getDocsChecksSettings,
  getGithubPublishingSettings,
  type DocsChecksSettings,
  type GithubPublishingSettings,
} from './docs-automation-settings'
import type { CommitCoAuthor } from './readme/readme-publish'

/** The workspace's publishing and docs-check settings, defaults when unset. */
export async function loadDocsAutomationSettings(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<{ publishing: GithubPublishingSettings; checks: DocsChecksSettings }> {
  const { data, error } = await admin
    .from('workspaces')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`workspace settings lookup: ${error.message}`)
  const settings = (data as { settings?: unknown } | null)?.settings
  return {
    publishing: getGithubPublishingSettings(settings),
    checks: getDocsChecksSettings(settings),
  }
}

/**
 * Everyone who edited these documents since each one last matched the
 * repository. A document synced before that moment was recorded falls back to
 * `fallbackSince`, which under-credits rather than naming someone whose edit
 * was already published.
 */
export async function listDocumentCoAuthors(
  admin: SupabaseClient,
  input: { workspaceId: string; documentIds: string[]; fallbackSince: string | null },
): Promise<CommitCoAuthor[]> {
  if (input.documentIds.length === 0) return []
  const { data: documents, error: documentsError } = await admin
    .from('documents')
    .select('id, source_metadata')
    .eq('workspace_id', input.workspaceId)
    .in('id', input.documentIds)
  if (documentsError) throw new Error(`co-author document lookup: ${documentsError.message}`)
  const sinceByDocument = new Map<string, string | null>()
  for (const row of (documents ?? []) as Array<{
    id: string
    source_metadata: Record<string, unknown> | null
  }>) {
    const syncedAt = row.source_metadata?.readme_synced_at
    sinceByDocument.set(row.id, typeof syncedAt === 'string' ? syncedAt : input.fallbackSince)
  }

  const { data: versions, error: versionsError } = await admin
    .from('document_versions')
    .select('document_id, edited_by, created_at')
    .eq('workspace_id', input.workspaceId)
    .in('document_id', input.documentIds)
    .not('edited_by', 'is', null)
    .order('created_at', { ascending: true })
    .limit(2000)
  if (versionsError) throw new Error(`co-author version lookup: ${versionsError.message}`)
  const editorIds: string[] = []
  for (const version of (versions ?? []) as Array<{
    document_id: string
    edited_by: string
    created_at: string
  }>) {
    const since = sinceByDocument.get(version.document_id) ?? null
    if (since && Date.parse(version.created_at) <= Date.parse(since)) continue
    if (!editorIds.includes(version.edited_by)) editorIds.push(version.edited_by)
  }
  if (editorIds.length === 0) return []

  const { data: profiles, error: profilesError } = await admin
    .from('profiles')
    .select('user_id, display_name, email')
    .in('user_id', editorIds)
  if (profilesError) throw new Error(`co-author profile lookup: ${profilesError.message}`)
  const profileByUser = new Map(
    ((profiles ?? []) as Array<{
      user_id: string
      display_name: string | null
      email: string | null
    }>).map((profile) => [profile.user_id, profile]),
  )
  return editorIds.flatMap((userId) => {
    const profile = profileByUser.get(userId)
    return profile?.email
      ? [{ name: profile.display_name?.trim() || profile.email, email: profile.email }]
      : []
  })
}

export interface AutoPublishRefusal {
  code:
    | 'auto_publish_disabled'
    | 'auto_publish_requires_direct'
    | 'auto_publish_conflicts'
    | 'auto_publish_waiting'
  error: string
  retry_after_seconds?: number
}

/**
 * Whether an automatic publish may run right now. It commits with nobody
 * reviewing, so it only ever runs when the workspace asked for it, publishes
 * straight to the branch, has no conflict waiting for a decision, and nobody
 * has edited anything for a little while. Returns null when it may proceed.
 */
export async function autoPublishRefusal(
  admin: SupabaseClient,
  source: GitHubHostedDocsSourceRow,
  now: number = Date.now(),
): Promise<AutoPublishRefusal | null> {
  const { publishing } = await loadDocsAutomationSettings(admin, source.workspace_id)
  if (!publishing.autoPublish) {
    return { code: 'auto_publish_disabled', error: 'Auto publish is turned off for this workspace.' }
  }
  if (source.publish_mode !== 'direct') {
    return {
      code: 'auto_publish_requires_direct',
      error: 'Auto publish only applies when publishing commits directly to the branch.',
    }
  }
  if ((source.conflict_count ?? 0) > 0) {
    return {
      code: 'auto_publish_conflicts',
      error: 'Pages changed in both Breezify and GitHub need a decision before publishing.',
    }
  }
  const newest = async (table: 'documents' | 'folders'): Promise<number> => {
    const { data, error } = await admin
      .from(table)
      .select('updated_at')
      .eq('workspace_id', source.workspace_id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`auto publish ${table} lookup: ${error.message}`)
    const updatedAt = (data as { updated_at?: string | null } | null)?.updated_at
    return updatedAt ? Date.parse(updatedAt) : 0
  }
  const lastEdit = Math.max(await newest('documents'), await newest('folders'))
  const idleFor = (now - lastEdit) / 1000
  if (idleFor < AUTO_PUBLISH_IDLE_SECONDS) {
    return {
      code: 'auto_publish_waiting',
      error: 'Someone edited the workspace moments ago. Publishing waits until editing stops.',
      retry_after_seconds: Math.max(1, Math.ceil(AUTO_PUBLISH_IDLE_SECONDS - idleFor)),
    }
  }
  return null
}

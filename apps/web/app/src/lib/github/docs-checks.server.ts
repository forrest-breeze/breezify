import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { loadDocsAutomationSettings } from './docs-automation.server'
import type { DocsCheckMode } from './docs-automation-settings'
import type { DocsCheckInfo } from './docs-check-request'
import { loadDocsCheckSnapshot, type DocsCheckSnapshot } from './docs-check-snapshot.server'
import { DOCS_FORMAT_CHECK_NAME } from './docs-format-check'
import { runDocsFormatCheck } from './docs-format-check.server'
import { DOCS_LINK_CHECK_NAME } from './docs-link-check'
import { runDocsLinkCheck } from './docs-link-check.server'
import { getInstallationToken } from './github'
import {
  createGitHubCheckRun,
  type GitHubCheckOutput,
  type GitHubWritableCheckRunConclusion,
} from './github-checks'
import { readmeRootFromPaths } from './readme/readme-layout'
import { withGitHubRetry } from './retry'

// ---------------------------------------------------------------------------
// The checks Breezify posts on a ReadMe-format docs repository: "Docs links"
// and "Docs format". Each is a setting of the linked workspace (disabled,
// warning or blocking) and each reports as its own check run, so a repository
// can require one and not the other. They read the same commit once.
// ---------------------------------------------------------------------------

export type ReadmeDocsCheck = 'links' | 'format'

type CheckReport = { conclusion: GitHubWritableCheckRunConclusion; output: GitHubCheckOutput }
type EnabledMode = Exclude<DocsCheckMode, 'disabled'>

const CHECKS: Record<
  ReadmeDocsCheck,
  {
    name: string
    externalId: string
    run: (snapshot: DocsCheckSnapshot, mode: EnabledMode) => Promise<CheckReport>
  }
> = {
  links: { name: DOCS_LINK_CHECK_NAME, externalId: 'breezify-docs-links', run: runDocsLinkCheck },
  format: { name: DOCS_FORMAT_CHECK_NAME, externalId: 'breezify-docs-format', run: runDocsFormatCheck },
}

export type ReadmeDocsChecksResult =
  | { status: 'ignored'; reason: 'unlinked' | 'disabled' }
  | {
      status: 'reported'
      checks: Array<{ check: ReadmeDocsCheck; checkRunId: number; conclusion: string }>
    }

/**
 * What to post when a check could not look at the commit. Saying nothing would
 * leave a required check waiting forever with no run to re-run.
 */
function unfinishedReport(name: string, mode: EnabledMode): CheckReport {
  return {
    conclusion: mode === 'blocking' ? 'failure' : 'neutral',
    output: {
      title: `${name} could not finish`,
      summary:
        'Breezify could not read this commit. Re-run the check. If it fails again, reconnect the repository in Breezify under Settings, Integrations, GitHub.',
    },
  }
}

/**
 * Run the requested checks on one commit and post a check run for each one the
 * linked workspace has turned on. A repository with no ReadMe-format link, or
 * with the checks off, is left alone before any token is minted.
 */
export async function handleReadmeDocsChecks(
  info: DocsCheckInfo,
  requested: readonly ReadmeDocsCheck[],
): Promise<ReadmeDocsChecksResult> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('workspace_id, paths, format, sync_status')
    .eq('installation_id', info.installationId)
    .eq('repo_id', info.repoId)
  if (error) throw new Error(`docs checks source lookup: ${error.message}`)
  const source = ((data ?? []) as Array<{
    workspace_id: string
    paths: string[]
    format: string | null
    sync_status: string
  }>).find((row) => row.format === 'readme' && row.sync_status !== 'disabled')
  if (!source) return { status: 'ignored', reason: 'unlinked' }

  const { checks: settings } = await loadDocsAutomationSettings(admin, source.workspace_id)
  const modes: Record<ReadmeDocsCheck, DocsCheckMode> = {
    links: settings.brokenLinks,
    format: settings.formatting,
  }
  const enabled = [...new Set(requested)].flatMap((check) => {
    const mode = modes[check]
    return mode === 'disabled' ? [] : [{ check, mode }]
  })
  if (enabled.length === 0) return { status: 'ignored', reason: 'disabled' }

  const token = await withGitHubRetry(() => getInstallationToken(info.installationId))
  const snapshot = loadDocsCheckSnapshot({
    token,
    repoFullName: info.repoFullName,
    headSha: info.headSha,
    root: readmeRootFromPaths(source.paths),
  })
  // One check failing must not stop the other from reporting.
  const settled = await Promise.allSettled(
    enabled.map(async ({ check, mode }) => {
      const { name, externalId, run } = CHECKS[check]
      let report: CheckReport
      try {
        report = await run(await snapshot, mode)
      } catch (cause) {
        const status = (cause as { status?: unknown })?.status
        console.error('[Breezify] GitHub docs check could not finish:', {
          check,
          errorType: cause instanceof Error ? cause.name : typeof cause,
          ...(typeof status === 'number' ? { status } : {}),
        })
        report = unfinishedReport(name, mode)
      }
      const created = await createGitHubCheckRun(token, info.repoFullName, {
        name,
        head_sha: info.headSha,
        external_id: `${externalId}:${info.repoId}:${info.headSha}`,
        status: 'completed',
        conclusion: report.conclusion,
        completed_at: new Date().toISOString(),
        output: report.output,
      })
      return { check, checkRunId: created.id, conclusion: report.conclusion }
    }),
  )
  const failed = settled.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return {
    status: 'reported',
    checks: settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
  }
}

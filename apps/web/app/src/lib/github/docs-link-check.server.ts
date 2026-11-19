import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { loadDocsAutomationSettings } from './docs-automation.server'
import type { DocsCheckMode } from './docs-automation-settings'
import {
  DOCS_LINK_CHECK_NAME,
  docsLinkCheckPagePaths,
  findBrokenDocsLinks,
  type BrokenDocsLink,
  type DocsLinkCheckInfo,
} from './docs-link-check'
import {
  getInstallationToken,
  getRepositoryBlob,
  getRepositoryCommit,
  getRepositoryTree,
} from './github'
import {
  createGitHubCheckRun,
  type GitHubCheckAnnotation,
  type GitHubCheckOutput,
  type GitHubWritableCheckRunConclusion,
} from './github-checks'
import { readmeRootFromPaths } from './readme/readme-layout'
import { withGitHubRetry } from './retry'

// ---------------------------------------------------------------------------
// The "Docs links" check: reports broken links between docs pages on every
// commit GitHub asks checks for (which covers pull requests). Runs only for a
// ReadMe-format link whose workspace turned the check on.
// ---------------------------------------------------------------------------

const BLOB_FETCH_CONCURRENCY = 6
const MAX_PAGES = 600
const MAX_PAGE_BYTES = 512 * 1024
const MAX_ANNOTATIONS = 50
const MAX_LISTED = 40

export type DocsLinkCheckResult =
  | { status: 'ignored'; reason: 'unlinked' | 'disabled' }
  | { status: 'reported'; checkRunId: number; brokenLinks: number; conclusion: string }

/** The check's conclusion and report for a set of broken links. */
export function docsLinkCheckReport(
  broken: readonly BrokenDocsLink[],
  input: { mode: Exclude<DocsCheckMode, 'disabled'>; pageCount: number; truncated: boolean },
): { conclusion: GitHubWritableCheckRunConclusion; output: GitHubCheckOutput } {
  const pages = `${input.pageCount} page${input.pageCount === 1 ? '' : 's'}`
  const partial = input.truncated
    ? ` Only the first ${MAX_PAGES} pages were checked.`
    : ''
  if (broken.length === 0) {
    return {
      conclusion: 'success',
      output: {
        title: 'No broken links',
        summary: `Checked the links between ${pages}. External URLs are not fetched.${partial}`,
      },
    }
  }
  const blocking = input.mode === 'blocking'
  const annotations: GitHubCheckAnnotation[] = broken.slice(0, MAX_ANNOTATIONS).map((link) => ({
    path: link.path,
    start_line: link.line,
    end_line: link.line,
    annotation_level: blocking ? 'failure' : 'warning',
    title: 'Broken link',
    message: `${link.target}: ${link.reason}`.slice(0, 1000),
  }))
  const listed = broken
    .slice(0, MAX_LISTED)
    .map((link) => `- \`${link.path}\` line ${link.line}: \`${link.target.replace(/`/g, "'")}\` (${link.reason})`)
  if (broken.length > MAX_LISTED) listed.push(`- and ${broken.length - MAX_LISTED} more`)
  return {
    // `neutral` shows the problems without failing the commit.
    conclusion: blocking ? 'failure' : 'neutral',
    output: {
      title: `${broken.length} broken link${broken.length === 1 ? '' : 's'}`,
      summary: [
        `Found ${broken.length} broken link${broken.length === 1 ? '' : 's'} across ${pages}.${partial}`,
        blocking
          ? 'This check is set to block: fix the links, or change it in Breezify under Settings, Integrations, GitHub.'
          : 'This check only warns. It can be made blocking in Breezify under Settings, Integrations, GitHub.',
      ].join('\n\n'),
      text: listed.join('\n'),
      annotations,
    },
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++
      output[index] = await fn(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return output
}

export async function handleDocsLinkCheck(info: DocsLinkCheckInfo): Promise<DocsLinkCheckResult> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('workspace_id, paths, format, sync_status')
    .eq('installation_id', info.installationId)
    .eq('repo_id', info.repoId)
  if (error) throw new Error(`docs link check source lookup: ${error.message}`)
  const source = ((data ?? []) as Array<{
    workspace_id: string
    paths: string[]
    format: string | null
    sync_status: string
  }>).find((row) => row.format === 'readme' && row.sync_status !== 'disabled')
  if (!source) return { status: 'ignored', reason: 'unlinked' }

  const { checks } = await loadDocsAutomationSettings(admin, source.workspace_id)
  if (checks.brokenLinks === 'disabled') return { status: 'ignored', reason: 'disabled' }

  const root = readmeRootFromPaths(source.paths)
  const token = await withGitHubRetry(() => getInstallationToken(info.installationId))
  const commit = await withGitHubRetry(() =>
    getRepositoryCommit(token, info.repoFullName, info.headSha),
  )
  const tree = await withGitHubRetry(() =>
    getRepositoryTree(token, info.repoFullName, commit.commit.tree.sha),
  )
  const blobs = tree.tree.filter((entry) => entry.type === 'blob')
  const shaByPath = new Map(blobs.map((entry) => [entry.path, entry]))
  const allPagePaths = docsLinkCheckPagePaths(shaByPath.keys(), root)
  const pagePaths = allPagePaths.slice(0, MAX_PAGES)
  const pages = (
    await mapWithConcurrency(pagePaths, BLOB_FETCH_CONCURRENCY, async (path) => {
      const entry = shaByPath.get(path)!
      if ((entry.size ?? 0) > MAX_PAGE_BYTES) return null
      const blob = await withGitHubRetry(() =>
        getRepositoryBlob(token, info.repoFullName, entry.sha),
      )
      if (blob.encoding !== 'base64') return null
      return {
        path,
        raw: Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8'),
      }
    })
  ).filter((page): page is { path: string; raw: string } => page !== null)

  const broken = findBrokenDocsLinks({ pages, files: new Set(shaByPath.keys()), root })
  const report = docsLinkCheckReport(broken, {
    mode: checks.brokenLinks,
    pageCount: pages.length,
    truncated: tree.truncated === true || allPagePaths.length > pagePaths.length,
  })
  const run = await createGitHubCheckRun(token, info.repoFullName, {
    name: DOCS_LINK_CHECK_NAME,
    head_sha: info.headSha,
    external_id: `breezify-docs-links:${info.repoId}:${info.headSha}`,
    status: 'completed',
    conclusion: report.conclusion,
    completed_at: new Date().toISOString(),
    output: report.output,
  })
  return {
    status: 'reported',
    checkRunId: run.id,
    brokenLinks: broken.length,
    conclusion: report.conclusion,
  }
}

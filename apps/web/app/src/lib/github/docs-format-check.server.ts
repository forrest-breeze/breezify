import 'server-only'

import {
  readDocsCheckFiles,
  type DocsCheckSnapshot,
} from './docs-check-snapshot.server'
import type { DocsCheckMode } from './docs-automation-settings'
import {
  findDocsFormatIssues,
  type DocsFormatFile,
  type DocsFormatIssue,
} from './docs-format-check'
import type {
  GitHubCheckAnnotation,
  GitHubCheckOutput,
  GitHubWritableCheckRunConclusion,
} from './github-checks'
import {
  README_MAX_PAGE_BYTES,
  README_MAX_PAGES,
  README_MAX_SPEC_BYTES,
  classifyReadmeTree,
} from './readme/readme-layout'

// ---------------------------------------------------------------------------
// The "Docs format" check: reports pages, `_order.yaml` files and OpenAPI
// definitions that are malformed, on every commit GitHub asks checks for
// (which covers pull requests). Run by `handleReadmeDocsChecks` for a
// workspace that turned the check on.
// ---------------------------------------------------------------------------

const MAX_ANNOTATIONS = 50
const MAX_LISTED = 40

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The check's conclusion and report for a set of formatting problems. */
export function docsFormatCheckReport(
  issues: readonly DocsFormatIssue[],
  input: {
    mode: Exclude<DocsCheckMode, 'disabled'>
    pageCount: number
    orderFileCount: number
    specCount: number
    /** Pages in the repository, when that is more than a workspace can hold. */
    tooManyPages: number | null
    /** GitHub returned only part of the repository's file list. */
    truncated: boolean
  },
): { conclusion: GitHubWritableCheckRunConclusion; output: GitHubCheckOutput } {
  const scope = [
    plural(input.pageCount, 'page'),
    plural(input.orderFileCount, '`_order.yaml` file'),
    plural(input.specCount, 'OpenAPI file'),
  ].join(', ')
  const partial = [
    input.tooManyPages === null
      ? ''
      : ` The repository has ${input.tooManyPages} pages, more than the ${README_MAX_PAGES} Breezify syncs; only the first ${README_MAX_PAGES} were checked.`,
    input.truncated ? ' GitHub returned only part of the file list, so some files were not checked.' : '',
  ].join('')
  const checked =
    'Checked frontmatter, unclosed code blocks and components, merge conflict markers, `_order.yaml` entries and OpenAPI file syntax. Writing style is not checked.'

  if (issues.length === 0 && input.tooManyPages === null) {
    return {
      conclusion: 'success',
      output: {
        title: 'No formatting problems',
        summary: `Checked ${scope}.${partial}\n\n${checked}`,
      },
    }
  }
  const blocking = input.mode === 'blocking'
  const annotations: GitHubCheckAnnotation[] = issues.slice(0, MAX_ANNOTATIONS).map((issue) => ({
    path: issue.path,
    start_line: issue.line,
    end_line: issue.line,
    annotation_level: blocking ? 'failure' : 'warning',
    title: 'Formatting problem',
    message: issue.message.slice(0, 1000),
  }))
  const listed = issues
    .slice(0, MAX_LISTED)
    .map((issue) => `- \`${issue.path}\` line ${issue.line}: ${issue.message.replace(/`/g, "'")}`)
  if (issues.length > MAX_LISTED) listed.push(`- and ${issues.length - MAX_LISTED} more`)
  const files = new Set(issues.map((issue) => issue.path)).size
  return {
    // `neutral` shows the problems without failing the commit.
    conclusion: blocking ? 'failure' : 'neutral',
    output: {
      title:
        issues.length === 0 ? 'Too many pages' : plural(issues.length, 'formatting problem'),
      summary: [
        issues.length === 0
          ? `Checked ${scope}.${partial}`
          : `Found ${plural(issues.length, 'formatting problem')} in ${plural(files, 'file')}, out of ${scope}.${partial}`,
        blocking
          ? 'This check is set to block: fix the problems, or change it in Breezify under Settings, Integrations, GitHub.'
          : 'This check only warns. It can be made blocking in Breezify under Settings, Integrations, GitHub.',
      ].join('\n\n'),
      ...(listed.length > 0 ? { text: listed.join('\n') } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
    },
  }
}

/** Check the formatting of the docs at the snapshot's commit. */
export async function runDocsFormatCheck(
  snapshot: DocsCheckSnapshot,
  mode: Exclude<DocsCheckMode, 'disabled'>,
): Promise<{ conclusion: GitHubWritableCheckRunConclusion; output: GitHubCheckOutput }> {
  const classified = classifyReadmeTree(
    [...snapshot.sizes].map(([path, size]) => ({ path, type: 'blob', sha: '', size })),
    snapshot.root,
  )
  const pagePaths = classified.pages.slice(0, README_MAX_PAGES).map((file) => file.path)
  const load = (paths: readonly string[], limit: number): Promise<DocsFormatFile[]> =>
    readDocsCheckFiles(paths, async (path) => {
      const size = snapshot.sizes.get(path) ?? 0
      // A file over its limit is reported for its size; there is no need to read it.
      if (size > limit) return { path, size, raw: null, isText: true }
      const file = await snapshot.read(path)
      return file
        ? { path, size, raw: file.raw, isText: file.isText }
        : { path, size, raw: '', isText: false }
    })
  const [pages, orderFiles, specs] = await Promise.all([
    load(pagePaths, README_MAX_PAGE_BYTES),
    load(classified.orderFiles.map((file) => file.path), README_MAX_PAGE_BYTES),
    load(classified.specCandidates.map((file) => file.path), README_MAX_SPEC_BYTES),
  ])

  const issues = findDocsFormatIssues({
    pages,
    orderFiles,
    specs,
    files: snapshot.sizes.keys(),
    root: snapshot.root,
  })
  return docsFormatCheckReport(issues, {
    mode,
    pageCount: pages.length,
    orderFileCount: orderFiles.length,
    specCount: specs.length,
    tooManyPages: classified.pages.length > README_MAX_PAGES ? classified.pages.length : null,
    truncated: snapshot.truncated,
  })
}

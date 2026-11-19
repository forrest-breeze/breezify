import 'server-only'

import {
  readDocsCheckFiles,
  type DocsCheckSnapshot,
} from './docs-check-snapshot.server'
import type { DocsCheckMode } from './docs-automation-settings'
import {
  docsLinkCheckPagePaths,
  findBrokenDocsLinks,
  type BrokenDocsLink,
} from './docs-link-check'
import type {
  GitHubCheckAnnotation,
  GitHubCheckOutput,
  GitHubWritableCheckRunConclusion,
} from './github-checks'

// ---------------------------------------------------------------------------
// The "Docs links" check: reports broken links between docs pages on every
// commit GitHub asks checks for (which covers pull requests). Run by
// `handleReadmeDocsChecks` for a workspace that turned the check on.
// ---------------------------------------------------------------------------

const MAX_PAGES = 600
const MAX_PAGE_BYTES = 512 * 1024
const MAX_ANNOTATIONS = 50
const MAX_LISTED = 40

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

/** Check the links in the docs at the snapshot's commit. */
export async function runDocsLinkCheck(
  snapshot: DocsCheckSnapshot,
  mode: Exclude<DocsCheckMode, 'disabled'>,
): Promise<{ conclusion: GitHubWritableCheckRunConclusion; output: GitHubCheckOutput }> {
  const allPagePaths = docsLinkCheckPagePaths(snapshot.sizes.keys(), snapshot.root)
  const pagePaths = allPagePaths.slice(0, MAX_PAGES)
  const pages = (
    await readDocsCheckFiles(pagePaths, async (path) => {
      if ((snapshot.sizes.get(path) ?? 0) > MAX_PAGE_BYTES) return null
      const file = await snapshot.read(path)
      return file ? { path, raw: file.raw } : null
    })
  ).filter((page): page is { path: string; raw: string } => page !== null)

  const broken = findBrokenDocsLinks({
    pages,
    files: new Set(snapshot.sizes.keys()),
    root: snapshot.root,
  })
  return docsLinkCheckReport(broken, {
    mode,
    pageCount: pages.length,
    truncated: snapshot.truncated || allPagePaths.length > pagePaths.length,
  })
}

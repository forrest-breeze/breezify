import { extractDocsCheckInfo, type DocsCheckInfo } from './docs-check-request'
import { frontmatterSlug, parseReadmeFile } from './readme/readme-frontmatter'
import {
  basenameWithoutExtension,
  directoryOf,
  isIndexPage,
  isReadmePagePath,
  joinReadmePath,
  relativeReadmePath,
  slugifySegment,
} from './readme/readme-layout'

// ---------------------------------------------------------------------------
// Broken links between the pages of a ReadMe-format docs repository.
//
// Only links that point inside the docs are checked: a page slug
// (`[x](quick-start)`, `/docs/quick-start`, `doc:quick-start`) or a file in
// the repository (`./setup.md`, `../images/flow.png`). External URLs are never
// fetched: they are slow, rate limited and fail for reasons that have nothing
// to do with the docs, which makes a check nobody trusts.
// ---------------------------------------------------------------------------

export interface DocsLinkPage {
  /** Repository path of the file. */
  path: string
  /** The whole file, frontmatter included, so line numbers match GitHub's. */
  raw: string
}

export interface BrokenDocsLink {
  path: string
  /** 1-based line of the link in the file. */
  line: number
  target: string
  reason: string
}

/** URL prefixes ReadMe serves pages under, mapped to nothing: the slug decides. */
const PAGE_ROUTES = new Set(['docs', 'reference', 'page', 'recipes', 'changelog', 'changelogs'])
/** ReadMe's legacy `doc:slug` style link schemes. */
const SLUG_SCHEMES = new Set(['doc', 'ref', 'page', 'recipe', 'changelog', 'blog'])

const MARKDOWN_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const HREF_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/g
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`\n]*\1/g

function normalizeSlug(value: string): string {
  return decodeURIComponentSafe(value).trim().toLowerCase()
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Every slug a page can be linked by: its file name, and its frontmatter slug. */
export function collectPageSlugs(pages: readonly DocsLinkPage[], root: string): Set<string> {
  const slugs = new Set<string>()
  for (const page of pages) {
    const relative = relativeReadmePath(root, page.path)
    if (!relative || !isReadmePagePath(relative)) continue
    const name = isIndexPage(relative)
      ? directoryOf(relative).split('/').at(-1) ?? ''
      : basenameWithoutExtension(relative)
    if (name) {
      slugs.add(normalizeSlug(name))
      // A category directory is named after its title ("Getting Started");
      // links reach it by the slug of that title.
      slugs.add(slugifySegment(name, name))
    }
    const parsed = parseReadmeFile(page.raw)
    const explicit = parsed.error ? null : frontmatterSlug(parsed.frontmatter)
    if (explicit) slugs.add(normalizeSlug(explicit))
  }
  return slugs
}

function resolveRelativePath(fromFile: string, target: string): string | null {
  const segments = directoryOf(fromFile).split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.join('/')
}

/**
 * Why a link target is broken, or null when it resolves or is not ours to
 * check (external, a bare anchor, or an absolute path we do not recognise).
 */
export function brokenLinkReason(input: {
  target: string
  fromPath: string
  root: string
  slugs: ReadonlySet<string>
  files: ReadonlySet<string>
}): string | null {
  const withoutFragment = input.target.split('#')[0]!.split('?')[0]!.trim()
  if (!withoutFragment) return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(withoutFragment)
  if (scheme) {
    if (!SLUG_SCHEMES.has(scheme[1]!.toLowerCase())) return null
    const slug = normalizeSlug(withoutFragment.slice(scheme[0].length))
    return !slug || input.slugs.has(slug) ? null : `no page has the slug "${slug}"`
  }
  if (withoutFragment.startsWith('//')) return null

  if (withoutFragment.startsWith('/')) {
    const segments = withoutFragment.split('/').filter(Boolean)
    // An optional version prefix, as in /v1.6/docs/quick-start.
    if (segments[0] && /^v?\d+(?:\.\d+)*$/i.test(segments[0])) segments.shift()
    if (segments.length !== 2 || !PAGE_ROUTES.has(segments[0]!.toLowerCase())) return null
    const slug = normalizeSlug(segments[1]!)
    return input.slugs.has(slug) ? null : `no page has the slug "${slug}"`
  }

  const decoded = decodeURIComponentSafe(withoutFragment)
  const looksLikeFile = decoded.includes('/') || /\.[a-z0-9]{1,5}$/i.test(decoded)
  if (!looksLikeFile) {
    const slug = normalizeSlug(decoded)
    return input.slugs.has(slug) ? null : `no page has the slug "${slug}"`
  }
  const resolved = resolveRelativePath(input.fromPath, decoded)
  if (resolved === null) return 'points outside the repository'
  if (input.files.has(resolved)) return null
  // A relative link to a page may omit the extension, or name its directory.
  const asPage = ['.md', '.mdx', '/index.md', '/index.mdx'].some((suffix) =>
    input.files.has(`${resolved}${suffix}`),
  )
  if (asPage) return null
  // `./quick-start` is also how a page links to a slug: page URLs are flat, so
  // the browser resolves it to the page with that slug wherever its file is.
  const last = decoded.split('/').filter(Boolean).at(-1) ?? ''
  if (!/\.[a-z0-9]{1,5}$/i.test(last) && input.slugs.has(normalizeSlug(last))) return null
  return `${resolved} does not exist`
}

/** Link targets in one file with the line each sits on; code is skipped. */
export function extractLinkTargets(raw: string): Array<{ target: string; line: number }> {
  const found: Array<{ target: string; line: number }> = []
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  let fence: string | null = null
  // Frontmatter is metadata, not prose: links there are not page links.
  let frontmatterEnd = -1
  if (lines[0]?.trim() === '---') {
    frontmatterEnd = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  }
  lines.forEach((line, index) => {
    if (index <= frontmatterEnd) return
    const marker = FENCE_OPEN.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return
    }
    if (marker) {
      fence = marker
      return
    }
    const prose = line.replace(INLINE_CODE, ' ')
    for (const pattern of [MARKDOWN_LINK, HREF_ATTRIBUTE]) {
      for (const match of prose.matchAll(pattern)) {
        const target = (match[1] ?? match[2] ?? '').trim()
        if (target) found.push({ target, line: index + 1 })
      }
    }
  })
  return found
}

/**
 * Every broken internal link in the docs. `files` is every path in the
 * repository at the commit being checked, so links to images and other
 * non-page files resolve too.
 */
export function findBrokenDocsLinks(input: {
  pages: readonly DocsLinkPage[]
  files: ReadonlySet<string>
  /** Project root inside the repository; '' is the repository root. */
  root: string
}): BrokenDocsLink[] {
  const slugs = collectPageSlugs(input.pages, input.root)
  const broken: BrokenDocsLink[] = []
  for (const page of input.pages) {
    const seen = new Set<string>()
    for (const { target, line } of extractLinkTargets(page.raw)) {
      const reason = brokenLinkReason({
        target,
        fromPath: page.path,
        root: input.root,
        slugs,
        files: input.files,
      })
      if (!reason) continue
      const key = `${line}\0${target}`
      if (seen.has(key)) continue
      seen.add(key)
      broken.push({ path: page.path, line, target, reason })
    }
  }
  return broken.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

/** Paths of the pages a link check reads, under the project's sections. */
export function docsLinkCheckPagePaths(paths: Iterable<string>, root: string): string[] {
  const pages: string[] = []
  for (const path of paths) {
    const relative = relativeReadmePath(root, path)
    if (relative && isReadmePagePath(relative)) pages.push(joinReadmePath(root, relative))
  }
  return pages.sort((a, b) => a.localeCompare(b))
}

export const DOCS_LINK_CHECK_NAME = 'Docs links'

/** The commit a webhook asks the link check to run on. */
export type DocsLinkCheckInfo = DocsCheckInfo

/**
 * The commit a webhook asks checks for: a new check suite (every push, so
 * every pull request update), or someone pressing "Re-run" on this check.
 */
export function extractDocsLinkCheckInfo(
  eventType: string,
  payload: Record<string, unknown>,
  expectedAppId?: string,
): DocsLinkCheckInfo | null {
  return extractDocsCheckInfo(eventType, payload, DOCS_LINK_CHECK_NAME, expectedAppId)
}

import yaml from 'js-yaml'
import { extractDocsCheckInfo, type DocsCheckInfo } from './docs-check-request'
import {
  frontmatterDate,
  frontmatterSlug,
  parseReadmeFile,
} from './readme/readme-frontmatter'
import {
  README_MAX_PAGE_BYTES,
  README_MAX_SPEC_BYTES,
  directoryOf,
  readmeSectionOf,
  relativeReadmePath,
  slugifySegment,
} from './readme/readme-layout'

// ---------------------------------------------------------------------------
// Formatting problems in a ReadMe-format docs repository.
//
// Everything reported here is something that goes wrong without anyone being
// told: a page the sync skips because its frontmatter does not parse, a code
// block that swallows the rest of a page, a component that is never closed, an
// `_order.yaml` entry for a page that was renamed, an OpenAPI file that is no
// longer valid JSON. Style (line length, heading levels, wording) is not
// checked: a check that argues about taste is a check people turn off.
//
// Pure: the caller reads the files, this decides what is wrong with them.
// ---------------------------------------------------------------------------

export interface DocsFormatFile {
  /** Repository path of the file. */
  path: string
  /** Size in bytes, as the repository reports it. */
  size: number
  /** The whole file. Null when it was not read because it is over its limit. */
  raw: string | null
  /** False when the file is binary or not UTF-8. */
  isText: boolean
}

export interface DocsFormatIssue {
  path: string
  /** 1-based line the problem is on; 1 when it concerns the whole file. */
  line: number
  message: string
}

/**
 * ReadMe components that wrap content and so need a closing tag. `<Image>` and
 * `<Embed>` are left out: they are written both self-closing and with a
 * caption between the tags.
 */
const PAIRED_COMPONENTS = [
  'Accordion',
  'Anchor',
  'Callout',
  'Cards',
  'Card',
  'Columns',
  'Column',
  'HTMLBlock',
  'Table',
  'Tabs',
  'Tab',
] as const

const COMPONENT_NAMES = PAIRED_COMPONENTS.join('|')
/** A whole tag: quoted attributes and one level of `{}` may contain `>`. */
const COMPONENT_TAG = new RegExp(
  `<(/?)(${COMPONENT_NAMES})(?![A-Za-z0-9_.-])((?:"[^"]*"|'[^']*'|\\{[^{}]*\\}|[^<>"'{}])*?)(/?)>`,
  'g',
)
const COMPONENT_START = new RegExp(`</?(?:${COMPONENT_NAMES})(?![A-Za-z0-9_.-])`, 'g')

const FENCE_LINE = /^[\s>]*(`{3,}|~{3,})(.*)$/
const INLINE_CODE = /(`+)[^`\n]*\1/g
const CONFLICT_MARKER = /^(?:<{7}|>{7}) \S/

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`
}

function yamlError(error: unknown): { reason: string; line: number | null } {
  const reason = error instanceof Error ? error.message.split('\n')[0]! : 'invalid YAML'
  const line = (error as { mark?: { line?: unknown } } | null)?.mark?.line
  return {
    // js-yaml appends the position to the first line; the annotation has it.
    reason: reason.replace(/\s*\(\d+:\d+\)\s*$/, ''),
    line: typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line : null,
  }
}

/** A file the check cannot look inside, or null when it can. */
function unreadableReason(file: DocsFormatFile, limit: number, what: string): string | null {
  if (file.size > limit || file.raw === null) {
    return `is larger than the ${formatBytes(limit)} ${what} limit, so Breezify does not sync it`
  }
  return file.isText ? null : 'is not UTF-8 text, so Breezify does not sync it'
}

function normalize(raw: string): string[] {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
}

// --- Frontmatter -----------------------------------------------------------

function frontmatterKeyLine(rawFrontmatter: string | null, key: string): number {
  const index = (rawFrontmatter ?? '')
    .split('\n')
    .findIndex((line) => new RegExp(`^["']?${key}["']?\\s*:`).test(line))
  // Line 1 of the file is the opening `---`.
  return index === -1 ? 1 : index + 2
}

function frontmatterIssues(path: string, raw: string, section: string | null): DocsFormatIssue[] {
  const parsed = parseReadmeFile(raw)
  const issue = (line: number, message: string): DocsFormatIssue => ({ path, line, message })

  if (!parsed.hasFrontmatter) {
    // An opening `---` with nothing closing it: the metadata is shown as text.
    return /^---[ \t]*$/.test(normalize(raw)[0] ?? '')
      ? [issue(1, 'frontmatter opens with "---" but no later "---" line closes it')]
      : []
  }
  if (parsed.error) {
    let line = 1
    let message = parsed.error
    try {
      yaml.load(parsed.rawFrontmatter ?? '', { schema: yaml.CORE_SCHEMA })
    } catch (error) {
      const details = yamlError(error)
      if (details.line !== null) line = details.line + 2
      message = `frontmatter is not valid YAML (${details.reason})`
    }
    return [issue(line, `${message}, so Breezify does not sync this page`)]
  }

  const { frontmatter, rawFrontmatter } = parsed
  const found: DocsFormatIssue[] = []
  const at = (key: string): number => frontmatterKeyLine(rawFrontmatter, key)
  const hasText = (value: unknown): boolean =>
    (typeof value === 'string' && value.trim() !== '') ||
    (typeof value === 'number' && Number.isFinite(value))

  if ('title' in frontmatter && !hasText(frontmatter.title)) {
    found.push(issue(at('title'), '"title" must be text; the page is named after its file instead'))
  }
  if ('hidden' in frontmatter) {
    const hidden = frontmatter.hidden
    if (typeof hidden !== 'boolean' && hidden !== 'true' && hidden !== 'false') {
      found.push(
        issue(at('hidden'), '"hidden" must be true or false; anything else leaves the page published'),
      )
    }
  }
  if ('slug' in frontmatter && frontmatterSlug(frontmatter) === null) {
    found.push(
      issue(at('slug'), '"slug" must be one URL segment with no "/"; the file name is used instead'),
    )
  }
  if (
    section === 'changelogs' &&
    hasText(frontmatter.date) &&
    frontmatterDate(frontmatter) === null
  ) {
    found.push(issue(at('date'), '"date" is not a date; write it as YYYY-MM-DD'))
  }
  return found
}

// --- Page body ---------------------------------------------------------------

function bodyIssues(path: string, raw: string): DocsFormatIssue[] {
  const found: DocsFormatIssue[] = []
  const lines = normalize(raw)
  let frontmatterEnd = -1
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    frontmatterEnd = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line))
  }

  // Code is masked out (same length, so positions still map to lines) before
  // components are matched: a tag inside a code sample is text.
  const prose: string[] = []
  let fence: { marker: string; line: number } | null = null
  for (const [index, line] of lines.entries()) {
    if (index <= frontmatterEnd) {
      prose.push('')
      continue
    }
    if (CONFLICT_MARKER.test(line)) {
      found.push({ path, line: index + 1, message: 'merge conflict marker left in the page' })
    }
    const match = FENCE_LINE.exec(line)
    const marker = match?.[1]
    const rest = match?.[2] ?? ''
    if (fence) {
      // Only a bare fence of the same kind, at least as long, closes a block.
      if (
        marker &&
        marker[0] === fence.marker[0] &&
        marker.length >= fence.marker.length &&
        rest.trim() === ''
      ) {
        fence = null
      }
      prose.push('')
      continue
    }
    // A backtick fence cannot have a backtick in its info string: that line
    // is inline code.
    if (marker && !(marker[0] === '`' && rest.includes('`'))) {
      fence = { marker, line: index + 1 }
      prose.push('')
      continue
    }
    prose.push(line.replace(INLINE_CODE, (code) => ' '.repeat(code.length)))
  }
  if (fence) {
    found.push({
      path,
      line: fence.line,
      message: `the code block opened with ${fence.marker} is never closed, so the rest of the page is shown as code`,
    })
  }

  const text = prose.join('\n')
  const tags = [...text.matchAll(COMPONENT_TAG)]
  // A tag this cannot read in full (unusual attributes) would be missed as an
  // opener and its closing tag reported for nothing. Say nothing instead.
  if (tags.length !== (text.match(COMPONENT_START)?.length ?? 0)) return found

  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length
  const unclosed = (name: string, line: number): DocsFormatIssue => ({
    path,
    line,
    message: `<${name}> is never closed; add </${name}>`,
  })
  const open: Array<{ name: string; line: number }> = []
  for (const tag of tags) {
    const [, closing, name, , selfClosing] = tag as unknown as [string, string, string, string, string]
    const line = lineAt(tag.index ?? 0)
    if (!closing) {
      if (!selfClosing) open.push({ name, line })
      continue
    }
    const matching = open.findLastIndex((entry) => entry.name === name)
    if (matching === -1) {
      found.push({ path, line, message: `</${name}> has no opening <${name}>` })
      continue
    }
    // Whatever was opened inside it and not closed by now never will be.
    for (const entry of open.splice(matching).slice(1)) found.push(unclosed(entry.name, entry.line))
  }
  for (const entry of open) found.push(unclosed(entry.name, entry.line))
  return found
}

// --- _order.yaml ---------------------------------------------------------------

/** Names an `_order.yaml` in each directory may list: its pages and folders. */
function orderableNames(files: Iterable<string>): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>()
  const add = (directory: string, name: string): void => {
    const known = names.get(directory) ?? new Set<string>()
    known.add(name.toLowerCase())
    known.add(slugifySegment(name, name.toLowerCase()))
    names.set(directory, known)
  }
  for (const path of files) {
    const segments = path.split('/')
    const name = segments.at(-1)!
    if (/\.(?:md|mdx)$/i.test(name)) {
      add(segments.slice(0, -1).join('/'), name.replace(/\.(?:md|mdx)$/i, ''))
    }
    // Every ancestor directory is a folder its own parent may list.
    for (let depth = 1; depth < segments.length; depth++) {
      add(segments.slice(0, depth - 1).join('/'), segments[depth - 1]!)
    }
  }
  return names
}

function orderFileIssues(
  file: DocsFormatFile,
  names: ReadonlyMap<string, ReadonlySet<string>>,
): DocsFormatIssue[] {
  const issue = (line: number, message: string): DocsFormatIssue => ({ path: file.path, line, message })
  const unreadable = unreadableReason(file, README_MAX_PAGE_BYTES, 'page')
  if (unreadable) return [issue(1, unreadable)]
  const lines = normalize(file.raw!)
  let loaded: unknown
  try {
    loaded = yaml.load(lines.join('\n'), { schema: yaml.CORE_SCHEMA })
  } catch (error) {
    const details = yamlError(error)
    return [issue((details.line ?? 0) + 1, `is not valid YAML (${details.reason}), so the order is ignored`)]
  }
  if (loaded === null || loaded === undefined) return []
  if (!Array.isArray(loaded)) {
    return [issue(1, 'must be a YAML list of page slugs, so the order is ignored')]
  }

  const found: DocsFormatIssue[] = []
  const known = names.get(directoryOf(file.path)) ?? new Set<string>()
  let searchFrom = 0
  for (const item of loaded) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      found.push(issue(1, 'every entry must be the slug of a page or the name of a folder'))
      continue
    }
    const entry = String(item).trim().replace(/\.(?:md|mdx)$/i, '')
    // Entries are read top to bottom, so each is found below the previous one.
    const index = lines.findIndex((line, at) => at >= searchFrom && line.includes(String(item).trim()))
    if (index !== -1) searchFrom = index + 1
    if (!entry || entry.includes('/')) continue
    if (known.has(entry.toLowerCase()) || known.has(slugifySegment(entry, entry.toLowerCase()))) continue
    found.push(
      issue(
        index === -1 ? 1 : index + 1,
        `lists "${entry}", but this folder has no page or folder with that name`,
      ),
    )
  }
  return found
}

// --- OpenAPI definitions ---------------------------------------------------------

function specIssues(file: DocsFormatFile): DocsFormatIssue[] {
  const issue = (line: number, message: string): DocsFormatIssue => ({ path: file.path, line, message })
  const unreadable = unreadableReason(file, README_MAX_SPEC_BYTES, 'OpenAPI definition')
  if (unreadable) return [issue(1, unreadable)]
  const raw = file.raw!.replace(/^﻿/, '')
  // Same rule as the sync: JSON when it starts like JSON, otherwise YAML.
  if (/^\s*[{[]/.test(raw)) {
    try {
      JSON.parse(raw)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid JSON'
      const line = /\(line (\d+) column \d+\)/.exec(reason)?.[1]
      return [issue(line ? Number(line) : 1, `is not valid JSON (${reason}), so the API reference is not updated`)]
    }
    return []
  }
  try {
    yaml.load(raw, { schema: yaml.CORE_SCHEMA })
  } catch (error) {
    const details = yamlError(error)
    return [
      issue((details.line ?? 0) + 1, `is not valid YAML (${details.reason}), so the API reference is not updated`),
    ]
  }
  return []
}

// --- The check ---------------------------------------------------------------

/**
 * Every formatting problem in the docs at one commit. `files` is every path in
 * the repository, which is how an `_order.yaml` entry is matched to a page.
 */
export function findDocsFormatIssues(input: {
  pages: readonly DocsFormatFile[]
  orderFiles: readonly DocsFormatFile[]
  /** JSON and YAML files under `reference/`. */
  specs: readonly DocsFormatFile[]
  files: Iterable<string>
  /** Project root inside the repository; '' is the repository root. */
  root: string
}): DocsFormatIssue[] {
  const found: DocsFormatIssue[] = []
  for (const page of input.pages) {
    const unreadable = unreadableReason(page, README_MAX_PAGE_BYTES, 'page')
    if (unreadable) {
      found.push({ path: page.path, line: 1, message: unreadable })
      continue
    }
    const relative = relativeReadmePath(input.root, page.path)
    const section = relative === null ? null : readmeSectionOf(relative)
    found.push(...frontmatterIssues(page.path, page.raw!, section), ...bodyIssues(page.path, page.raw!))
  }
  const names = orderableNames(input.files)
  for (const file of input.orderFiles) found.push(...orderFileIssues(file, names))
  for (const file of input.specs) found.push(...specIssues(file))
  return found.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

export const DOCS_FORMAT_CHECK_NAME = 'Docs format'

/** The commit a webhook asks the format check to run on. */
export function extractDocsFormatCheckInfo(
  eventType: string,
  payload: Record<string, unknown>,
  expectedAppId?: string,
): DocsCheckInfo | null {
  return extractDocsCheckInfo(eventType, payload, DOCS_FORMAT_CHECK_NAME, expectedAppId)
}

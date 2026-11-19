import { HTML_TAG_SOURCE } from '@/lib/html-detection'

// ---------------------------------------------------------------------------
// Breezify stores a page as either Markdown or HTML and tells them apart by
// looking for HTML tags (`looksLikeHtml`). Markdown is rendered with raw HTML
// switched off. A ReadMe page is Markdown that freely mixes in HTML: `<br />`
// for spacing, `<Table>` for tables with rich cells, the odd `<h3 id>`. One
// such tag is enough for the whole page to be read as HTML, which flattens its
// Markdown into a single run of text.
//
// This is the last step of the repository -> workspace conversion: whatever
// HTML is left becomes the Markdown that says the same thing, or is dropped
// with its text kept. Code is never touched.
// ---------------------------------------------------------------------------

const ANY_HTML_TAG = new RegExp(HTML_TAG_SOURCE, 'gi')
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`\n]*\1/g
const LINE_BREAK = /<br\s*\/?>/gi

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  return match ? (match[1] ?? match[2] ?? null) : null
}

/** Inline HTML -> inline Markdown; unknown tags lose the tag and keep the text. */
function inlineToMarkdown(value: string): string {
  return value
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attributes: string, text: string) => {
      const href = attribute(attributes, 'href')
      const label = text.replace(ANY_HTML_TAG, '').trim()
      return href ? `[${label || href}](${href})` : label
    })
    .replace(/<img\b([^>]*?)\/?>/gi, (_match, attributes: string) => {
      const src = attribute(attributes, 'src')
      return src ? `![${attribute(attributes, 'alt') ?? ''}](${src})` : ''
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text: string) =>
      text.trim() ? `**${text.trim()}**` : '',
    )
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text: string) =>
      text.trim() ? `*${text.trim()}*` : '',
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, text: string) =>
      text.includes('`') || !text.trim() ? text : `\`${text}\``,
    )
}

/** One table cell on one line, safe inside a pipe table. */
function cellToMarkdown(value: string): string {
  return inlineToMarkdown(value.replace(LINE_BREAK, ' '))
    .replace(ANY_HTML_TAG, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\|/g, '\\|')
}

/** `<table>` with rows of cells -> a pipe table. Null when it has no rows. */
function tableToMarkdown(inner: string): string | null {
  const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) =>
      [...row[1]!.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) =>
        cellToMarkdown(cell[2]!),
      ),
    )
    .filter((cells) => cells.length > 0)
  if (rows.length === 0) return null
  const width = Math.max(...rows.map((cells) => cells.length))
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_unused, index) => cells[index] ?? '').join(' | ')} |`
  const [header, ...body] = rows
  return [line(header!), line(Array.from({ length: width }, () => '---')), ...body.map(line)].join('\n')
}

function proseWithoutHtml(prose: string): string {
  // Inline code may mention tags; park it while the prose is rewritten.
  const parked: string[] = []
  let output = prose.replace(INLINE_CODE, (code) => {
    parked.push(code)
    return `\u0000${parked.length - 1}\u0000`
  })

  output = output
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (match, inner: string) => {
      const table = tableToMarkdown(inner)
      return table ? `\n\n${table}\n\n` : match
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, text: string) => {
      const title = inlineToMarkdown(text).replace(ANY_HTML_TAG, '').replace(/\s+/g, ' ').trim()
      return title ? `\n\n${'#'.repeat(Number(level))} ${title}\n\n` : ''
    })
    .split('\n')
    .map((line) => {
      if (!LINE_BREAK.test(line)) return line
      LINE_BREAK.lastIndex = 0
      // A break on its own is vertical space, which a blank line already is.
      // In a table row it must not split the row. Elsewhere it is a new line.
      if (/^\s*(?:<br\s*\/?>\s*)+$/i.test(line)) return ''
      return line.replace(LINE_BREAK, /^\s*\|/.test(line) ? ' ' : '\n')
    })
    .join('\n')
  output = inlineToMarkdown(output)
    .replace(/<li\b[^>]*>\s*/gi, '\n- ')
    .replace(/<\/(?:p|div|li|ul|ol|section|article|blockquote|details|summary|figure)>/gi, '\n\n')
    .replace(ANY_HTML_TAG, '')

  return output.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => parked[Number(index)]!)
}

/** Markdown with every HTML tag outside code converted or removed. */
export function markdownWithoutHtml(markdown: string): string {
  const output: string[] = []
  let prose: string[] = []
  let fence: string | null = null
  const flush = (): void => {
    if (prose.length > 0) output.push(proseWithoutHtml(prose.join('\n')))
    prose = []
  }
  for (const line of markdown.split('\n')) {
    const marker = FENCE_OPEN.exec(line)?.[1]
    if (fence) {
      output.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      flush()
      fence = marker
      output.push(line)
      continue
    }
    prose.push(line)
  }
  flush()
  return output.join('\n')
}

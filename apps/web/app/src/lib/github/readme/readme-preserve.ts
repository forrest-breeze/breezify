import { diffArrays } from 'diff'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import { readmeBodyToMarkdown } from './readme-markdown'

/**
 * Writing an edited page back without rewriting the parts nobody edited.
 *
 * The repository -> workspace conversion is lossy (components become Markdown,
 * `<style>` is dropped) and the editor re-serializes everything it loads (`*`
 * bullets become `-`, `***` becomes `---`). Writing the editor's Markdown back
 * as the whole file therefore changes lines the author never touched.
 *
 * Instead the repository file is cut into top-level blocks, and each block is
 * compared with the edited page by what it renders. A block that still renders
 * the same is written back byte for byte; only blocks that were added, changed
 * or removed take the editor's Markdown. Blocks Breezify never shows (styles,
 * imports, spacers) cannot have been edited and are always kept.
 *
 * Pure: no database or network access.
 */

/** Markdown -> a string that is equal for Markdown that renders the same. */
export type MarkdownCanonicalizer = (markdown: string) => string

// `html: true` mirrors the editor, which parses stored Markdown the same way.
const parser = new MarkdownIt({ html: true })

/** Inline marks in the order the editor nests them, outermost first. */
const MARK_ORDER = ['link', 'strong', 'em', 's']

/**
 * Re-nest the marks of one inline run the way the editor's schema does: a link
 * wraps the other marks, bold wraps italic, and inline code carries no other
 * mark at all (`**\`x\`**` is shown, and saved, as plain code).
 */
function editorMarks(children: Token[], TokenClass: typeof Token): Token[] {
  const output: Token[] = []
  const active = new Map<string, Token>()
  const stack: Array<{ name: string; open: Token }> = []
  const closeDownTo = (depth: number): void => {
    for (const { open } of stack.splice(depth).reverse()) {
      const close = new TokenClass(open.type.replace(/_open$/, '_close'), open.tag, -1)
      close.markup = open.markup
      output.push(close)
    }
  }
  for (const child of children) {
    const mark = /^(link|strong|em|s)_(open|close)$/.exec(child.type)
    if (mark) {
      if (mark[2] === 'open') active.set(mark[1]!, child)
      else active.delete(mark[1]!)
      continue
    }
    const wanted =
      child.type === 'code_inline'
        ? []
        : MARK_ORDER.filter((name) => active.has(name)).map((name) => ({
            name,
            open: active.get(name)!,
          }))
    let shared = 0
    while (
      shared < stack.length &&
      shared < wanted.length &&
      stack[shared]!.name === wanted[shared]!.name &&
      // Two links side by side stay two links.
      (wanted[shared]!.name !== 'link' || stack[shared]!.open === wanted[shared]!.open)
    ) {
      shared++
    }
    closeDownTo(shared)
    for (const entry of wanted.slice(shared)) {
      output.push(entry.open)
      stack.push(entry)
    }
    output.push(child)
  }
  closeDownTo(0)
  return output
}

// Rendering follows the editor's schema, so that the comparison form of a page
// is what the editor would save for it:
// - a list item always holds a paragraph, also in a tight list;
// - headings stop at level 3 (HeadingWithId in tiptap-editor.tsx), deeper ones
//   are paragraphs;
// - marks nest in the editor's order (see editorMarks).
parser.core.ruler.push('editor_schema', (state) => {
  for (const token of state.tokens) {
    token.hidden = false
    if (/^heading_(open|close)$/.test(token.type) && /^h[456]$/.test(token.tag)) {
      token.type = token.type.replace('heading', 'paragraph')
      token.tag = 'p'
    }
    if (token.type === 'inline' && token.children) {
      token.children = editorMarks(token.children, state.Token)
    }
  }
})

// The same fence rule the repository -> workspace conversion uses.
const FENCE = /^\s*(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`\n]*\1/g
/** A Breezify block directive (`{% tabs %}`, `{% endcard %}`) on its own line. */
const DIRECTIVE_LINE = /^\{%.*%\}[ \t]*$/
const TAG = /<(\/?)([A-Za-z][\w.:-]*)(?=[\s/>])[^<>]*?(\/?)>/g
const MAGIC_BLOCK = /\[(\/?)block(?::[a-z-]+)?\]/g

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** Calls back for every line, saying whether it is part of a fenced block. */
function eachLine(lines: string[], visit: (line: string, index: number, fenced: boolean) => void): void {
  let fence: string | null = null
  lines.forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1] ?? null
    if (fence) {
      visit(line, index, true)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return
    }
    if (marker) fence = marker
    visit(line, index, marker !== null)
  })
}

/**
 * Directives are block boundaries for Breezify but plain text to Markdown, so a
 * run of them would read as one paragraph. Give each its own paragraph.
 */
function isolateDirectives(markdown: string): string {
  if (!markdown.includes('{%')) return markdown
  const lines = markdown.split('\n')
  const output: string[] = []
  eachLine(lines, (line, _index, fenced) => {
    if (!fenced && DIRECTIVE_LINE.test(line)) output.push('', line, '')
    else output.push(line)
  })
  return output.join('\n')
}

/**
 * The comparison form of Markdown: what the editor would save for it, read back
 * the way the editor's content is. Spelling that renders the same (`*` or `-`
 * bullets, `***` or `---` rules, table padding, wrapped lines) compares equal.
 */
export function canonicalReadmeMarkdown(
  markdown: string,
  toMarkdown: (content: string | null | undefined) => string,
): string {
  const prepared = isolateDirectives(markdown.replace(/\r\n?/g, '\n'))
    // The editor labels a code block without a language `plaintext`.
    .replace(/^([ \t]*(?:`{3,}|~{3,}))plaintext[ \t]*$/gm, '$1')
  return toMarkdown(parser.render(prepared))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Whether a page as it is in the repository and a document as the editor
 * saved it are the same page.
 *
 * The editor's Markdown does not always parse back to what it was written
 * from (a list nested under a numbered item is indented too little), so the
 * repository's side is also compared after one pass through the editor's form.
 */
export function sameReadmeContent(
  repositoryMarkdown: string,
  editorMarkdown: string,
  canonical: MarkdownCanonicalizer,
): boolean {
  const saved = canonical(editorMarkdown)
  const shown = canonical(repositoryMarkdown)
  return shown === saved || canonical(shown) === saved
}

interface Block {
  /** Index of the block's last line in the text it was cut from. */
  last: number
  lines: string[]
  /** The blank lines that follow it. */
  gap: string[]
}

interface Split {
  /** Blank lines before the first block. */
  lead: string[]
  blocks: Block[]
}

/**
 * Cut Markdown into its top-level blocks. Every line lands in exactly one of
 * `lead`, a block or a gap, in order, so joining them gives the text back.
 * `joined(line)` is true when the block holding that line must not end there.
 */
function splitBlocks(text: string, joined?: (line: number) => boolean): Split {
  const lines = text.split('\n')
  // Which top-level block of the parser each line belongs to. Lines it gives
  // no block (link definitions) stay -1 and form blocks of their own.
  const owner = new Array<number>(lines.length).fill(-1)
  let next = 0
  for (const token of parser.parse(text, {})) {
    if (token.level !== 0 || token.nesting === -1 || !token.map) continue
    for (let line = token.map[0]; line < token.map[1] && line < lines.length; line++) {
      owner[line] = next
    }
    next++
  }

  const split: Split = { lead: [], blocks: [] }
  let current: Block | null = null
  let currentOwner = -1
  lines.forEach((line, index) => {
    if (isBlank(line)) {
      // Held back: it belongs to the block only if more of the block follows.
      if (current) current.gap.push(line)
      else split.lead.push(line)
      return
    }
    const lineOwner = owner[index]!
    const continues =
      current !== null &&
      (joined?.(current.last) === true ||
        (lineOwner === currentOwner && (lineOwner !== -1 || current.gap.length === 0)))
    if (current && continues) {
      current.lines.push(...current.gap, line)
      current.gap = []
      current.last = index
    } else {
      current = { last: index, lines: [line], gap: [] }
      split.blocks.push(current)
    }
    currentOwner = lineOwner
  })
  return split
}

/**
 * For each line of a ReadMe page, whether a block that includes it has to
 * continue: the line is inside a fence, inside a component or HTML element
 * (`<Tabs>` ... `</Tabs>`, `<style>` ... `</style>`), inside a tag written over
 * several lines, or inside a magic block. Splitting there would hand the
 * converter half a component.
 */
function openLines(lines: string[]): boolean[] {
  const masked: string[] = []
  const fenced: boolean[] = []
  eachLine(lines, (line, index, inFence) => {
    fenced[index] = inFence
    masked[index] = inFence ? '' : line.replace(INLINE_CODE, (code) => ' '.repeat(code.length))
  })
  const text = masked.join('\n')

  const lineStarts: number[] = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') lineStarts.push(index + 1)
  }
  let cursor = 0
  const lineAt = (offset: number): number => {
    while (cursor + 1 < lineStarts.length && lineStarts[cursor + 1]! <= offset) cursor++
    while (cursor > 0 && lineStarts[cursor]! > offset) cursor--
    return cursor
  }

  // A placeholder such as `<YOUR_API_KEY>` is never closed and must not hold a
  // block open, so only names that are closed somewhere count as containers.
  const closable = new Set<string>()
  for (const match of text.matchAll(TAG)) if (match[1]) closable.add(match[2]!)

  const delta = new Array<number>(lines.length + 1).fill(0)
  for (const match of text.matchAll(TAG)) {
    const first = lineAt(match.index)
    const last = lineAt(match.index + match[0].length - 1)
    const closing = match[1] === '/'
    const container = !closing && match[3] !== '/' && closable.has(match[2]!)
    if (closing) delta[last]! -= 1
    else {
      delta[first]! += 1
      if (!container) delta[last]! -= 1
    }
  }
  for (const match of text.matchAll(MAGIC_BLOCK)) {
    delta[lineAt(match.index)]! += match[1] === '/' ? -1 : 1
  }

  let depth = 0
  return lines.map((_line, index) => {
    depth = Math.max(0, depth + delta[index]!)
    const fenceContinues = fenced[index] === true && fenced[index + 1] === true
    return depth > 0 || fenceContinues
  })
}

/**
 * The body of a page edited in Breezify, keeping the repository's own text for
 * every block the edit left alone.
 *
 * Returns null when nothing of the previous body can be kept, or when the
 * result would not read back as exactly the edited page; the caller then
 * writes the edited Markdown as it is.
 */
export function preserveReadmeSource(input: {
  /** Body of the repository file (after its frontmatter). */
  previousBody: string
  /** The page as Breezify would write it. */
  markdown: string
  canonical: MarkdownCanonicalizer
}): string | null {
  const { canonical } = input
  const previousBody = input.previousBody.replace(/\r\n?/g, '\n')
  const edited = input.markdown.replace(/\r\n?/g, '\n')

  const sourceLines = previousBody.split('\n')
  const open = openLines(sourceLines)
  const source = splitBlocks(previousBody, (line) => open[line] === true)
  if (source.blocks.length === 0) return null

  const keysOf = (markdown: string): string[] =>
    splitBlocks(isolateDirectives(markdown))
      .blocks.map((block) => canonical(block.lines.join('\n')))
      .filter((key) => key !== '')

  // What each repository block shows in Breezify. A block can show several
  // things (a tab group), or nothing at all.
  const sourceKeys: string[] = []
  const keyRange = source.blocks.map((block) => {
    // First what the editor would save for the block, then its keys the same
    // way the edited page's are taken, so both sides share any quirk of that.
    const keys = keysOf(canonical(readmeBodyToMarkdown(block.lines.join('\n'))))
    const first = sourceKeys.length
    sourceKeys.push(...keys)
    return { first, count: keys.length }
  })

  const editedBlocks = splitBlocks(isolateDirectives(edited)).blocks
  const editedKeys = editedBlocks.map(
    // Something that renders as nothing cannot be matched to anything.
    (block, index) => canonical(block.lines.join('\n')) || `\u0000${index}`,
  )

  // Line up the two sequences; `match[i]` is the edited block that repository
  // key `i` still corresponds to.
  const match = new Array<number>(sourceKeys.length).fill(-1)
  let sourceIndex = 0
  let editedIndex = 0
  for (const part of diffArrays(sourceKeys, editedKeys)) {
    if (part.removed) sourceIndex += part.value.length
    else if (part.added) editedIndex += part.value.length
    else for (let offset = 0; offset < part.value.length; offset++) match[sourceIndex++] = editedIndex++
  }

  // A block is kept when everything it shows is still there, in one piece.
  const kept = keyRange.map(({ first, count }) => {
    if (count === 0) return null
    for (let offset = 0; offset < count; offset++) {
      if (match[first + offset]! < 0) return null
      if (offset > 0 && match[first + offset] !== match[first + offset - 1]! + 1) return null
    }
    return { first: match[first]!, last: match[first + count - 1]! }
  })
  const invisible = keyRange.map(({ count }) => count === 0)
  if (!kept.some(Boolean) && !invisible.some(Boolean)) return null

  // Assemble in repository order. Edited blocks go where the block they
  // replace was; a block added between two kept ones goes before the second.
  type Piece = { lines: string[]; sourceIndex: number | null }
  const pieces: Piece[] = []
  let emitted = 0
  const emitEditedUpTo = (limit: number): void => {
    for (; emitted < limit; emitted++) {
      pieces.push({ lines: editedBlocks[emitted]!.lines, sourceIndex: null })
    }
  }
  source.blocks.forEach((block, index) => {
    const range = kept[index]
    if (range) {
      emitEditedUpTo(range.first)
      emitted = range.last + 1
    } else if (!invisible[index]) {
      const nextKept = kept.find((candidate, later) => later > index && candidate !== null)
      emitEditedUpTo(nextKept ? nextKept.first : editedBlocks.length)
      return
    }
    pieces.push({ lines: block.lines, sourceIndex: index })
  })
  emitEditedUpTo(editedBlocks.length)

  const output: string[] = [...source.lead]
  pieces.forEach((piece, index) => {
    output.push(...piece.lines)
    const following = pieces[index + 1]
    if (!following) {
      // End the file the way it ended before.
      output.push(...source.blocks.at(-1)!.gap)
    } else if (
      piece.sourceIndex !== null &&
      following.sourceIndex === piece.sourceIndex + 1
    ) {
      output.push(...source.blocks[piece.sourceIndex]!.gap)
    } else {
      output.push('')
    }
  })
  const body = pieces.length > 0 ? output.join('\n') : ''

  // Whatever was kept, the file must read back as the page that was edited.
  return sameReadmeContent(readmeBodyToMarkdown(body), edited, canonical) ? body : null
}

import { JSDOM } from 'jsdom'

// ---------------------------------------------------------------------------
// ReadMe pages often draw their visuals with hand-written JSX layouts:
//   <div className="…" style={{display: "flex", …}}> … </div>
// Breezify renders Markdown without raw HTML, so those layouts used to arrive
// as indented text (read as code blocks). Here each top-level layout is parsed
// and, when its shape is recognised, rewritten as a native Breezify block:
//
//   operators (× = …) between boxes          → {% formula %}
//   boxes that start with 1, 2, 3 …           → {% steps %}
//   boxes joined by a caption-only connector → {% timeline %}
//   rows of boxes joined by arrow cells      → ```mermaid flowchart
//   two or more boxes side by side            → {% cards %}
//
// Anything else keeps its text as plain paragraphs, never as a code block.
// ---------------------------------------------------------------------------

type Tone = 'green' | 'blue' | 'amber' | 'red' | 'neutral'

interface Leaf {
  element: Element
  markdown: string
  text: string
}

const INLINE = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'BR', 'SPAN', 'SMALL'])
const OPERATOR = /^[×x*+−\-÷=]$/

function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}

/** `{{display: "flex", gap: 12}}` → `display: flex; gap: 12px`. */
function styleObjectToCss(source: string): string {
  const declarations: string[] = []
  const pattern = /(\w+)\s*:\s*("(?:\\.|[^"\\])*"|'[^']*'|-?[\d.]+)/g
  for (const match of source.matchAll(pattern)) {
    const [, key, raw] = match
    let value = /^["']/.test(raw) ? raw.slice(1, -1) : raw
    if (!/^["']/.test(raw) && value !== '0' && !/^(?:fontWeight|flex|lineHeight|opacity|zIndex)$/.test(key)) {
      value = `${value}px`
    }
    declarations.push(`${camelToKebab(key)}: ${value.replace(/"/g, "'")}`)
  }
  return declarations.join('; ')
}

/** Turn JSX markup into HTML the DOM parser understands. */
function jsxToHtml(source: string): string {
  return source
    .replace(/\bstyle=\{\{([\s\S]*?)\}\}/g, (_match, body: string) => `style="${styleObjectToCss(body)}"`)
    .replace(/\bclassName=/g, 'class=')
    .replace(/<(\w+)((?:\s+[^<>]*?)?)\s*\/>/g, '<$1$2></$1>')
    .replace(/\{\s*["'`]([^"'`]*)["'`]\s*\}/g, '$1')
    .replace(/\\([~*_`[\]#>])/g, '$1')
}

function style(element: Element, property: string): string {
  return (element as HTMLElement).style?.getPropertyValue(property) ?? ''
}

function hasDrawing(element: Element): boolean {
  return Array.from(element.querySelectorAll('div')).some((child) => !(child.textContent ?? '').trim())
}

function isDashed(element: Element): boolean {
  return /dashed/.test(element.getAttribute('style') ?? '') ||
    Array.from(element.querySelectorAll('[style]')).some((child) => /dashed/.test(child.getAttribute('style') ?? ''))
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== 1) return ''
  const element = node as Element
  const inner = Array.from(element.childNodes).map(inlineMarkdown).join('')
  switch (element.tagName) {
    case 'A': {
      const href = element.getAttribute('href')
      return href ? `[${inner.trim()}](${href})` : inner
    }
    case 'STRONG':
    case 'B':
      return inner.trim() ? `**${inner.trim()}**` : ''
    case 'EM':
    case 'I':
      return inner.trim() ? `*${inner.trim()}*` : ''
    case 'CODE':
      return `\`${element.textContent ?? ''}\``
    case 'BR':
      return ' '
    default:
      return inner
  }
}

function isLeaf(element: Element): boolean {
  if (!(element.textContent ?? '').trim()) return false
  return Array.from(element.children).every((child) => INLINE.has(child.tagName))
}

/** Text-bearing elements under `root`, in document order. */
function leaves(root: Element): Leaf[] {
  const found: Leaf[] = []
  if (isLeaf(root)) {
    return [{ element: root, markdown: inlineMarkdown(root).trim(), text: (root.textContent ?? '').trim() }]
  }
  const visit = (element: Element) => {
    if (isLeaf(element)) {
      const markdown = inlineMarkdown(element).trim()
      found.push({ element, markdown, text: (element.textContent ?? '').trim() })
      return
    }
    for (const child of Array.from(element.children)) visit(child)
  }
  for (const child of Array.from(root.children)) visit(child)
  return found
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  const parts = long
    ? long.slice(1).map((part) => parseInt(part, 16))
    : short
      ? short.slice(1).map((part) => parseInt(part + part, 16))
      : null
  if (!parts) return null
  const [r, g, b] = parts.map((part) => part / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** The dominant accent of a box, read from its inline colours. */
function toneOf(element: Element): Tone {
  const source = [element, ...Array.from(element.querySelectorAll('[style]'))]
    .map((node) => node.getAttribute('style') ?? '')
    .join(' ')
  const colors = source.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) ?? []
  const counts: Record<Tone, number> = { green: 0, blue: 0, amber: 0, red: 0, neutral: 0 }
  for (const color of colors) {
    const hsl = hexToHsl(color)
    if (!hsl || hsl.s < 0.35 || hsl.l > 0.97 || hsl.l < 0.08) continue
    const { h } = hsl
    if (h >= 85 && h < 185) counts.green++
    else if (h >= 185 && h < 265) counts.blue++
    else if (h >= 20 && h < 65) counts.amber++
    else if (h < 15 || h >= 340) counts.red++
  }
  const best = (Object.entries(counts) as Array<[Tone, number]>)
    .filter(([tone]) => tone !== 'neutral')
    .sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0] : 'neutral'
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}=${JSON.stringify(value)}` : ''
}

/** Descend through wrappers that hold a single element and no text of their own. */
function unwrap(root: Element): Element {
  let current = root
  while (
    current.children.length === 1 &&
    !Array.from(current.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? '').trim())
  ) {
    current = current.children[0]
  }
  return current
}

function cells(root: Element): Element[] {
  return Array.from(root.children)
}

// --- Recognisers ------------------------------------------------------------

function formulaBlock(root: Element): string | null {
  const children = cells(root)
  const operators = children.filter((child) => OPERATOR.test((child.textContent ?? '').trim()))
  if (!operators.length || operators.length === children.length) return null
  const parts: string[] = []
  for (const child of children) {
    const text = (child.textContent ?? '').trim()
    if (!text) continue
    if (OPERATOR.test(text)) {
      parts.push(text)
      continue
    }
    const lines = leaves(child).map((leaf) => leaf.text.replace(/[|{}%]/g, ' ').trim())
    if (!lines.length) continue
    parts.push(lines.length > 1 ? `${lines[0]} | ${lines.slice(1).join(' · ')}` : lines[0])
  }
  const expression = parts.join(' ')
  return `{% formula %}${expression}{% endformula %}`
}

function stepsBlock(root: Element): string | null {
  const boxes = cells(root)
  if (boxes.length < 2) return null
  const steps: string[] = []
  for (const [index, box] of boxes.entries()) {
    const items = leaves(box)
    if (items.length < 2 || items[0].text !== String(index + 1)) return null
    const rest = items.slice(1)
    const title = rest.shift()!.text
    let note: string | undefined
    const last = rest.at(-1)
    if (rest.length >= 2 && last && last.element.parentElement !== box) {
      note = rest.pop()!.text
    }
    const body = rest.map((leaf) => leaf.markdown).join('\n\n')
    steps.push(`{% step${attr('title', title)}${attr('note', note)} %}\n${body}\n{% endstep %}`)
  }
  return `{% steps %}\n${steps.join('\n')}\n{% endsteps %}`
}

function timelineBlock(root: Element): string | null {
  const children = cells(root)
  const kinds = children.map((child) => {
    const count = leaves(child).length
    if (count >= 2) return 'box'
    if (count <= 1 && hasDrawing(child)) return 'connector'
    return 'other'
  })
  const boxes = kinds.filter((kind) => kind === 'box').length
  if (boxes < 2 || !kinds.includes('connector') || kinds.includes('other')) return null
  const phases: string[] = []
  children.forEach((child, index) => {
    if (kinds[index] !== 'box') return
    const items = leaves(child)
    const [label, title, ...body] = items.length >= 3 ? items : [undefined, ...items]
    const next = kinds[index + 1] === 'connector' ? leaves(children[index + 1])[0]?.text : undefined
    phases.push(
      `{% phase${attr('label', label?.text)}${attr('title', title?.text)}${attr('transition', next)} %}\n` +
        `${body.map((leaf) => leaf!.markdown).join('\n\n')}\n{% endphase %}`,
    )
  })
  return `{% timeline %}\n${phases.join('\n')}\n{% endtimeline %}`
}

function mermaidText(value: string): string {
  return value.replace(/"/g, '#quot;')
}

const TONE_CLASSES: Record<Tone, string> = {
  green: 'fill:#ecfdf5,stroke:#10b981,color:#065f46',
  blue: 'fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a',
  amber: 'fill:#fffbeb,stroke:#f59e0b,color:#92400e',
  red: 'fill:#fef2f2,stroke:#ef4444,color:#991b1b',
  neutral: 'fill:#f8fafc,stroke:#94a3b8,color:#334155',
}

function flowBlock(root: Element): string | null {
  const rows = cells(root)
  if (rows.length < 1) return null
  const isRow = (row: Element) => /flex/.test(style(row, 'display')) && row.children.length >= 3
  if (!rows.every(isRow) || !rows.some(hasDrawing)) return null

  type Cell = { kind: 'box' | 'arrow' | 'empty'; element: Element; id?: string }
  const grid: Cell[][] = rows.map((row) =>
    Array.from(row.children).map((element) => {
      const text = (element.textContent ?? '').trim()
      if (!text) return { kind: 'empty', element }
      return { kind: hasDrawing(element) ? 'arrow' : 'box', element }
    }),
  )
  if (!grid.some((row) => row.some((cell) => cell.kind === 'box'))) return null

  const lines = ['flowchart LR']
  const classes = new Map<Tone, string[]>()
  const dashed: string[] = []
  let count = 0
  for (const row of grid) {
    for (const cell of row) {
      if (cell.kind !== 'box') continue
      cell.id = `n${++count}`
      const label = leaves(cell.element).map((leaf) => mermaidText(leaf.text)).join('<br/>')
      lines.push(`  ${cell.id}["${label}"]`)
      const tone = toneOf(cell.element)
      classes.set(tone, [...(classes.get(tone) ?? []), cell.id])
      if (/dashed/.test(cell.element.getAttribute('style') ?? '')) dashed.push(cell.id)
    }
  }
  const edgeLabel = (cell: Cell) =>
    leaves(cell.element).map((leaf) => mermaidText(leaf.text)).join('<br/>')
  const edge = (from: string, to: string, cell: Cell) => {
    const label = edgeLabel(cell)
    const arrow = isDashed(cell.element) ? '-.->' : '-->'
    lines.push(`  ${from} ${arrow}${label ? `|"${label}"|` : ''} ${to}`)
  }

  grid.forEach((row, r) => {
    if (row.some((cell) => cell.kind === 'box')) {
      // Horizontal: box → arrow → box, left to right.
      row.forEach((cell, c) => {
        if (cell.kind !== 'arrow') return
        const before = row.slice(0, c).reverse().find((item) => item.kind === 'box')
        const after = row.slice(c + 1).find((item) => item.kind === 'box')
        if (before?.id && after?.id) edge(before.id, after.id, cell)
      })
      return
    }
    // A connector row: each arrow joins the boxes above and below in its column.
    row.forEach((cell, c) => {
      if (cell.kind !== 'arrow') return
      const above = grid.slice(0, r).reverse().map((line) => line[c]).find((item) => item?.kind === 'box')
      const below = grid.slice(r + 1).map((line) => line[c]).find((item) => item?.kind === 'box')
      if (above?.id && below?.id) edge(above.id, below.id, cell)
    })
  })

  for (const [tone, ids] of classes) {
    lines.push(`  classDef ${tone} ${TONE_CLASSES[tone]}`)
    lines.push(`  class ${ids.join(',')} ${tone}`)
  }
  if (dashed.length) {
    lines.push('  classDef placeholder stroke-dasharray:4 3')
    lines.push(`  class ${dashed.join(',')} placeholder`)
  }
  return ['```mermaid', ...lines, '```'].join('\n')
}

function cardsBlock(root: Element): string | null {
  const boxes = cells(root)
  if (boxes.length < 2) return null
  const cards: string[] = []
  for (const box of boxes) {
    const items = leaves(box)
    if (items.length < 2) return null
    const [eyebrow, title, ...body] = items.length >= 3 ? items : [undefined, ...items]
    const tone = toneOf(box)
    cards.push(
      `{% card${attr('title', title!.text)}${attr('eyebrow', eyebrow?.text)}${attr('tone', tone === 'neutral' ? undefined : tone)} %}\n` +
        `${body.map((leaf) => leaf!.markdown).join('\n\n')}\n{% endcard %}`,
    )
  }
  return `{% cards %}\n${cards.join('\n')}\n{% endcards %}`
}

function paragraphs(root: Element): string {
  return leaves(root)
    .map((leaf) => leaf.markdown)
    .filter(Boolean)
    .join('\n\n')
}

/** Convert one top-level JSX layout to Markdown. */
export function layoutToMarkdown(jsx: string): string {
  const { document } = new JSDOM(`<body>${jsxToHtml(jsx)}</body>`).window
  const outer = document.body.firstElementChild
  if (!outer) return ''
  const root = unwrap(outer)
  for (const recognise of [formulaBlock, stepsBlock, timelineBlock, flowBlock, cardsBlock]) {
    const result = recognise(root)
    if (result) return result
  }
  return paragraphs(root)
}

/**
 * Replace every top-level `<div …>…</div>` layout (and `<style>` blocks, which
 * only theme those layouts) in a prose segment.
 */
export function convertLayoutBlocks(source: string): string {
  const withoutStyles = source.replace(/^<style>\s*\{\s*`[\s\S]*?`\s*\}\s*<\/style>[ \t]*$/gm, '')
  const lines = withoutStyles.split('\n')
  const output: string[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!/^<div\b/.test(lines[index])) {
      output.push(lines[index])
      continue
    }
    let depth = 0
    let end = -1
    for (let cursor = index; cursor < lines.length; cursor++) {
      for (const tag of lines[cursor].matchAll(/<div\b(?:[^>"]|"[^"]*")*>|<\/div>/g)) {
        if (tag[0] === '</div>') depth--
        else if (!tag[0].endsWith('/>')) depth++
      }
      if (depth <= 0) {
        end = cursor
        break
      }
    }
    const block = lines.slice(index, end + 1).join('\n')
    // Only JSX layouts are rewritten; plain HTML (`class="…"`) is left as written.
    if (end === -1 || !/\bclassName=|\bstyle=\{\{/.test(block)) {
      output.push(lines[index])
      continue
    }
    output.push('', layoutToMarkdown(block), '')
    index = end
  }
  return output.join('\n')
}

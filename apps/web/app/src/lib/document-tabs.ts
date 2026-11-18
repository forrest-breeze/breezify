// Documentation block directives: tab groups and card groups. Both are stored
// as portable GitBook-style Markdown directives (never executable MDX) and
// rendered to plain, readable HTML that works without JavaScript.
//
//   {% tabs %}                      {% cards %}
//   {% tab title="One" %}           {% card title="One" href="/docs/one" icon="🚀" %}
//   Markdown…                       Markdown…
//   {% endtab %}                    {% endcard %}
//   {% endtabs %}                   {% endcards %}
//
// Cards also take `eyebrow="Balance #1"` and `tone="green|blue|amber|red|neutral"`.
//
//   {% steps %}                     {% timeline %}
//   {% step title="One" note="…" %} {% phase label="Week 1–2" title="…" transition="…" %}
//   Markdown…                       Markdown…
//   {% endstep %}                   {% endphase %}
//   {% endsteps %}                  {% endtimeline %}
//
//   {% formula %}Avg daily payouts | 21-day average × 3 | days = Minimum Balance{% endformula %}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Card links accept the same schemes the HTML sanitizer keeps. */
export function isSafeCardHref(value: string): boolean {
  const href = value.trim()
  return href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//")) || /^(https?:|mailto:|tel:)/i.test(href)
}

/** A card icon is a short emoji or symbol, never a word or markup. */
export function cardIcon(value: string | null | undefined): string | null {
  const icon = (value ?? "").trim()
  if (!icon || icon.length > 16 || /[A-Za-z0-9<>&"']/.test(icon)) return null
  return icon
}

/** Directive (or MDX equivalent) source text that needs rendering before the editor sees it. */
export const DIRECTIVE_SOURCE = /{%\s*(?:tabs|cards|steps|timeline|formula)\s*%}|<(?:Tabs|CardGroup|Cards)[\s>]/

/** Rendered HTML that contains at least one directive block. */
export const RENDERED_DIRECTIVE = /data-document-(?:tabs|cards|steps|timeline|formula)=/

export const CARD_TONES = ["green", "blue", "amber", "red", "neutral"] as const
export type CardTone = (typeof CARD_TONES)[number]

/** A card tone is one of a fixed palette; anything else falls back to the accent. */
export function cardTone(value: string | null | undefined): CardTone | null {
  const tone = (value ?? "").trim().toLowerCase()
  return (CARD_TONES as readonly string[]).includes(tone) ? (tone as CardTone) : null
}

// ── Formula ─────────────────────────────────────────────────────────

export type FormulaPart =
  | { kind: "term"; label: string; caption: string; result: boolean }
  | { kind: "op"; symbol: string }

const FORMULA_OPERATOR = /\s+([×x*+−\-÷/=])\s+/

/**
 * Split `A | caption × B = C` into terms and operators. `|` separates a term
 * from its caption; the term after `=` is the result.
 */
export function parseFormula(expression: string): FormulaPart[] {
  const parts: FormulaPart[] = []
  const tokens = expression.trim().split(FORMULA_OPERATOR)
  let afterEquals = false
  tokens.forEach((token, index) => {
    if (index % 2 === 1) {
      const symbol = token === "x" || token === "*" ? "×" : token === "-" ? "−" : token === "/" ? "÷" : token
      if (symbol === "=") afterEquals = true
      parts.push({ kind: "op", symbol })
      return
    }
    const [label, ...caption] = token.split("|")
    if (!label.trim() && !caption.join("|").trim()) return
    parts.push({ kind: "term", label: label.trim(), caption: caption.join("|").trim(), result: afterEquals })
  })
  return parts
}

export function renderFormulaHtml(expression: string): string {
  const parts = parseFormula(expression)
    .map((part) =>
      part.kind === "op"
        ? `<span data-formula-op="">${escape(part.symbol)}</span>`
        : `<span data-formula-term=""${part.result ? ' data-formula-result=""' : ""}><strong>${escape(part.label)}</strong>${part.caption ? `<small>${escape(part.caption)}</small>` : ""}</span>`,
    )
    .join("")
  return `<div data-document-formula="${escape(expression.trim())}">${parts}</div>`
}

const ATTRIBUTE = /(\w+)=("(?:\\.|[^"\\])*"|'[^']*')/g

function parseAttributes(source: string): Record<string, string> | null {
  const attributes: Record<string, string> = {}
  const rest = source.replace(ATTRIBUTE, (_match, name: string, raw: string) => {
    try { attributes[name] = raw[0] === '"' ? JSON.parse(raw) : raw.slice(1, -1) } catch { attributes[name] = "\u0000" }
    return ""
  })
  if (rest.trim() || Object.values(attributes).includes("\u0000")) return null
  return attributes
}

function mdxAttributes(source: string): string {
  const parts: string[] = []
  source.replace(/(\w+)=("[^"]*"|'[^']*')/g, (_match, name: string, raw: string) => {
    if (name === "title" || name === "label") parts.push(`title=${JSON.stringify(raw.slice(1, -1))}`)
    else if (name === "href") parts.push(`href=${JSON.stringify(raw.slice(1, -1))}`)
    // MDX icons are usually icon-library names ("rocket"); only emoji/symbols carry over.
    else if (name === "icon" && cardIcon(raw.slice(1, -1))) parts.push(`icon=${JSON.stringify(raw.slice(1, -1))}`)
    return ""
  })
  return parts.join(" ")
}

/** Convert MDX tab and card components to Markdown directives, outside code fences. */
export function normalizeDocumentTabs(source: string): string {
  let fence = ""
  return source.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""
      return line
    }
    if (fence) return line
    return line
      .replace(/^\s*<Tabs(?:\s[^>]*)?>\s*$/, "{% tabs %}")
      .replace(/^\s*<\/Tabs>\s*$/, "{% endtabs %}")
      .replace(/^\s*<Tab\s+(?:title|label)=("[^"]*"|'[^']*')\s*>\s*$/, (_match, title: string) => `{% tab title=${JSON.stringify(title.slice(1, -1))} %}`)
      .replace(/^\s*<\/Tab>\s*$/, "{% endtab %}")
      .replace(/^\s*<(?:CardGroup|Cards)(?:\s[^>]*)?>\s*$/, "{% cards %}")
      .replace(/^\s*<\/(?:CardGroup|Cards)>\s*$/, "{% endcards %}")
      .replace(/^\s*<Card(\s[^>]*?)\/>\s*$/, (_match, attrs: string) => `{% card ${mdxAttributes(attrs)} %}\n{% endcard %}`)
      .replace(/^\s*<Card(\s[^>]*)?>\s*$/, (_match, attrs = "") => `{% card ${mdxAttributes(attrs)} %}`)
      .replace(/^\s*<\/Card>\s*$/, "{% endcard %}")
  }).join("\n")
}

type Directive = {
  group: string
  item: string
  wrap: (items: string) => string
  renderItem: (attributes: Record<string, string>, body: string) => string | null
}

const DIRECTIVES: Directive[] = [
  {
    group: "tabs",
    item: "tab",
    wrap: (items) => `<div data-document-tabs="">${items}</div>`,
    renderItem: ({ title }, body) => title === undefined ? null
      : `<section data-document-tab="${escape(title)}"><div data-tab-label="">${escape(title)}</div>${body}</section>`,
  },
  {
    group: "cards",
    item: "card",
    wrap: (items) => `<div data-document-cards="">${items}</div>`,
    renderItem: ({ title, href, icon, eyebrow, tone }, body) => {
      if (title === undefined) return null
      const link = href && isSafeCardHref(href) ? href.trim() : ""
      const glyph = cardIcon(icon)
      const toneName = cardTone(tone)
      const label = (eyebrow ?? "").trim()
      const heading = link ? `<a href="${escape(link)}">${escape(title)}</a>` : escape(title)
      const hrefAttribute = link ? ` data-card-href="${escape(link)}"` : ""
      const iconAttribute = glyph ? ` data-card-icon="${escape(glyph)}"` : ""
      const iconElement = glyph ? `<span data-card-glyph="" aria-hidden="true">${escape(glyph)}</span>` : ""
      const toneAttribute = toneName ? ` data-card-tone="${toneName}"` : ""
      const eyebrowAttribute = label ? ` data-card-eyebrow="${escape(label)}"` : ""
      const eyebrowElement = label ? `<p data-card-eyebrow-text="">${escape(label)}</p>` : ""
      return `<section data-document-card="${escape(title)}"${hrefAttribute}${iconAttribute}${toneAttribute}${eyebrowAttribute}>${iconElement}${eyebrowElement}<p data-card-title="">${heading}</p><div data-card-body="">${body}</div></section>`
    },
  },
  {
    group: "steps",
    item: "step",
    wrap: (items) => `<div data-document-steps="">${items}</div>`,
    renderItem: ({ title, note }, body) => {
      if (title === undefined) return null
      const text = (note ?? "").trim()
      const noteAttribute = text ? ` data-step-note="${escape(text)}"` : ""
      const noteElement = text ? `<p data-step-note-text="">${escape(text)}</p>` : ""
      return `<section data-document-step="${escape(title)}"${noteAttribute}><p data-step-title="">${escape(title)}</p><div data-step-body="">${body}</div>${noteElement}</section>`
    },
  },
  {
    group: "timeline",
    item: "phase",
    wrap: (items) => `<div data-document-timeline="">${items}</div>`,
    renderItem: ({ title, label, transition }, body) => {
      if (title === undefined) return null
      const tag = (label ?? "").trim()
      const next = (transition ?? "").trim()
      const labelAttribute = tag ? ` data-phase-label="${escape(tag)}"` : ""
      const transitionAttribute = next ? ` data-phase-transition="${escape(next)}"` : ""
      const labelElement = tag ? `<p data-phase-label-text="">${escape(tag)}</p>` : ""
      const transitionElement = next ? `<p data-phase-transition-text="">${escape(next)}</p>` : ""
      return `<section data-document-phase="${escape(title)}"${labelAttribute}${transitionAttribute}>${labelElement}<p data-phase-title="">${escape(title)}</p><div data-phase-body="">${body}</div>${transitionElement}</section>`
    },
  },
]

const FORMULA_INLINE = /^\s*{%\s*formula\s*%}(.*?){%\s*endformula\s*%}\s*$/
const FORMULA_OPEN = /^\s*{%\s*formula\s*%}\s*$/
const FORMULA_CLOSE = /^\s*{%\s*endformula\s*%}\s*$/

/** A formula on one line, or split across lines (pasted/repaired content). */
function formulaAt(lines: string[], start: number): { html: string; end: number } | null {
  const inline = FORMULA_INLINE.exec(lines[start])
  if (inline) return inline[1].trim() ? { html: renderFormulaHtml(inline[1]), end: start } : null
  if (!FORMULA_OPEN.test(lines[start])) return null
  const body: string[] = []
  for (let cursor = start + 1; cursor < lines.length && cursor < start + 20; cursor++) {
    if (FORMULA_CLOSE.test(lines[cursor])) {
      const expression = body.join(" ").trim()
      return expression ? { html: renderFormulaHtml(expression), end: cursor } : null
    }
    body.push(lines[cursor])
  }
  return null
}

const line = (pattern: string) => new RegExp(`^\\s*{%\\s*${pattern}\\s*%}\\s*$`)
const opener = (directive: Directive) => line(directive.group)

/** Render only balanced groups; malformed directives remain readable Markdown. */
export function renderDocumentTabs(source: string, render: (markdown: string) => string): string {
  const lines = normalizeDocumentTabs(source).split("\n")
  const openerFor = (text: string) => DIRECTIVES.find((directive) => opener(directive).test(text))

  function group(directive: Directive, start: number): { html: string; end: number } | null {
    const close = line(`end${directive.group}`)
    const itemOpen = new RegExp(`^\\s*{%\\s*${directive.item}\\s+(.*?)\\s*%}\\s*$`)
    const itemClose = line(`end${directive.item}`)
    const items: string[] = []
    let cursor = start + 1
    while (cursor < lines.length) {
      if (!lines[cursor].trim()) { cursor++; continue }
      if (close.test(lines[cursor])) {
        return items.length ? { html: directive.wrap(items.join("")), end: cursor } : null
      }
      const match = itemOpen.exec(lines[cursor])
      const attributes = match ? parseAttributes(match[1]) : null
      if (!attributes) return null
      const body: string[] = []
      let fence = ""
      let closed = false
      while (++cursor < lines.length) {
        const text = lines[cursor]
        const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1]
        if (marker) {
          if (!fence) fence = marker
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""
        }
        if (!fence && !marker && itemClose.test(text)) { closed = true; break }
        const nestedDirective = !fence && !marker ? openerFor(text) : undefined
        if (nestedDirective) {
          const nested = group(nestedDirective, cursor)
          if (!nested) return null
          body.push(...lines.slice(cursor, nested.end + 1))
          cursor = nested.end
        } else body.push(text)
      }
      if (!closed) return null
      const html = directive.renderItem(attributes, renderDocumentTabs(body.join("\n"), render))
      if (html === null) return null
      items.push(html)
      cursor++
    }
    return null
  }

  const output: string[] = []
  let pending: string[] = []
  let fence = ""
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""
    }
    const formula = !fence && !marker ? formulaAt(lines, i) : null
    if (formula) {
      output.push(render(pending.join("\n")), formula.html)
      pending = []
      i = formula.end
      continue
    }
    const directive = !fence && !marker ? openerFor(lines[i]) : undefined
    if (directive) {
      const result = group(directive, i)
      if (result) {
        output.push(render(pending.join("\n")), result.html)
        pending = []
        i = result.end
        continue
      }
    }
    pending.push(lines[i])
  }
  output.push(render(pending.join("\n")))
  return output.join("\n")
}

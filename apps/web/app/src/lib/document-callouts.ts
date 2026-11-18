// ReadMe-style callouts: a blockquote whose first line starts with a known
// emoji (`> 🚧 Title` / `> 👍 ### Title`) is rendered as a toned callout box
// instead of a plain italic quote. Stored content stays portable Markdown; this
// only decorates the parsed tree before sanitization (data-* attributes survive
// sanitize-dom.ts).

export type CalloutTone = "info" | "success" | "warn" | "danger"

const TONES: Array<[string, CalloutTone]> = [
  ["📘", "info"],
  ["ℹ️", "info"],
  ["💡", "info"],
  ["👍", "success"],
  ["✅", "success"],
  ["🚧", "warn"],
  ["⚠️", "warn"],
  ["❗️", "danger"],
  ["❗", "danger"],
  ["🛑", "danger"],
]

/** Match a leading callout emoji (optionally with a variation selector). */
export function calloutToneOf(text: string): { tone: CalloutTone; icon: string; rest: string } | null {
  const trimmed = text.replace(/^\s+/, "")
  for (const [icon, tone] of TONES) {
    if (trimmed.startsWith(icon)) {
      const rest = trimmed.slice(icon.length).replace(/^️/, "")
      return { tone, icon, rest }
    }
  }
  return null
}

/** Strip the emoji and an optional `###` heading marker from the first text node. */
function stripLead(element: Element, icon: string): void {
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */)
  let node = walker.nextNode()
  while (node && !(node.textContent ?? "").trim()) node = walker.nextNode()
  if (!node) return
  const text = node.textContent ?? ""
  const index = text.indexOf(icon)
  if (index === -1) return
  node.textContent = text
    .slice(index + icon.length)
    .replace(/^️/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s+/, "")
}

/**
 * Decorate emoji-led blockquotes under `root` as callouts, in place. The first
 * paragraph becomes the title when it is followed by more content; a one-
 * paragraph callout keeps its text as the body.
 */
export function enhanceCallouts(root: Element): void {
  for (const quote of Array.from(root.querySelectorAll("blockquote"))) {
    if (quote.hasAttribute("data-callout")) continue
    const first = quote.firstElementChild
    if (!first || first.tagName !== "P") continue
    const match = calloutToneOf(first.textContent ?? "")
    if (!match) continue

    stripLead(first, match.icon)
    // `breaks: true` turns "title\nbody" into one <p> with a <br>: split it.
    const br = first.querySelector(":scope > br")
    if (br && first.childNodes.length > 1) {
      const body = quote.ownerDocument.createElement("p")
      while (br.nextSibling) body.append(br.nextSibling)
      br.remove()
      const lead = body.firstChild
      if (lead?.nodeType === 3) lead.textContent = (lead.textContent ?? "").replace(/^\s+/, "")
      const tail = first.lastChild
      if (tail?.nodeType === 3) tail.textContent = (tail.textContent ?? "").replace(/\s+$/, "")
      if ((body.textContent ?? "").trim()) first.after(body)
    }

    quote.setAttribute("data-callout", match.tone)
    quote.setAttribute("data-callout-icon", match.icon)
    if (first.nextElementSibling) first.setAttribute("data-callout-title", "")
    if (!(first.textContent ?? "").trim() && !first.querySelector("img")) first.remove()
  }
}
